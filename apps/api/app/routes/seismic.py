"""GET /api/seismic/emsc — EMSC SeismicPortal (Europe-Med + global).

Per research_updated.md §2.10: FDSN at seismicportal.eu/fdsnws/event/1/query.
Returns FDSN JSON (one event per feature). We normalize to GeoJSON so the
existing PollGeoJsonAdapter renders it as 'quake' style.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.upstream import cache, get_client

router = APIRouter(tags=["seismic"])


@router.get("/api/seismic/emsc")
async def emsc(
    minmag: float = Query(2.5, ge=0, le=10),
    hours: int = Query(24, ge=1, le=720),
) -> dict[str, Any]:
    key = f"emsc:{minmag}:{hours}"

    async def load() -> dict[str, Any]:
        end = datetime.now(tz=UTC)
        start = end - timedelta(hours=hours)
        params: dict[str, Any] = {
            "format": "json",
            "minmag": minmag,
            "starttime": start.strftime("%Y-%m-%dT%H:%M:%S"),
            "endtime": end.strftime("%Y-%m-%dT%H:%M:%S"),
            "orderby": "time",
        }
        url = "https://www.seismicportal.eu/fdsnws/event/1/query"
        r = await get_client().get(url, params=params)
        if r.status_code == 204:
            return {"type": "FeatureCollection", "features": []}
        if r.status_code != 200:
            raise HTTPException(502, f"emsc upstream {r.status_code}")
        try:
            j = r.json()
        except ValueError as e:
            # A 200 + non-JSON body (maintenance/rate-limit HTML) must degrade to a
            # 502, not raise out of the loader and 500 this keyless route.
            raise HTTPException(502, "emsc non-JSON body") from e
        feats: list[dict[str, Any]] = []
        for ev in j.get("features", []):
            props = ev.get("properties", {})
            geom = ev.get("geometry") or {}
            if geom.get("type") != "Point":
                continue
            feats.append(
                {
                    "type": "Feature",
                    "id": f"quake:emsc:{ev.get('id')}",
                    "geometry": geom,
                    "properties": {
                        "mag": props.get("mag"),
                        "depth": props.get("depth"),
                        "place": props.get("flynn_region"),
                        "time": props.get("time"),
                        "source_id": ev.get("id"),
                        "source": "emsc",
                        "kind": "quake",
                    },
                }
            )
        return {"type": "FeatureCollection", "features": feats}

    return await cache.get_or_fetch(key, 60.0, load)
