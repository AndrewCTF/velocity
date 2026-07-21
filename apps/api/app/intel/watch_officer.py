"""Watch-officer agent — standing loop that turns fusion output into briefs.

The operator senses far more than they can manually correlate. The cross-domain
fusion (``incidents.brief``) already narrates + cites converged incidents; this
loop watches its diff and, when a NEW or ESCALATED incident crosses into
high/elevated, lets the real tool-calling agent (``intel.agent.run_agent``)
actually reason about it — read-only, capped, seeded with THIS cycle's brief so
it never re-fuses — and files a finished draft brief for the operator to triage
(ack / dismiss) in the Inbox. The one hardwired response (dark-vessel → SAR
tip-and-cue via ``cue.run``) still runs alongside it; both are per-cycle budgeted
so a busy sweep degrades to "dropped + logged", never a firehose.

In-memory + single-process (like ``routes.actions._PROPOSALS``): a restart drops
open briefs, which is fine — the loop re-derives them on its next cycle. Lifecycle
mirrors ``intel.watch`` (module ``_TASK``/``_STARTED`` + ``start``/``stop``),
started from the app lifespan. A second background task, ``_supervise``, watches
the sweep loop's own liveness the way ``adsb_sidecar.supervise()`` watches the
tar1090 sidecar: a wedged ``await`` inside ``run_once`` (an upstream that never
returns) would otherwise freeze the loop forever while ``status()`` keeps
reporting healthy.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

from app.config import get_settings
from app.intel import agent, cue, incidents, promotion
from app.intel.incident_store import incident_key, incident_store
from app.intel.ontology import get_registry
from app.keys import UserCtx

log = logging.getLogger("app.watch_officer")

_SCOPE = "watch-officer"
_CYCLE_S = 120.0
_MAX_BRIEFS = 100
_ACTIONABLE = {"high", "elevated"}

# Per-cycle outbound budgets (same shape as promotion.py's
# MAX_INCIDENT_MINTS_PER_CYCLE): the agent run reaches a real LLM + tool
# fan-out and the SAR cue reaches a real upstream (sar_vessels/CDSE), so both
# get a hard per-sweep cap rather than firing once per actionable incident
# unbounded. Hardcoded — no config.py setting for this slice (same reasoning
# as promotion.py's own comment).
_MAX_AGENT_RUNS_PER_CYCLE = 5
_MAX_CUES_PER_CYCLE = 5

# How long a single incidents.brief() await may run before this sweep gives up
# and tries again next cycle — well under _CYCLE_S so a wedged upstream can't
# starve the loop of its own sweep budget.
_SWEEP_TIMEOUT_S = 45.0
# Hard ceiling on the per-incident agent response, on top of run_agent's own
# wall_budget_s check (which only fires between gather-loop steps) — a single
# step's LLM call with no timeout of its own would otherwise wedge the sweep.
_AGENT_WATCHDOG_MARGIN_S = 30.0
# If no successful sweep lands within this many cycles, the loop is presumed
# wedged (a hung await neither the sweep timeout nor run_agent's own budget
# caught) and _supervise restarts the task.
_STALL_CYCLES = 3

# Human-readable roster of the automated responses the loop can run, surfaced in
# the UI so the operator can see what the officer will DO on a hit — not just
# that it files a brief. Keep in sync with ``_playbook``.
PLAYBOOKS: tuple[dict[str, str], ...] = (
    {
        "id": "agent-response",
        "trigger": "high/elevated incident",
        "action": "run the read-only tool-calling agent to investigate + assess (capped/cycle)",
    },
    {
        "id": "dark-vessel-sar",
        "trigger": "dark-vessel convergence",
        "action": "task SAR imagery at the centroid (tip-and-cue, capped/cycle)",
    },
    {
        "id": "promote-incident",
        "trigger": "high/elevated incident",
        "action": "mint a tracked incident object in the ontology",
    },
)

# Live telemetry so the surface can show the officer is actually running, not a
# dead panel. Updated every sweep by ``run_once``; read by ``status()``.
_SWEEPS = 0
_TOTAL_FILED = 0
_LAST_SWEEP_AT: float | None = None
_LAST_FILED_AT: float | None = None
_LOOP_STARTED_AT: float | None = None

# Same shared local identity Foundry's build-runner / workflow scheduler
# default to (keys.py:172's keyless fallback) — this loop runs headless, with
# no request/caller ctx. See docs/ontology-autopopulation-plan.md §2. Used for
# the deterministic ontology writes (promotion, fired-marker) below; the
# autonomous agent run below deliberately does NOT use this ctx (see its
# call site) — a truthy ctx would hand it write-back authority.
_LOCAL_CTX = UserCtx(user_id="local", token="")

# key (incident_key) -> brief record. Keyed by incident_key so the same
# convergence is one brief across cycles (dedup); an operator dismiss removes the
# key so it does not immediately re-file (it re-files only if it later escalates,
# which the diff surfaces as a fresh "escalated").
_BRIEFS: dict[str, dict[str, Any]] = {}


def _title(inc: dict[str, Any]) -> str:
    doms = ", ".join(inc.get("domains") or []) or "activity"
    c = inc.get("centroid") or {}
    return f"{inc.get('threat_level', '?').upper()} · {doms} @ {c.get('lat')},{c.get('lon')}"


async def _playbook(inc: dict[str, Any]) -> dict[str, Any]:
    """Run the deterministic tip-and-cue response; return what was done.

    ONE hardwired playbook: dark-vessel convergence tasks SAR at the centroid via
    tip-and-cue. Everything else is now the live agent's job (``_run_agent_response``
    below) rather than another hardcoded branch here.
    """
    out: dict[str, Any] = {}
    domains = set(inc.get("domains") or [])
    c = inc.get("centroid") or {}
    lon, lat = c.get("lon"), c.get("lat")
    if "dark-vessel" in domains and lon is not None and lat is not None:
        try:
            res = await cue.run(float(lon), float(lat))
            out["sar"] = res.get("status")
            if res.get("aoi"):
                out["sar_aoi"] = res["aoi"]
        except Exception as exc:  # noqa: BLE001 — a playbook failure must not sink the brief
            out["sar"] = f"error: {exc}"
    return out


def _wants_cue(inc: dict[str, Any]) -> bool:
    """Would ``_playbook`` actually reach the SAR upstream for this incident?
    Checked BEFORE calling it so the per-cycle cue budget only counts real
    attempts, not incidents ``_playbook`` would have no-op'd on anyway."""
    c = inc.get("centroid") or {}
    return (
        "dark-vessel" in (inc.get("domains") or [])
        and c.get("lon") is not None
        and c.get("lat") is not None
    )


