"""Keyless ACARS feed routes — /api/acars/*.

No auth, no key: the airframes.io firehose is a public community feed, mirroring
the keyless ADS-B / AIS layers. The summary block reports MEASURED coverage
(message count, how many carry a position, distinct ground stations) so the
frontend never has to assert "global".
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app import acars

router = APIRouter(tags=["acars"])


@router.get("/api/acars")
async def acars_recent(limit: int = Query(100, ge=1, le=100)) -> dict[str, Any]:
    """Recent ACARS/VDL/HFDL/SATCOM messages (keyless, airframes.io).

    Returns normalized messages + a measured coverage summary. Messages carrying
    ``lat``/``lon`` can be plotted on the globe; the rest are aircraft-keyed by
    ``tail`` / ``flight`` and join the ontology via those identifiers.
    """
    msgs = await acars.fetch_recent(limit)
    with_pos = sum(1 for m in msgs if m.get("lat") is not None and m.get("lon") is not None)
    stations = {m["station"] for m in msgs if m.get("station")}
    modes: dict[str, int] = {}
    for m in msgs:
        if m.get("mode"):
            modes[m["mode"]] = modes.get(m["mode"], 0) + 1
    return {
        "messages": msgs,
        "summary": {
            "count": len(msgs),
            "with_position": with_pos,
            "stations": len(stations),
            "modes": modes,
            "source": "airframes.io (keyless community feed)",
            "coverage": "community-station-shaped (dense NA/EU/oceanic tracks); NOT guaranteed-global",
        },
    }


@router.get("/api/acars/geojson")
async def acars_geojson(limit: int = Query(100, ge=1, le=100)) -> dict[str, Any]:
    """Position-bearing ACARS messages as a GeoJSON FeatureCollection — the shape
    a globe layer (registry `feed.acars`) consumes, same contract as `/api/cams`."""
    return acars.to_geojson(await acars.fetch_recent(limit))


@router.get("/api/acars/stats")
async def acars_stats() -> dict[str, Any]:
    """airframes.io station + mode counts — the live coverage measure."""
    return await acars.stats()
