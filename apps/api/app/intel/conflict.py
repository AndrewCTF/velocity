"""Real armed-conflict events — GDELT 2.0 Event Database (keyless).

This is ACTUAL conflict (battles, shelling, air strikes, bombings, mass
violence) with coordinates + actors, NOT the inference/warning fusion in
incidents.py. GDELT machine-codes world news every 15 min into CAMEO events;
we keep only the violent roots and serve them as GeoJSON for the globe.

Source: http://data.gdeltproject.org/gdeltv2/ — static files, no key, no quota.
The `api.gdeltproject.org` GEO endpoint is dead from datacenter egress (404);
the raw export CSVs on `data.gdeltproject.org` are not.

Honesty: GDELT geocodes the NEWS REPORT, not a verified ground truth — an event
is "N media mentions placed at this CAMEO location", so treat counts as
reporting intensity, not casualty counts. Actors are CAMEO-coded news entities.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import io
import zipfile
from typing import Any

from app.upstream import cache, get_client

# CAMEO event roots we treat as armed conflict.
#   19 = Fight (military force, artillery, air strikes, small arms, blockade)
#   20 = Use unconventional mass violence (mass killing, ethnic cleansing, WMD)
# Plus selected root-18 codes that are war/terror rather than ordinary crime.
_WAR_ROOTS = {"19", "20"}
_WAR_18_CODES = {"183", "1831", "1832", "1833", "185", "186"}  # bombings / assassination

# CAMEO event-code → human label (the violent subset).
_CAMEO: dict[str, str] = {
    "190": "military force", "191": "blockade", "192": "occupy territory",
    "193": "small-arms fight", "194": "artillery/tank fight", "195": "air strike",
    "196": "ceasefire violation", "200": "mass violence", "201": "mass expulsion",
    "202": "mass killing", "203": "ethnic cleansing", "204": "WMD use",
    "183": "suicide bombing", "1831": "suicide bombing", "1832": "vehicle bombing",
    "1833": "roadside bombing", "185": "assassination attempt", "186": "assassination",
}

# GDELT 2.0 export column indices (tab-separated, 61 cols).
_C_ID, _C_DAY = 0, 1
_C_A1, _C_A2 = 6, 16
_C_A1CC, _C_A2CC = 7, 17
_C_CODE, _C_ROOT = 26, 28
_C_GOLD, _C_MENT = 30, 31
_C_LAT, _C_LON = 56, 57
_C_URL = 60

_GDELT_BASE = "http://data.gdeltproject.org/gdeltv2"
_MAX_FEATURES = 1500
_TTL = 900.0  # 15 min — matches GDELT's publish cadence


def _is_war(code: str, root: str) -> bool:
    return root in _WAR_ROOTS or (root == "18" and code in _WAR_18_CODES)


def _label(code: str, root: str) -> str:
    return _CAMEO.get(code) or _CAMEO.get(root + "0") or (
        "mass violence" if root == "20" else "armed clash"
    )


async def _latest_ts() -> str:
    r = await get_client().get(f"{_GDELT_BASE}/lastupdate.txt", headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    for line in r.text.splitlines():
        if "export.CSV.zip" in line:
            url = line.split()[-1]
            return url.rsplit("/", 1)[-1].split(".")[0]  # e.g. 20260628050000
    raise ValueError("no export url in lastupdate")


def _recent_stamps(latest: str, n: int) -> list[str]:
    base = dt.datetime.strptime(latest, "%Y%m%d%H%M%S")
    return [(base - dt.timedelta(minutes=15 * i)).strftime("%Y%m%d%H%M%S") for i in range(n)]


async def _fetch_slice(ts: str) -> list[list[str]]:
    """Download + parse one 15-min export; return its conflict rows (or [])."""
    try:
        r = await get_client().get(
            f"{_GDELT_BASE}/{ts}.export.CSV.zip", headers={"User-Agent": "Mozilla/5.0"}
        )
        if r.status_code != 200:
            return []
        z = zipfile.ZipFile(io.BytesIO(r.content))
        raw = z.read(z.namelist()[0]).decode("utf-8", "replace")
    except (OSError, zipfile.BadZipFile, ValueError):
        return []
    out: list[list[str]] = []
    for line in raw.splitlines():
        c = line.split("\t")
        if len(c) < 61:
            continue
        if _is_war(c[_C_CODE], c[_C_ROOT]):
            out.append(c)
    return out


async def conflict_events(hours: int = 6) -> dict[str, Any]:
    """Recent armed-conflict events as a GeoJSON FeatureCollection."""
    key = f"conflict:gdelt:{hours}"

    async def load() -> dict[str, Any]:
        try:
            latest = await _latest_ts()
        except Exception as e:  # noqa: BLE001 — degrade, never 500 the layer
            return {"type": "FeatureCollection", "features": [], "unavailable": True, "note": str(e)[:120]}
        stamps = _recent_stamps(latest, max(1, hours * 4))
        sem = asyncio.Semaphore(6)

        async def guarded(ts: str) -> list[list[str]]:
            async with sem:
                return await _fetch_slice(ts)

        slices = await asyncio.gather(*[guarded(s) for s in stamps])

        seen: set[str] = set()
        features: list[dict[str, Any]] = []
        for rows in slices:
            for c in rows:
                eid = c[_C_ID]
                if eid in seen:
                    continue
                seen.add(eid)
                try:
                    lat, lon = float(c[_C_LAT]), float(c[_C_LON])
                except ValueError:
                    continue
                if lat == 0.0 and lon == 0.0:
                    continue
                try:
                    ment = int(c[_C_MENT])
                except ValueError:
                    ment = 1
                a1 = (c[_C_A1] or "").title() or "Unknown"
                a2 = (c[_C_A2] or "").title() or "Unknown"
                what = _label(c[_C_CODE], c[_C_ROOT])
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {
                        "kind": "conflict",
                        "source": "gdelt",
                        "id": eid,
                        "actor1": a1,
                        "actor2": a2,
                        "event": what,
                        "code": c[_C_CODE],
                        "root": c[_C_ROOT],
                        "mentions": ment,
                        "day": c[_C_DAY],
                        "url": c[_C_URL],
                        # Label the map draws: "RUSSIA → UKRAINE · air strike (12x)".
                        "label": f"{a1} → {a2} · {what} ({ment}x)",
                    },
                })
        # Strongest reporting first; cap.
        features.sort(key=lambda f: f["properties"]["mentions"], reverse=True)
        features = features[:_MAX_FEATURES]
        return {
            "type": "FeatureCollection",
            "features": features,
            "generated_at": latest,
            "window_hours": hours,
            "count": len(features),
            "source": "GDELT 2.0 Event Database (keyless)",
            "caveat": "Counts = media reporting intensity at the CAMEO-coded location, "
            "not verified casualties.",
        }

    return await cache.get_or_fetch(key, _TTL, load)