async def _run_agent_response(inc: dict[str, Any], br: dict[str, Any]) -> dict[str, Any] | None:
    """Let the real tool-calling agent think about ONE actionable incident.

    Seeded with THIS cycle's already-fused brief (``seed_brief=br``) so it never
    re-fuses. ``ctx=None`` (NOT ``_LOCAL_CTX``) is deliberate: ``_LOCAL_CTX`` is a
    truthy ``UserCtx`` and ``run_agent`` gates its AUDITED write-back tools on
    ``ctx is not None`` — passing it here would hand this autonomous, unattended
    run flag_entity/promote_incident/nominate_target/add_watch by accident.
    # ponytail: write-back authority for the autonomous watch-officer tier is a
    # deliberate follow-up, not an oversight — this stage is read-only-tools only.
    ``interactive=False`` additionally drops ``request_clarification`` (a dead
    end with no operator to answer it). Capped to half the sweep cycle so one
    incident's reasoning can never eat the whole cadence.
    """
    q = (
        f"Investigate and assess: {_title(inc)}. "
        f"{(inc.get('narrative') or '').strip()}"
    ).strip()

    async def _drain() -> dict[str, Any] | None:
        final: dict[str, Any] | None = None
        async for ev in agent.run_agent(
            q,
            None,
            ctx=None,
            max_steps=3,
            wall_budget_s=_CYCLE_S / 2,
            seed_brief=br,
            interactive=False,
        ):
            if ev.get("type") == "final":
                final = ev
        return final

    try:
        return await asyncio.wait_for(_drain(), timeout=_CYCLE_S / 2 + _AGENT_WATCHDOG_MARGIN_S)
    except TimeoutError:
        log.warning("watch_officer: agent response timed out for %s", inc.get("id"))
        return None
    except Exception as exc:  # noqa: BLE001 — an agent failure must not sink the brief
        log.warning("watch_officer: agent response failed for %s: %s", inc.get("id"), exc)
        return None


