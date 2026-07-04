"""Watch-officer agent — standing loop that turns fusion output into briefs.

The operator senses far more than they can manually correlate. The cross-domain
fusion (``incidents.brief``) already narrates + cites converged incidents; this
loop watches its diff and, when a NEW or ESCALATED incident crosses into
high/elevated, runs a playbook and files a finished draft brief for the operator
to triage (ack / dismiss) in the Inbox — no operator labor to produce it.

In-memory + single-process (like ``routes.actions._PROPOSALS``): a restart drops
open briefs, which is fine — the loop re-derives them on its next cycle. Lifecycle
mirrors ``intel.watch`` (module ``_TASK``/``_STARTED`` + ``start``/``stop``),
started from the app lifespan.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

from app.intel import cue, incidents
from app.intel.incident_store import incident_key, incident_store

log = logging.getLogger("app.watch_officer")

_SCOPE = "watch-officer"
_CYCLE_S = 120.0
_MAX_BRIEFS = 100
_ACTIONABLE = {"high", "elevated"}

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
    """Run the automated response for an incident; return what was done.

    MVP wires ONE playbook: dark-vessel convergence tasks SAR at the centroid via
    tip-and-cue. Other playbooks (POL pull, OSINT investigate) are follow-ups — the
    incident already carries ``follow_up`` for the operator meanwhile.
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


def _make_brief(key: str, inc: dict[str, Any], playbook: dict[str, Any]) -> dict[str, Any]:
    return {
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


def _evict_if_full() -> None:
    while len(_BRIEFS) > _MAX_BRIEFS:
        oldest = min(_BRIEFS.values(), key=lambda b: b["created"])
        _BRIEFS.pop(oldest["key"], None)


async def run_once() -> int:
    """One sweep: fuse → diff → file briefs for new/escalated high incidents.

    Returns the number of briefs filed this sweep.
    """
    try:
        br = await incidents.brief()
    except Exception as exc:  # noqa: BLE001 — a fusion hiccup must not kill the loop
        log.debug("watch_officer: brief failed: %s", exc)
        return 0

    incs = br.get("incidents") or []
    by_key = {incident_key(i): i for i in incs}
    diff = incident_store.record(_SCOPE, incs)

    filed = 0
    for summary in [*diff.get("new", []), *diff.get("escalated", [])]:
        key = summary.get("key")
        if not key or key in _BRIEFS:
            continue
        if summary.get("threat_level") not in _ACTIONABLE:
            continue
        inc = by_key.get(key)
        if inc is None:
            continue
        playbook = await _playbook(inc)
        _BRIEFS[key] = _make_brief(key, inc, playbook)
        filed += 1

    _evict_if_full()
    if filed:
        log.info("watch_officer: filed %d brief(s); %d open", filed, len(_BRIEFS))
    return filed


def list_briefs() -> list[dict[str, Any]]:
    """Open briefs, newest first."""
    return sorted(_BRIEFS.values(), key=lambda b: b["created"], reverse=True)


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
    _BRIEFS.clear()


# ── background task lifecycle (mirrors intel.watch.start / stop) ─────────────────

_TASK: asyncio.Task[None] | None = None
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


async def start() -> None:
    """Start the watch-officer loop (idempotent). Safe to call once from lifespan."""
    global _TASK, _STARTED
    if _STARTED:
        return
    _STARTED = True
    _TASK = asyncio.create_task(_run_forever())


async def stop() -> None:
    """Cancel the loop and clear state (clean shutdown / test isolation)."""
    global _TASK, _STARTED
    _STARTED = False
    if _TASK is not None:
        _TASK.cancel()
        try:
            await _TASK
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _TASK = None
    reset_state()
