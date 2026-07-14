"""Air-quality feed (2026-07-14 data-layers wave).

``/api/env/air-quality`` — Open-Meteo's keyless air-quality API sampled across a
fixed set of major world cities in one batched request (comma-joined coords). Each
city becomes a Point Feature carrying US AQI + PM2.5/PM10, id ``airquality:<slug>``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.routes import _feedgeo as fg

router = APIRouter(tags=["env"])

AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

# (name, lat, lon) — a spread of large / pollution-relevant cities so the layer is
# globally legible without hammering the API city-by-city.
_CITIES: list[tuple[str, float, float]] = [
    ("delhi", 28.61, 77.21), ("beijing", 39.90, 116.40), ("shanghai", 31.23, 121.47),
    ("lahore", 31.55, 74.34), ("dhaka", 23.81, 90.41), ("karachi", 24.86, 67.01),
    ("mumbai", 19.08, 72.88), ("kolkata", 22.57, 88.36), ("jakarta", -6.21, 106.85),
    ("bangkok", 13.76, 100.50), ("seoul", 37.57, 126.98), ("tokyo", 35.68, 139.69),
    ("tehran", 35.69, 51.39), ("baghdad", 33.31, 44.36), ("cairo", 30.04, 31.24),
    ("lagos", 6.52, 3.38), ("kinshasa", -4.32, 15.31), ("johannesburg", -26.20, 28.05),
    ("moscow", 55.76, 37.62), ("istanbul", 41.01, 28.98), ("london", 51.51, -0.13),
    ("paris", 48.86, 2.35), ("madrid", 40.42, -3.70), ("milan", 45.46, 9.19),
    ("berlin", 52.52, 13.40), ("warsaw", 52.23, 21.01), ("kyiv", 50.45, 30.52),
    ("new_york", 40.71, -74.01), ("los_angeles", 34.05, -118.24), ("mexico_city", 19.43, -99.13),
    ("sao_paulo", -23.55, -46.63), ("bogota", 4.71, -74.07), ("lima", -12.05, -77.04),
    ("santiago", -33.45, -70.67), ("buenos_aires", -34.60, -58.38), ("toronto", 43.65, -79.38),
    ("chicago", 41.88, -87.63), ("houston", 29.76, -95.37), ("riyadh", 24.71, 46.68),
    ("dubai", 25.20, 55.27), ("sydney", -33.87, 151.21), ("singapore", 1.35, 103.82),
    ("manila", 14.60, 120.98), ("hanoi", 21.03, 105.85), ("nairobi", -1.29, 36.82),
    ("addis_ababa", 9.03, 38.74), ("kabul", 34.56, 69.21), ("ulaanbaatar", 47.89, 106.91),
]


@router.get("/api/env/air-quality")
async def air_quality() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        lats = ",".join(f"{c[1]:.2f}" for c in _CITIES)
        lons = ",".join(f"{c[2]:.2f}" for c in _CITIES)
        raw = await fg.fetch_json(
            AQ_URL,
            params={
                "latitude": lats,
                "longitude": lons,
                "current": "us_aqi,pm2_5,pm10",
            },
        )
        # Batched Open-Meteo returns a list (one obj per coord); a single coord
        # returns a bare object — normalise to a list.
        rows = raw if isinstance(raw, list) else [raw]
        out: list[fg.Feature] = []
        for city, row in zip(_CITIES, rows, strict=False):
            if not isinstance(row, dict):
                continue
            cur = row.get("current") or {}
            name, lat, lon = city
            out.append(
                fg.point(
                    f"airquality:{name}",
                    lon,
                    lat,
                    {
                        "kind": "airquality",
                        "name": name.replace("_", " ").title(),
                        "us_aqi": fg.num(cur.get("us_aqi")),
                        "pm2_5": fg.num(cur.get("pm2_5")),
                        "pm10": fg.num(cur.get("pm10")),
                        "time": cur.get("time"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("env:airquality", 1800.0, load)