def _make_brief(
    key: str, inc: dict[str, Any], playbook: dict[str, Any], agent_result: dict[str, Any] | None
) -> dict[str, Any]:
    rec = {
        "id": uuid.uuid4().hex[:12],
        "key": key,
        "created": time.time(),
        "threat_level": inc.get("threat_level"),
        "domains": inc.get("domains") or [],
        "centroid": inc.get("centroid") or {},
        "title": _title(inc),
        "narrative": inc.get("narrative"),
        "evidence": inc.get("evidence") or [],
        "follow_up": inc.get("follow_up") or [],
        "playbook": playbook,
        "status": "open",
    }
    if agent_result is not None:
        rec["agent_assessment"] = agent_result.get("assessment")
        rec["agent_findings"] = agent_result.get("findings")
        rec["agent_follow_up"] = agent_result.get("follow_up")
    return rec


def _evict_if_full() -> None:
    while len(_BRIEFS) > _MAX_BRIEFS:
        oldest = min(_BRIEFS.values(), key=lambda b: b["created"])
        _BRIEFS.pop(oldest["key"], None)


async def run_once() -> int:
    """One sweep: fuse → diff → let the agent think + file briefs for new/
    escalated high incidents.

    Returns the number of briefs filed this sweep.
    """
    try:
        br = await asyncio.wait_for(incidents.brief(), timeout=_SWEEP_TIMEOUT_S)
    except TimeoutError:
        log.warning("watch_officer: incidents.brief() timed out after %.0fs", _SWEEP_TIMEOUT_S)
        return 0
    except Exception as exc:  # noqa: BLE001 — a fusion hiccup must not kill the loop
        log.debug("watch_officer: brief failed: %s", exc)
        return 0

    global _SWEEPS, _TOTAL_FILED, _LAST_SWEEP_AT, _LAST_FILED_AT
    _SWEEPS += 1
    _LAST_SWEEP_AT = time.time()

    incs = br.get("incidents") or []
    by_key = {incident_key(i): i for i in incs}
    diff = incident_store.record(_SCOPE, incs)

    actionable = [i for i in incs if i.get("threat_level") in _ACTIONABLE]
    reg = None
    try:
        reg = get_registry(_LOCAL_CTX, get_settings())
        minted = await promotion.promote_incidents(
            reg, actionable, source="agent:watch_officer"
        )
        if minted:
            log.debug("watch_officer: promoted %d incident object(s)", len(minted))
    except Exception as exc:  # noqa: BLE001 — a promotion bug must not sink the loop
        log.debug("watch_officer: promotion failed: %s", exc)
        reg = None

    filed = 0
    agent_runs = 0
    cues = 0
    for summary in [*diff.get("new", []), *diff.get("escalated", [])]:
        key = summary.get("key")
        if not key or key in _BRIEFS:
            continue
        if summary.get("threat_level") not in _ACTIONABLE:
            continue
        # PRECONDITION (stale-facts guard): only act on an incident whose key is
        # STILL present in THIS sweep's freshly-fused snapshot — a centroid the
        # area tools derived from a fix that has since aged out must never task
        # an outbound action. Deterministic, zero tokens: `inc is None` means the
        # diff's summary no longer matches anything this sweep actually observed.
        inc = by_key.get(key)
        if inc is None:
            continue

        incident_id = promotion._stable_incident_id(inc) if reg is not None else None
        already_fired = False
        if reg is not None and incident_id is not None:
            try:
                obj = await reg.get(incident_id)
                already_fired = bool(obj and obj.props.get("agent_fired"))
            except Exception as exc:  # noqa: BLE001 — a read hiccup must not sink the brief
                log.debug("watch_officer: fired-marker read failed for %s: %s", key, exc)

        agent_result: dict[str, Any] | None = None
        playbook: dict[str, Any] = {}
        # Only mark the incident fired if an action ACTUALLY ran this sweep. A
        # per-cycle cap that dropped both the agent run and the cue must leave the
        # marker unwritten so the incident retries next cycle instead of being
        # suppressed forever.
        did_act = False
        if not already_fired:
            if agent_runs < _MAX_AGENT_RUNS_PER_CYCLE:
                agent_runs += 1
                agent_result = await _run_agent_response(inc, br)
                did_act = True
            else:
                log.info(
                    "watch_officer: per-cycle agent-run cap (%d) hit, dropping %s",
                    _MAX_AGENT_RUNS_PER_CYCLE, key,
                )

            wants_cue = _wants_cue(inc)
            if wants_cue and cues >= _MAX_CUES_PER_CYCLE:
                log.info(
                    "watch_officer: per-cycle cue cap (%d) hit, dropping %s",
                    _MAX_CUES_PER_CYCLE, key,
                )
            else:
                playbook = await _playbook(inc)
                if wants_cue:
                    cues += 1
                    did_act = True

            if did_act and reg is not None and incident_id is not None:
                try:
                    await reg.assert_props(
                        incident_id,
                        {"agent_fired": True, "agent_fired_at": time.time()},
                        source="agent:watch_officer",
                    )
                except Exception as exc:  # noqa: BLE001 — marker write is best-effort
                    log.debug("watch_officer: fired-marker write failed for %s: %s", key, exc)

        _BRIEFS[key] = _make_brief(key, inc, playbook, agent_result)
        filed += 1

    _evict_if_full()
    if filed:
        _TOTAL_FILED += filed
        _LAST_FILED_AT = time.time()
        log.info("watch_officer: filed %d brief(s); %d open", filed, len(_BRIEFS))
    return filed


