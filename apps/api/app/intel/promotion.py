"""Auto-promotion — incidents flow into the ontology graph (W4 slice 1).

Turns incidents.brief()'s deterministic convergences into `incident:<id>`
ontology objects: sourced assertions (assert_props — merge, never upsert)
plus `evidence_of` reason links from each translatable member entity to the
incident. No new background loop; called from watch_officer.run_once().
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

from app.intel.incident_store import incident_key
from app.intel.ontology import Link
from app.intel.ontology_local import SqliteRegistry

log = logging.getLogger("app.intel.promotion")

# Firehose guard (CLAUDE.md "every mint carries a reason link", roadmap Phase 2
# "a promotion pipeline, not a firehose"). incidents.brief() itself caps at 25
# incidents (incidents.py _MAX_INCIDENTS); this is a stricter per-cycle ontology-
# write budget, deliberately well under that. Hardcoded — no config.py setting
# this slice (see docs/ontology-autopopulation-plan.md §E).
MAX_INCIDENT_MINTS_PER_CYCLE = 10

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


def _stable_incident_id(incident: dict[str, Any]) -> str:
    """Deterministic incident:<id> so re-running UPDATES the same object.

    incidents.py's own inc["id"] (uuid4 hex) is fresh every brief() call —
    NOT usable (see plan §2). incident_store.incident_key() (0.5° centroid
    grid + sorted domain set) is the already-computed stable identity for
    "same real-world convergence" and is what watch_officer._BRIEFS is
    already keyed by.
    """
    key = incident_key(incident)
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    return f"incident:{digest}"


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
    return incident_id


async def promote_incidents(
    reg: SqliteRegistry, incidents: list[dict[str, Any]], *, source: str
) -> list[str]:
    """Promote up to MAX_INCIDENT_MINTS_PER_CYCLE incidents (best-first order
    — incidents.brief() already sorts by threat_level/score descending, so
    capping the front of the list keeps the most actionable ones). Logs, does
    not silently drop, whatever it declines to process.
    """
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
