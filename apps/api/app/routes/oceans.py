"""Maritime context feeds (2026-07-14 data-layers wave).

- ``/api/maritime/buoys``       NDBC latest marine observations (wave height / wind)
- ``/api/maritime/chokepoints`` vessel congestion at named straits, derived in-process
  from the keyless AIS union (``vessel_snapshot``) — no new upstream.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.routes import _feedgeo as fg
from app.routes.maritime import vessel_snapshot

router = APIRouter(tags=["oceans"])

# ── NDBC marine buoys ────────────────────────────────────────────────────────
# A whitespace-delimited text table, one row per active station; "MM" marks a
# missing value. Columns (positional): STN LAT LON YY MM DD hh mm WDIR WSPD GST
# WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE.
NDBC_URL = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"


def _f(tok: str) -> float | None:
    return None if tok in ("MM", "") else fg.num(tok)


@router.get("/api/maritime/buoys")
async def buoys() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        text = await fg.fetch_text(NDBC_URL)
        out: list[fg.Feature] = []
        for line in text.splitlines():
            if not line or line.startswith("#"):
                continue
            cols = line.split()
            if len(cols) < 3:
                continue
            stn = cols[0]
            lat = _f(cols[1])
            lon = _f(cols[2])
            if lat is None or lon is None:
                continue
            out.append(
                fg.point(
                    f"buoy:{stn}",
                    lon,
                    lat,
                    {
                        "kind": "buoy",
                        "station": stn,
                        "wave_height_m": _f(cols[11]) if len(cols) > 11 else None,
                        "wind_speed_ms": _f(cols[9]) if len(cols) > 9 else None,
                        "wind_dir_deg": _f(cols[8]) if len(cols) > 8 else None,
                        "pressure_hpa": _f(cols[15]) if len(cols) > 15 else None,
                        "air_temp_c": _f(cols[17]) if len(cols) > 17 else None,
                        "water_temp_c": _f(cols[18]) if len(cols) > 18 else None,
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("maritime:buoys", 900.0, load)


# ── Maritime chokepoint congestion (self-derived) ────────────────────────────
# (name, lon_min, lat_min, lon_max, lat_max, center_lon, center_lat)
_CHOKEPOINTS: list[tuple[str, float, float, float, float, float, float]] = [
    ("Strait of Hormuz", 55.5, 25.5, 57.0, 27.0, 56.30, 26.60),
    ("Suez / Gulf of Suez", 32.2, 29.5, 32.8, 31.3, 32.45, 30.40),
    ("Bab-el-Mandeb", 43.0, 12.3, 43.6, 13.2, 43.30, 12.70),
    ("Bosphorus", 28.9, 40.9, 29.3, 41.3, 29.05, 41.10),
    ("Strait of Malacca", 100.0, 1.0, 104.0, 4.5, 101.50, 2.50),
    ("Panama Canal", -80.2, 8.8, -79.4, 9.7, -79.80, 9.30),
    ("Strait of Gibraltar", -5.7, 35.7, -5.2, 36.2, -5.45, 36.00),
    ("Dover Strait", 1.0, 50.6, 1.9, 51.2, 1.40, 50.95),
    ("Danish Straits", 10.4, 54.9, 11.6, 56.1, 11.00, 55.50),
    ("Taiwan Strait", 118.0, 23.0, 121.0, 25.5, 119.50, 24.20),
]


def _speed_of(props: dict[str, Any]) -> float | None:
    for key in ("sog", "speed", "speed_knots", "velocity_kn"):
        v = fg.num(props.get(key))
        if v is not None:
            return v
    return None


@router.get("/api/maritime/chokepoints")
async def chokepoints() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        snap = vessel_snapshot()
        feats = snap.get("features", []) if isinstance(snap, dict) else []
        out: list[fg.Feature] = []
        for name, lomin, lamin, lomax, lamax, clon, clat in _CHOKEPOINTS:
            total = 0
            slow = 0
            for v in feats:
                geom = v.get("geometry") or {}
                coords = geom.get("coordinates")
                if not isinstance(coords, list) or len(coords) < 2:
                    continue
                lon, lat = fg.num(coords[0]), fg.num(coords[1])
                if lon is None or lat is None:
                    continue
                if lomin <= lon <= lomax and lamin <= lat <= lamax:
                    total += 1
                    sp = _speed_of(v.get("properties") or {})
                    if sp is not None and sp < 1.0:
                        slow += 1
            slug = name.lower().replace(" / ", "-").replace(" ", "-")
            level = "high" if total >= 60 else "elevated" if total >= 25 else "normal"
            out.append(
                fg.point(
                    f"chokepoint:{slug}",
                    clon,
                    clat,
                    {
                        "kind": "chokepoint",
                        "name": name,
                        "vessels": total,
                        "stationary": slow,
                        "congestion": level,
                    },
                )
            )
        return fg.fc(out)

    # Short TTL: congestion tracks the live vessel store, which moves every poll.
    return await fg.cached("maritime:chokepoints", 60.0, load)