def list_briefs() -> list[dict[str, Any]]:
    """Open briefs, newest first."""
    return sorted(_BRIEFS.values(), key=lambda b: b["created"], reverse=True)


def get_brief(bid: str) -> dict[str, Any] | None:
    """One open brief by its id, or None if unknown/expired."""
    for b in _BRIEFS.values():
        if b["id"] == bid:
            return b
    return None


def status() -> dict[str, Any]:
    """Live telemetry for the surface: is the loop running, its cadence, how many
    sweeps/briefs it has produced, and the roster of playbooks it can fire."""
    by_level: dict[str, int] = {}
    for b in _BRIEFS.values():
        lvl = str(b.get("threat_level") or "?")
        by_level[lvl] = by_level.get(lvl, 0) + 1
    return {
        "running": _STARTED,
        "cycle_s": _CYCLE_S,
        "sweeps": _SWEEPS,
        "open": len(_BRIEFS),
        "by_level": by_level,
        "total_filed": _TOTAL_FILED,
        "last_sweep_at": _LAST_SWEEP_AT,
        "last_filed_at": _LAST_FILED_AT,
        "playbooks": list(PLAYBOOKS),
    }


def _drop(bid: str) -> bool:
    for key, b in list(_BRIEFS.items()):
        if b["id"] == bid:
            _BRIEFS.pop(key, None)
            return True
    return False


def dismiss(bid: str) -> bool:
    """Operator dropped a brief as noise. Returns False if unknown."""
    return _drop(bid)


