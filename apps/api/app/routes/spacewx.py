"""Space-weather extension (2026-07-14 data-layers wave).

``/api/weather/swpc/space`` — extends the existing Kp-only ``/api/weather/swpc/kp``
with the causal layer under the GPS-jamming feed: solar X-ray flares, active SWPC
alerts, and the auroral-oval probability grid. Returned as a GeoJSON FeatureCollection
of aurora points (kind ``aurora``) so it renders as a map layer, with the flare/alert
summary attached as extra top-level keys the MCP tool + panel read.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.routes import _feedgeo as fg

router = APIRouter(tags=["spacewx"])

FLARES_URL = "https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json"
ALERTS_URL = "https://services.swpc.noaa.gov/products/alerts.json"
AURORA_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json"

# Only surface meaningful aurora cells, and decimate the dense 1° grid so the
# layer stays a few hundred points, not ~64k.
_AURORA_MIN = 25
_AURORA_STRIDE = 3


@router.get("/api/weather/swpc/space")
async def space_weather() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        flares: list[dict[str, Any]] = []
        alerts: list[dict[str, Any]] = []
        aurora_pts: list[fg.Feature] = []

        try:
            raw_flares = await fg.fetch_json(FLARES_URL)
            for fl in (raw_flares or [])[:20]:
                if isinstance(fl, dict):
                    flares.append(
                        {
                            "class": fl.get("max_class") or fl.get("current_class"),
                            "begin": fl.get("begin_time"),
                            "max": fl.get("max_time"),
                            "satellite": fl.get("satellite"),
                        }
                    )
        except Exception:  # noqa: BLE001 — a single sub-feed failing must not 502 the whole
            pass

        try:
            raw_alerts = await fg.fetch_json(ALERTS_URL)
            for al in (raw_alerts or [])[:15]:
                if isinstance(al, dict):
                    alerts.append(
                        {
                            "product": al.get("product_id"),
                            "issued": al.get("issue_datetime"),
                            "message": (al.get("message") or "")[:400],
                        }
                    )
        except Exception:  # noqa: BLE001
            pass

        try:
            raw_aurora = await fg.fetch_json(AURORA_URL)
            grid = (raw_aurora or {}).get("coordinates") or []
            for i, cell in enumerate(grid):
                if i % _AURORA_STRIDE:
                    continue
                if not isinstance(cell, list) or len(cell) < 3:
                    continue
                lon, lat, val = fg.num(cell[0]), fg.num(cell[1]), fg.num(cell[2])
                if lon is None or lat is None or val is None or val < _AURORA_MIN:
                    continue
                if lon > 180:
                    lon -= 360
                aurora_pts.append(
                    fg.point(
                        f"aurora:{int(lon)}:{int(lat)}",
                        lon,
                        lat,
                        {"kind": "aurora", "probability": val},
                    )
                )
        except Exception:  # noqa: BLE001
            pass

        out = fg.fc(aurora_pts)
        out["flares"] = flares
        out["alerts"] = alerts
        return out

    return await fg.cached("weather:spacewx", 600.0, load)
