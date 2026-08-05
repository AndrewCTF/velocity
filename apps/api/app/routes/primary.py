"""Three more primary emitters, none of them narrative.

docs/plan-99-2026-08.md §3. Each is a machine or a register publishing what it
observed, keylessly, and each answers a question the console could not answer
before.

* ``/api/space/launches`` — Launch Library 2. Every orbital launch, upcoming and
  just flown, at the pad it flies from with real coordinates. A launch is a
  scheduled, geolocated event that the console had no way to show.
* ``/api/env/spaceweather`` — NOAA SWPC. Planetary K index and the current GOES
  X-ray flare class. Both drive HF propagation and GNSS accuracy, which is to
  say both are upstream of two feeds already on the map.
* ``/api/oceans/surge`` — NOAA CO-OPS. Observed water level MINUS the tide
  prediction for the same minute, which is the analysis: the tide is known
  years ahead, so the residual is surge, and surge is the number that closes
  ports.

The surge route is the pattern this platform keeps repeating on purpose: a raw
reading is not intelligence, a raw reading against what was expected is.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from typing import Any

from fastapi import APIRouter, Query

from app.routes import _feedgeo as fg
from app.upstream import cache, get_client

router = APIRouter(tags=["primary"])

# ── launches ────────────────────────────────────────────────────────────────
LL2_URL = "https://ll.thespacedevs.com/2.2.0/launch/"
# LL2 rate-limits anonymous callers hard (documented ~15/hour), and it answers a
# rate-limited caller with a body that has no `results` key rather than a 429.
# A long TTL is not an optimisation here, it is how this stays usable.
_LAUNCH_TTL_S = 3 * 3600


async def _launches(limit: int) -> dict[str, Any]:
    feats: list[dict[str, Any]] = []
    reached = True
    try:
        r = await get_client().get(
            LL2_URL,
            params={
                "limit": min(limit, 50),
                # Ascending, and bounded at BOTH ends. Descending from a lower
                # bound returned the furthest-future manifest first: the top of
                # the list was four Ariane flights in 2035-2039 with a TBD
                # status, which is a schedule nobody is watching. The question is
                # what just flew and what is next.
                "ordering": "net",
                "net__gte": (dt.datetime.now(dt.UTC) - dt.timedelta(days=7)).isoformat(),
                "net__lte": (dt.datetime.now(dt.UTC) + dt.timedelta(days=60)).isoformat(),
            },
            timeout=45.0,
        )
        body = r.json() if r.status_code == 200 else {}
    except Exception:  # noqa: BLE001 — a rate-limited upstream must degrade
        body = {}
    results = body.get("results")
    if not isinstance(results, list):
        reached = False
        results = []
    for row in results:
        pad = row.get("pad") or {}
        lat, lon = pad.get("latitude"), pad.get("longitude")
        if lat is None or lon is None:
            continue
        status = (row.get("status") or {}).get("abbrev")
        feats.append(
            fg.point(
                f"launch:{row.get('id')}",
                float(lon),
                float(lat),
                {
                    "kind": "launch",
                    "style_kind": "launch",
                    "name": row.get("name"),
                    "net": row.get("net"),
                    "status": status,
                    "pad": pad.get("name"),
                    "site": (pad.get("location") or {}).get("name"),
                    "provider": ((row.get("launch_service_provider") or {}).get("name")),
                },
            )
        )
    env = fg.fc(feats)
    env["note"] = (
        f"{len(feats)} launches at their pads, from 7 days ago to 60 days out."
        if reached
        else "Launch Library did not answer, so this is not an empty schedule. It rate-limits "
        "anonymous callers and answers them with a body carrying no results."
    )
    env["reached"] = reached
    return env


@router.get("/api/space/launches")
async def launches(limit: int = Query(40, ge=1, le=50)) -> dict[str, Any]:
    return await cache.get_or_fetch(
        f"space:launches:{limit}", _LAUNCH_TTL_S, lambda: _launches(limit)
    )


# ── space weather ───────────────────────────────────────────────────────────
SWPC_KP = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json"
SWPC_XRAY = "https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json"
_SPACEWX_TTL_S = 300


def _kp_band(kp: float) -> str:
    # NOAA's own G-scale. G1 begins at Kp 5; below that it is quiet or unsettled.
    if kp >= 8:
        return "G4 severe"
    if kp >= 7:
        return "G3 strong"
    if kp >= 6:
        return "G2 moderate"
    if kp >= 5:
        return "G1 minor"
    if kp >= 4:
        return "unsettled"
    return "quiet"


async def _spacewx() -> dict[str, Any]:
    async def kp() -> dict[str, Any]:
        r = await get_client().get(SWPC_KP, timeout=30.0)
        r.raise_for_status()
        rows = r.json()
        last = rows[-1]
        value = float(last.get("estimated_kp") or last.get("kp_index") or 0)
        return {"kp": value, "band": _kp_band(value), "at": last.get("time_tag")}

    async def xray() -> dict[str, Any]:
        r = await get_client().get(SWPC_XRAY, timeout=30.0)
        r.raise_for_status()
        rows = r.json()
        if not rows:
            return {}
        f = rows[0]
        return {
            "current_class": f.get("current_class"),
            "max_class": f.get("max_class"),
            "max_time": f.get("max_time"),
            "satellite": f.get("satellite"),
        }

    got = await asyncio.gather(kp(), xray(), return_exceptions=True)
    out: dict[str, Any] = {"source": "NOAA SWPC", "tier": "sensor"}
    reached: list[str] = []
    failed: dict[str, str] = {}
    for name, value in zip(("kp", "xray"), got, strict=True):
        if isinstance(value, BaseException):
            failed[name] = str(value)[:160]
            continue
        reached.append(name)
        out[name] = value
    out["reached"] = reached
    out["failed"] = failed
    out["note"] = (
        "Kp drives GNSS accuracy and HF propagation, and the X-ray class drives HF blackouts. "
        "Both sit upstream of feeds already on this map."
    )
    return out


@router.get("/api/env/spaceweather")
async def spaceweather() -> dict[str, Any]:
    return await cache.get_or_fetch("env:spacewx", _SPACEWX_TTL_S, _spacewx)


# ── storm surge ─────────────────────────────────────────────────────────────
COOPS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
_SURGE_TTL_S = 900
_SURGE_CONCURRENCY = 6

# A short list of stations that matter: major port approaches and the places a
# surge closes something. Full CO-OPS is ~300 stations and polling all of them
# twice every fifteen minutes to watch harbours nobody is asking about would be
# 600 requests for no answer.
SURGE_STATIONS: list[tuple[str, str, float, float]] = [
    ("8518750", "New York, The Battery", 40.7006, -74.0142),
    ("8443970", "Boston", 42.3548, -71.0534),
    ("8534720", "Atlantic City", 39.3567, -74.4181),
    ("8574680", "Baltimore", 39.2669, -76.5786),
    ("8638610", "Sewells Point, Norfolk", 36.9467, -76.3300),
    ("8665530", "Charleston", 32.7803, -79.9251),
    ("8723214", "Virginia Key, Miami", 25.7317, -80.1617),
    ("8729108", "Panama City", 30.1523, -85.6669),
    ("8761724", "Grand Isle", 29.2633, -89.9567),
    ("8771450", "Galveston Pier 21", 29.3100, -94.7933),
    ("9410170", "San Diego", 32.7142, -117.1736),
    ("9414290", "San Francisco", 37.8063, -122.4659),
    ("9447130", "Seattle", 47.6026, -122.3393),
    ("9455920", "Anchorage", 61.2381, -149.8903),
    ("1612340", "Honolulu", 21.3067, -157.8670),
]


async def _station_surge(station: str) -> tuple[float, float, str] | None:
    """(observed, predicted, timestamp) at the latest common minute, metres."""
    base = {
        "application": "velocity-osint",
        "date": "latest",
        "datum": "MLLW",
        "station": station,
        "time_zone": "gmt",
        "units": "metric",
        "format": "json",
    }
    try:
        obs_r, pred_r = await asyncio.gather(
            get_client().get(COOPS, params={**base, "product": "water_level"}, timeout=30.0),
            get_client().get(COOPS, params={**base, "product": "predictions"}, timeout=30.0),
        )
        obs_rows = (obs_r.json() or {}).get("data") or []
        pred_rows = (pred_r.json() or {}).get("predictions") or []
    except Exception:  # noqa: BLE001 — one station must not fail the sweep
        return None
    if not obs_rows or not pred_rows:
        return None
    obs = obs_rows[-1]
    t = obs.get("t")
    # Compare the SAME minute. The prediction series is 6-minute; matching on
    # timestamp rather than taking the last of each is what stops this reporting
    # the tide's own slope as surge.
    pred = next((p for p in pred_rows if p.get("t") == t), None)
    if pred is None:
        return None
    try:
        return float(obs["v"]), float(pred["v"]), str(t)
    except (KeyError, TypeError, ValueError):
        return None


async def _surge() -> dict[str, Any]:
    sem = asyncio.Semaphore(_SURGE_CONCURRENCY)

    async def one(entry: tuple[str, str, float, float]) -> dict[str, Any] | None:
        sid, name, lat, lon = entry
        async with sem:
            got = await _station_surge(sid)
        if got is None:
            return None
        observed, predicted, t = got
        residual = observed - predicted
        return fg.point(
            f"surge:{sid}",
            lon,
            lat,
            {
                "kind": "surge",
                "style_kind": "surge",
                "station": sid,
                "name": name,
                "observed_m": round(observed, 3),
                "predicted_m": round(predicted, 3),
                "residual_m": round(residual, 3),
                "at": t,
            },
        )

    results = await asyncio.gather(*(one(e) for e in SURGE_STATIONS))
    feats = [f for f in results if f]
    env = fg.fc(feats)
    env["note"] = (
        f"{len(feats)} of {len(SURGE_STATIONS)} stations reporting. The value is observed water "
        "level MINUS the tide prediction for the same minute, so the tide is removed and what is "
        "left is surge."
    )
    return env


@router.get("/api/oceans/surge")
async def surge() -> dict[str, Any]:
    return await cache.get_or_fetch("oceans:surge", _SURGE_TTL_S, _surge)