def ack(bid: str) -> bool:
    """Operator acknowledged a brief (saw the finding). Same clear as dismiss for the
    MVP — both remove it from the open set. Returns False if unknown."""
    return _drop(bid)


def reset_state() -> None:
    global _SWEEPS, _TOTAL_FILED, _LAST_SWEEP_AT, _LAST_FILED_AT
    _BRIEFS.clear()
    _SWEEPS = 0
    _TOTAL_FILED = 0
    _LAST_SWEEP_AT = None
    _LAST_FILED_AT = None


# ── background task lifecycle (mirrors intel.watch.start / stop) ─────────────────

_TASK: asyncio.Task[None] | None = None
_SUPERVISE_TASK: asyncio.Task[None] | None = None
_STARTED = False


async def _run_forever() -> None:
    while True:
        try:
            await run_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            log.debug("watch_officer: sweep error: %s", exc)
        await asyncio.sleep(_CYCLE_S)


async def _supervise(interval_s: float | None = None) -> None:
    """Restart the sweep task if it has gone quiet.

    ``run_once`` bounds its own awaits (``_SWEEP_TIMEOUT_S`` around ``brief()``,
    a wrapped timeout around the per-incident agent run), so this is defense in
    depth for a hang neither of those catches: if ``_LAST_SWEEP_AT`` (only
    updated on a sweep that actually reached its body) hasn't advanced in
    ``_STALL_CYCLES`` cycles, the loop task is presumed wedged and is cancelled +
    replaced — the same shape as ``adsb_sidecar.supervise()`` for its browser
    sidecar, for exactly the same failure mode: a hung await inside the loop
    would otherwise freeze it forever while ``status()`` kept reporting healthy.

    ``_CYCLE_S``/``_STALL_CYCLES`` are read fresh from the module each
    iteration (not bound as defaults) so a test can monkeypatch them and see
    the new cadence take effect on the very next sleep.
    """
    global _TASK
    while True:
        await asyncio.sleep(_CYCLE_S if interval_s is None else interval_s)
        try:
            if not _STARTED or _TASK is None:
                continue
            last = _LAST_SWEEP_AT or _LOOP_STARTED_AT or time.time()
            age = time.time() - last
            if age < _CYCLE_S * _STALL_CYCLES:
                continue
            if _TASK.done():
                # Died on its own (shouldn't happen — _run_forever catches
                # everything — but don't leave it dead either way).
                log.warning("watch_officer: sweep task exited unexpectedly — restarting")
            else:
                log.warning(
                    "watch_officer: no sweep completed in %.0fs — restarting wedged loop", age
                )
                _TASK.cancel()
                try:
                    await _TASK
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
            _TASK = asyncio.create_task(_run_forever())
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — supervision must never die
            log.warning("watch_officer: supervise error: %s", exc)


async def start() -> None:
    """Start the watch-officer loop (idempotent). Safe to call once from lifespan."""
    global _TASK, _STARTED, _SUPERVISE_TASK, _LOOP_STARTED_AT
    if _STARTED:
        return
    _STARTED = True
    _LOOP_STARTED_AT = time.time()
    _TASK = asyncio.create_task(_run_forever())
    _SUPERVISE_TASK = asyncio.create_task(_supervise())


async def stop() -> None:
    """Cancel the loop and clear state (clean shutdown / test isolation)."""
    global _TASK, _STARTED, _SUPERVISE_TASK
    _STARTED = False
    # Cancel supervision BEFORE the loop task, or it can race the teardown below
    # and restart the very task stop() is killing (same ordering _adsb_sidecar_
    # /_ais_sidecar_ need in main.py, kept local here since both tasks are owned
    # by this module).
    if _SUPERVISE_TASK is not None:
        _SUPERVISE_TASK.cancel()
        try:
            await _SUPERVISE_TASK
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _SUPERVISE_TASK = None
    if _TASK is not None:
        _TASK.cancel()
        try:
            await _TASK
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _TASK = None
    reset_state()
