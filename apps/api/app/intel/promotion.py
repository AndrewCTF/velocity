"""Auto-promotion — incidents flow into the ontology graph (W4 slice 1).

Turns incidents.brief()'s deterministic convergences into `incident:<id>`
ontology objects: sourced assertions (assert_props — merge, never upsert)
plus `evidence_of` reason links from each translatable member entity to the
incident. No new background loop; called from watch_officer.run_once().

Phase 2 (roadmap-ontology): the same verbs also serve the request-driven
mints — a sanctions-list hit (`mint_sanctions_match`, called from
routes/sanctions.py) and a correlation alert (`promote_alert`, exported for
the bus slice that does not exist yet) — plus the process mint counters the
/api/status/provenance route reports under "ontology".
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from collections import deque
from typing import Any

from app.intel.incident_store import incident_key
from app.intel.ontology import Link, Object
from app.intel.ontology_local import SqliteRegistry

log = logging.getLogger("app.intel.promotion")

# Firehose guard (CLAUDE.md "every mint carries a reason link", roadmap Phase 2
# "a promotion pipeline, not a firehose"). incidents.brief() itself caps at 25
# incidents (incidents.py _MAX_INCIDENTS); this is a stricter per-cycle ontology-
# write budget, deliberately well under that. Hardcoded — no config.py setting
# this slice (see docs/ontology-autopopulation-plan.md §E).
MAX_INCIDENT_MINTS_PER_CYCLE = 10

# ── mint counters + per-minute budget (roadmap Phase 2, status route) ───────
# Module-level on purpose: the watch-officer cycle, the (future) alert bus and
# the sanctions route all mint from different call sites, and
# /api/status/provenance is the one place the operator sees whether the graph
# is actually filling. `last_cycle` rolls at each promote_incidents()
# boundary, so it always reports a COMPLETED cycle; mints that land between
# cycles (the sanctions lookups) accrue to the in-flight cycle and roll with
# it.
_mints_total: int = 0
_mints_last_cycle: int = 0
_mints_this_cycle: int = 0

# Per-process-minute budget for REQUEST-DRIVEN mints (the sanctions lookup —
# a client can hammer it; the watch-officer cycle already caps itself per
# call). A sliding 60 s window of mint timestamps; the cap reopens as the
# oldest mints fall out of it.
_MINT_BUDGET_WINDOW_S = 60.0
_mint_budget: deque[float] = deque()


def record_mint() -> None:
    """Count one successful ontology mint (promote_incident / promote_alert /
    mint_sanctions_match call this, and only this)."""
    global _mints_total, _mints_this_cycle
    _mints_total += 1
    _mints_this_cycle += 1


def begin_cycle() -> None:
    """Cycle boundary (promote_incidents runs once per watch-officer cycle):
    hand the in-flight accumulator to last-cycle."""
    global _mints_last_cycle, _mints_this_cycle
    _mints_last_cycle = _mints_this_cycle
    _mints_this_cycle = 0


def mints_state() -> dict[str, int]:
    """The two counters /api/status/provenance reports under "ontology"."""
    return {"mints_last_cycle": _mints_last_cycle, "mints_total": _mints_total}


def reset_mint_counters() -> None:
    """Test hook: zero the counters and the per-minute budget."""
    global _mints_total, _mints_last_cycle, _mints_this_cycle
    _mints_total = 0
    _mints_last_cycle = 0
    _mints_this_cycle = 0
    _mint_budget.clear()


def _budget_ok() -> bool:
    """May one more request-driven mint happen inside the sliding 60 s
    window?"""
    now = time.monotonic()
    while _mint_budget and now - _mint_budget[0] > _MINT_BUDGET_WINDOW_S:
        _mint_budget.popleft()
    return len(_mint_budget) < MAX_INCIDENT_MINTS_PER_CYCLE


def _record_budget_use() -> None:
    _mint_budget.append(time.monotonic())

# Evidence ref keys that translate to a canonical Velocity ontology id.
# gps-jamming cells, quakes, spoofing findings, GDELT/EONET/ACLED events, and
# alert-bus-sourced signals (ref={"alert_id","rule"}) carry NO translatable
# entity id — see docs/ontology-autopopulation-plan.md §2 for the verified
# per-domain ref shapes.


def _entity_id_from_evidence(ev: dict[str, Any]) -> str | None:
    ref = ev.get("ref") or {}
    icao24 = ref.get("icao24")
    if icao24:
        return f"aircraft:{icao24}"
    mmsi = ref.get("mmsi")
    if mmsi:
        return f"vessel:{mmsi}"
    return None


def stable_id(prefix: str, key: str) -> str:
    """Deterministic ``<prefix>:<sha1(key)[:16]>`` — the same input key always
    mints the same id, so repeated calls UPDATE one object instead of minting
    a duplicate. Shared by ``_stable_incident_id`` below (keyed by
    ``incident_key()``, auto-promoted convergences) and
    ``actions.py``'s ``_handle_promote_incident`` (keyed by the target object
    id being manually promoted) so both promotion paths mint idempotently.
    """
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}:{digest}"


def _stable_incident_id(incident: dict[str, Any]) -> str:
    """Deterministic incident:<id> so re-running UPDATES the same object.

    incidents.py's own inc["id"] (uuid4 hex) is fresh every brief() call —
    NOT usable (see plan §2). incident_store.incident_key() (0.5° centroid
    grid + sorted domain set) is the already-computed stable identity for
    "same real-world convergence" and is what watch_officer._BRIEFS is
    already keyed by.
    """
    return stable_id("incident", incident_key(incident))


async def promote_incident(
    reg: SqliteRegistry, incident: dict[str, Any], *, source: str
) -> str | None:
    """Mint/update one incident object + evidence_of links.

    Returns the object id, or None if the incident has zero translatable
    evidence members — an incident:<id> object with no reason link is the
    exact firehose junk CLAUDE.md's "every mint carries a reason link" rule
    forbids, so we skip the mint entirely rather than create an orphan.
    """
    evidence = incident.get("evidence") or []
    member_ids = sorted(
        {mid for ev in evidence if (mid := _entity_id_from_evidence(ev))}
    )
    if not member_ids:
        return None

    incident_id = _stable_incident_id(incident)
    key = incident_key(incident)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    await reg.assert_props(
        incident_id,
        {
            "threat_level": incident.get("threat_level"),
            "score": incident.get("score"),
            "domains": incident.get("domains"),
            "narrative": incident.get("narrative"),
            "centroid": incident.get("centroid"),
        },
        source=source,
        observed_at=now,
        derivation={"incident_key": key, "brief_id": incident.get("id")},
    )
    for mid in member_ids:
        # Canonical direction per ontology.py KNOWN_RELS docstring
        # ("signal/track → incident it supports") — member entity →
        # incident, NOT actions.py._handle_promote_incident's inverted edge
        # (see plan §2 for the discovered inconsistency).
        await reg.link(Link(src=mid, dst=incident_id, rel="evidence_of", source=source))
    record_mint()
    return incident_id


async def promote_incidents(
    reg: SqliteRegistry, incidents: list[dict[str, Any]], *, source: str
) -> list[str]:
    """Promote up to MAX_INCIDENT_MINTS_PER_CYCLE incidents (best-first order
    — incidents.brief() already sorts by threat_level/score descending, so
    capping the front of the list keeps the most actionable ones). Logs, does
    not silently drop, whatever it declines to process.
    """
    begin_cycle()  # this call IS the cycle boundary (watch_officer runs it once a cycle)
    minted: list[str] = []
    budget = MAX_INCIDENT_MINTS_PER_CYCLE
    dropped = incidents[budget:]
    for inc in incidents[:budget]:
        oid = await promote_incident(reg, inc, source=source)
        if oid:
            minted.append(oid)
    if dropped:
        log.info(
            "promotion: per-cycle cap (%d) hit, dropped %d incident(s) this cycle",
            budget, len(dropped),
        )
    return minted


# ── alert-bus significance (Phase 2 trigger (a): "any entity that trips a
# detector"). Deliberately NOT wired into the correlation bus here — that is
# another slice; the function is exported so it can be called and tested
# directly in the meantime.


async def promote_alert(reg: SqliteRegistry, alert: dict[str, Any]) -> str | None:
    """Mint/update the object a correlation alert fired on, mirroring
    ``promote_incident``.

    The object id is ``alert["entity_id"]`` when the caller carries one and
    falls back to the alert's own id, so an alert that names no entity still
    stands alone as an object. The assertion is sourced ``alert:<rule_id>``;
    the ``evidence_of`` link — the same relation ``promote_incident`` uses, in
    its documented canonical direction (evidence → what it supports) — points
    from the fired alert at the entity it is evidence about. A self-link (no
    ``entity_id``) is skipped, and an alert with no usable id returns
    ``None`` without minting anything.
    """
    entity_id = alert.get("entity_id") or alert.get("id")
    if not entity_id:
        return None
    alert_id = alert.get("id")
    source = f"alert:{alert.get('rule_id', '?')}"
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    await reg.assert_props(
        str(entity_id),
        {
            "alert_id": alert.get("id"),
            "rule": alert.get("rule_id"),
            "severity": alert.get("severity"),
            "message": alert.get("message"),
            "confidence": alert.get("confidence"),
            "centroid": {"lon": alert.get("lon"), "lat": alert.get("lat")},
        },
        source=source,
        observed_at=now,
    )
    if alert_id and str(alert_id) != str(entity_id):
        await reg.link(
            Link(src=str(alert_id), dst=str(entity_id), rel="evidence_of", source=source)
        )
    record_mint()
    return str(entity_id)


# ── sanctions significance (Phase 2: "matches a standing watch") ─────────────


def _list_slug(name: str) -> str:
    """``OFAC SDN`` -> ``ofac-sdn``; the list's org object is
    ``org:sanctions-<slug>``."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "list"


