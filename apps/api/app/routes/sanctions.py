"""``/api/sanctions/*`` — OFAC SDN, and the join onto the live feeds.

``/lookup`` answers "is this hull or this tail designated" for one object.
``/vessels`` and ``/aircraft`` answer the question the other way round: of
everything moving on the map right now, which contacts are on the list. That
second direction is what a maritime-risk subscription sells, and it is a
dictionary lookup over data both halves of which are already free.

Nothing here synthesises a position. A contact appears in these layers only
because an AIS or ADS-B fix put it there; the sanctions list contributes the
designation and nothing else, and every feature says which identifier the match
rested on.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Query

from app.intel import sanctions as sx
from app.routes import _feedgeo as fg
from app.routes.adsb import snapshot_view
from app.routes.maritime import vessel_snapshot

router = APIRouter(prefix="/api/sanctions", tags=["sanctions"])


@router.get("/summary")
async def summary() -> dict[str, Any]:
    """What list is loaded, how big it is, and what it can be joined on."""
    idx = await sx.get_index()
    programs = sorted(idx.programs().items(), key=lambda kv: -kv[1])
    return {
        "list": "OFAC SDN",
        "source_url": sx.SDN_CSV_URL,
        "tier": "registry",
        "fetched_at": idx.fetched_at,
        "rows": idx.rows,
        "by_type": idx.counts(),
        "joinable": {
            "imo": len(idx.by_imo),
            "mmsi": len(idx.by_mmsi),
            "call_sign": len(idx.by_call_sign),
            "aircraft_tail": len(idx.by_tail),
        },
        "top_programs": [{"program": p, "count": n} for p, n in programs[:12]],
        "note": (
            "OFAC only. The EU consolidated list, UK OFSI and the UN Security Council list "
            "are not loaded, so an object absent here may still be designated elsewhere."
        ),
    }


@router.get("/lookup")
async def lookup(
    imo: int | None = Query(None, ge=1000000, le=9999999),
    mmsi: int | None = Query(None, ge=100000000, le=999999999),
    call_sign: str | None = Query(None, max_length=32),
    name: str | None = Query(None, max_length=160),
    registration: str | None = Query(None, max_length=32),
) -> dict[str, Any]:
    """Designation for one vessel or aircraft, or an explicit miss.

    A miss is reported as ``matched: false`` with the identifiers that were
    tried, never as an empty body: "we looked and found nothing" and "we did not
    look" are different answers and the panel renders them differently.
    """
    idx = await sx.get_index()
    tried = {
        k: v
        for k, v in {
            "imo": imo,
            "mmsi": mmsi,
            "call_sign": call_sign,
            "name": name,
            "registration": registration,
        }.items()
        if v
    }
    m = None
    if imo or mmsi or call_sign or (name and not registration):
        m = sx.match_vessel(idx, imo=imo, mmsi=mmsi, call_sign=call_sign, name=name)
    if m is None and (registration or name):
        m = sx.match_aircraft(idx, registration=registration, name=name)
    return {
        "matched": m is not None,
        "match": m.as_dict() if m else None,
        "tried": tried,
        "list": "OFAC SDN",
        "fetched_at": idx.fetched_at,
    }


def _match_props(m: sx.Match) -> dict[str, Any]:
    d = m.designation
    return {
        "sanctioned": True,
        "sanction_list": "OFAC SDN",
        "sanction_programs": list(d.programs),
        "sanction_matched_on": m.matched_on,
        "sanction_confidence": m.confidence,
        "sanction_ent_num": d.ent_num,
        "sanction_name": d.name,
        "vessel_flag": d.vessel_flag,
        "vessel_owner": d.vessel_owner,
    }


@router.get("/vessels")
async def sanctioned_vessels(
    limit: int = Query(2000, ge=1, le=20000),
    exact_only: int = Query(0, description="1 = drop name and call-sign candidates"),
) -> dict[str, Any]:
    """Designated hulls currently in the AIS snapshot, as GeoJSON."""
    idx = await sx.get_index()
    snap = vessel_snapshot()

    # ~60k hulls, each costing up to three folded-name lookups. Off the loop:
    # the map polls this on a timer and it must never be what makes the aircraft
    # snapshot late.
    def scan() -> tuple[list[dict[str, Any]], int]:
        out: list[dict[str, Any]] = []
        considered = 0
        for f in snap.get("features", []):
            p = f.get("properties") or {}
            considered += 1
            imo = p.get("imo") or None
            m = sx.match_vessel(
                idx,
                imo=int(imo) if imo else None,
                mmsi=p.get("mmsi"),
                call_sign=p.get("callSign"),
                name=p.get("name"),
            )
            if m is None:
                continue
            if exact_only and m.confidence != "exact":
                continue
            geom = f.get("geometry") or {}
            coords = geom.get("coordinates") or []
            if len(coords) < 2:
                continue
            out.append(
                fg.point(
                    str(f.get("id") or f"vessel:{p.get('mmsi') or m.designation.ent_num}"),
                    float(coords[0]),
                    float(coords[1]),
                    {**p, **_match_props(m), "style_kind": "sanctioned"},
                )
            )
            if len(out) >= limit:
                break
        return out, considered

    out, considered = await asyncio.to_thread(scan)
    env = fg.fc(out)
    env["note"] = (
        f"{len(out)} designated hulls in a snapshot of {considered} vessels, "
        "joined on IMO, MMSI, call sign or name. OFAC SDN only."
    )
    return env


@router.get("/aircraft")
async def sanctioned_aircraft(limit: int = Query(2000, ge=1, le=20000)) -> dict[str, Any]:
    """Designated airframes currently in the ADS-B snapshot, as GeoJSON."""
    idx = await sx.get_index()
    # snapshot_view() must not be retained across an await (apps/api/CLAUDE.md),
    # so the scan runs against a shallow list taken in this turn.
    features = list(snapshot_view().get("features", []))

    def scan() -> tuple[list[dict[str, Any]], int]:
        out: list[dict[str, Any]] = []
        considered = 0
        for f in features:
            p = f.get("properties") or {}
            considered += 1
            m = sx.match_aircraft(idx, registration=p.get("registration"))
            if m is None:
                continue
            geom = f.get("geometry") or {}
            coords = geom.get("coordinates") or []
            if len(coords) < 2:
                continue
            out.append(
                fg.point(
                    str(f.get("id") or f"aircraft:{p.get('icao24') or m.designation.ent_num}"),
                    float(coords[0]),
                    float(coords[1]),
                    {**p, **_match_props(m), "style_kind": "sanctioned"},
                )
            )
            if len(out) >= limit:
                break
        return out, considered

    out, considered = await asyncio.to_thread(scan)
    env = fg.fc(out)
    env["note"] = (
        f"{len(out)} designated airframes in a snapshot of {considered} aircraft, "
        "joined on tail number. OFAC SDN only."
    )
    return env
