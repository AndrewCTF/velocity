"""DeepState UA extended feeds (2026-08-06 mega-ledger wave).

The main frontline GeoJSON is already in ``conflict.py``. These three
additional DeepState endpoints add fire hotspots, radiation monitoring,
and geolocated war-news events within the UA theater.

- ``/api/conflict/deepstate-firms``     fire points in UA theater
- ``/api/conflict/deepstate-radiation`` 565 live radiation stations
- ``/api/conflict/deepstate-news``      geolocated war-news events
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.routes import _feedgeo as fg

router = APIRouter(tags=["deepstate"])

# ── DeepState FIRMS (fire points in UA theater) ────────────────────────────
DS_FIRMS_URL = "https://deepstatemap.live/api/firms"


@router.get("/api/conflict/deepstate-firms")
async def deepstate_firms() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(DS_FIRMS_URL)
        items = raw if isinstance(raw, list) else (raw or {}).get("data", [])
        out: list[fg.Feature] = []
        for f in items or []:
            lat = fg.num(f.get("lat") or f.get("latitude"))
            lon = fg.num(f.get("lng") or f.get("lon") or f.get("longitude"))
            if lat is None or lon is None:
                continue
            fid = f"{lat:.4f}_{lon:.4f}"
            out.append(
                fg.point(
                    f"ds_fire:{fid}",
                    lon,
                    lat,
                    {
                        "kind": "ds_fire",
                        "brightness": fg.num(f.get("brightness")),
                        "confidence": f.get("confidence"),
                        "satellite": f.get("satellite"),
                        "acq_date": f.get("acq_date"),
                        "acq_time": f.get("acq_time"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("conflict:ds_firms", 600.0, load)


# ── DeepState radiation (monitoring stations) ──────────────────────────────
DS_RADIATION_URL = "https://deepstatemap.live/api/seb/"


@router.get("/api/conflict/deepstate-radiation")
async def deepstate_radiation() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(DS_RADIATION_URL)
        items = raw if isinstance(raw, list) else (raw or {}).get("data", [])
        out: list[fg.Feature] = []
        for s in items or []:
            lat = fg.num(s.get("lat") or s.get("latitude"))
            lon = fg.num(s.get("lng") or s.get("lon") or s.get("longitude"))
            sid = str(s.get("id") or s.get("station_id") or "")
            if lat is None or lon is None or not sid:
                continue
            out.append(
                fg.point(
                    f"ds_rad:{sid}",
                    lon,
                    lat,
                    {
                        "kind": "ds_radiation",
                        "name": s.get("name") or s.get("title"),
                        "value": fg.num(s.get("value") or s.get("gamma")),
                        "unit": s.get("unit") or "µSv/h",
                        "updated": s.get("updated_at") or s.get("date"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("conflict:ds_radiation", 600.0, load)


# ── DeepState war news (geolocated events) ─────────────────────────────────
DS_NEWS_URL = "https://deepstatemap.live/api/history/public"


@router.get("/api/conflict/deepstate-news")
async def deepstate_news(limit: int = Query(200, ge=1, le=2000)) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(DS_NEWS_URL)
        items = raw if isinstance(raw, list) else (raw or {}).get("data", [])
        out: list[fg.Feature] = []
        for e in (items or [])[:limit]:
            lat = fg.num(e.get("lat") or e.get("latitude"))
            lon = fg.num(e.get("lng") or e.get("lon") or e.get("longitude"))
            eid = str(e.get("id") or "")
            if lat is None or lon is None or not eid:
                continue
            out.append(
                fg.point(
                    f"ds_event:{eid}",
                    lon,
                    lat,
                    {
                        "kind": "ds_event",
                        "title": e.get("title") or e.get("text"),
                        "date": e.get("date") or e.get("created_at"),
                        "type": e.get("type"),
                        "source": e.get("source"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached(f"conflict:ds_news:{limit}", 600.0, load)