async def mint_sanctions_match(
    reg: SqliteRegistry,
    entity_id: str,
    *,
    list_name: str,
    lists: str,
    matched_name: str,
) -> str | None:
    """Best-effort Phase-2 mint of a sanctions-list hit (routes/sanctions.py).

    A designation is significance, so a matched contact mints as an ontology
    object: sourced assertions (``sanctioned`` / ``sanctions_list`` /
    ``sanctions_match``), the list's org object (``org:sanctions-<slug>``,
    upserted ONLY when missing, so an analyst-edited org keeps its props), and
    the ``designated_by`` reason link. Registry errors are swallowed — the
    lookup that triggered this must never fail — and the per-process-minute
    budget caps a hammering client at MAX_INCIDENT_MINTS_PER_CYCLE mints.
    """
    if not entity_id:
        return None
    if not _budget_ok():
        log.info(
            "promotion: per-minute mint budget (%d) exhausted, skipping "
            "sanctions mint %s",
            MAX_INCIDENT_MINTS_PER_CYCLE,
            entity_id,
        )
        return None
    source = f"sanctions:{list_name}"
    try:
        await reg.assert_props(
            entity_id,
            {"sanctioned": True, "sanctions_list": lists, "sanctions_match": matched_name},
            source=source,
        )
        org_id = f"org:sanctions-{_list_slug(list_name)}"
        if await reg.get(org_id) is None:
            await reg.upsert(
                Object(id=org_id, kind="org", props={"name": list_name}), source=source
            )
        await reg.link(Link(src=entity_id, dst=org_id, rel="designated_by", source=source))
    except Exception:  # noqa: BLE001 — best-effort by contract
        log.exception("promotion: sanctions mint failed for %s", entity_id)
        return None
    _record_budget_use()
    record_mint()
    return entity_id
