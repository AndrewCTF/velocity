"""GET /api/search?q=… — unified resolver.

Operator-grade muscle memory: one search field. The resolver tries, in order:
  1. Direct ICAO24 (6 hex) → aircraft:hex
  2. MMSI (9 digits) → vessel:mmsi
  3. lat,lon pair → POI
  4. Callsign / name substring against the observation store
  5. Chokepoint name fuzzy match

Returns a list of candidates the frontend can show inline and trigger a
camera fly-to + useSelection.select() on Enter.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, Query

from app.correlate.store import store
from app.correlate.types import Observation

router = APIRouter(tags=["search"])

LATLON_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*[,/\s]\s*(-?\d+(?:\.\d+)?)\s*$")
ICAO24_RE = re.compile(r"^[0-9a-f]{6}$", re.IGNORECASE)
MMSI_RE = re.compile(r"^\d{9}$")


SearchKind = Literal["aircraft", "vessel", "place", "chokepoint"]


def _result(
    kind: SearchKind,
    id: str,
    label: str,
    lon: float,
    lat: float,
    detail: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": kind, "id": id, "label": label, "lon": lon, "lat": lat}
    if detail:
        out["detail"] = detail
    return out


def _match_observations(q: str, kinds: set[str]) -> list[Observation]:
    """Substring match against the LATEST fix per entity.

    `store.latest()` is one observation per entity (newest), so results carry
    current positions and are already deduplicated — the old full-window scan
    returned the OLDEST matching fix first and burned O(buffer) per keystroke.
    Newest-first so the most recently active contacts rank on top."""
    qlower = q.lower()
    out = [
        o
        for o in store.latest()
        if o.emits_kind in kinds
        and any(
            qlower in str(v).lower()
            for k, v in o.attrs.items()
            if k in ("callsign", "icao24", "registration", "name", "mmsi", "operator")
            and v is not None
        )
    ]
    out.sort(key=lambda o: o.t, reverse=True)
    return out


_CHOKEPOINTS = [
    ("hormuz", "Strait of Hormuz", 56.5, 26.4),
    ("bab-el-mandeb", "Bab-el-Mandeb", 43.3, 12.5),
    ("suez", "Suez Canal", 32.5, 30.6),
    ("panama", "Panama Canal", -79.7, 9.1),
    ("malacca", "Strait of Malacca", 102.0, 3.5),
    ("taiwan-strait", "Taiwan Strait", 120.0, 24.0),
    ("korea-strait", "Korea Strait", 129.0, 34.5),
    ("gibraltar", "Strait of Gibraltar", -5.4, 36.0),
    ("bosphorus", "Bosphorus", 28.97, 41.05),
    ("dover", "Strait of Dover", 1.4, 51.05),
    ("skagerrak", "Skagerrak / Kattegat", 10.5, 57.0),
    ("sunda", "Sunda Strait", 105.4, -6.0),
    ("lombok", "Lombok Strait", 115.9, -8.5),
    ("bering", "Bering Strait", -169.5, 65.5),
    ("good-hope", "Cape of Good Hope", 18.5, -34.5),
    ("baltic-cables", "Baltic submarine-cable belt", 18.0, 57.5),
    ("red-sea-cables", "Red Sea cable corridor", 38.0, 20.0),
]


@router.get("/api/search")
async def search(
    q: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(10, ge=1, le=50),
) -> dict[str, Any]:
    q = q.strip()
    results: list[dict[str, Any]] = []

    # 1. lat,lon
    m = LATLON_RE.match(q)
    if m:
        lat = float(m.group(1))
        lon = float(m.group(2))
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            results.append(_result("place", f"poi:{lat},{lon}", f"{lat:.4f}, {lon:.4f}", lon, lat))
            return {"results": results}

    # 2. ICAO24 exact — O(1) via the latest-per-entity index.
    if ICAO24_RE.match(q):
        icao = q.lower()
        eid = f"aircraft:{icao}"
        live = store.latest_for(eid)
        if live:
            cs = live.attrs.get("callsign") or icao.upper()
            results.append(_result("aircraft", eid, f"{cs}  ({icao})", live.lon, live.lat))
        else:
            results.append(_result("aircraft", eid, icao.upper(), 0, 0, "icao24 — no recent fix"))

    # 3. MMSI exact — O(1) via the latest-per-entity index.
    if MMSI_RE.match(q):
        eid = f"vessel:{q}"
        live = store.latest_for(eid)
        if live:
            nm = live.attrs.get("name") or q
            results.append(_result("vessel", eid, f"{nm}  (MMSI {q})", live.lon, live.lat))
        else:
            results.append(_result("vessel", eid, f"MMSI {q}", 0, 0, "no recent fix"))

    # 4. Substring across latest fixes (callsign / registration / name).
    # Dedupe BEFORE applying the limit — the old code sliced first, so
    # duplicate ids consumed result slots and the response came up short.
    matches = _match_observations(q, kinds={"aircraft", "vessel"})
    seen: set[str] = {r["id"] for r in results}
    for o in matches:
        if len(results) >= limit:
            break
        if o.id in seen:
            continue
        seen.add(o.id)
        if o.emits_kind == "aircraft":
            label = (o.attrs.get("callsign") or o.attrs.get("icao24") or o.id)
            results.append(_result("aircraft", o.id, str(label), o.lon, o.lat))
        elif o.emits_kind == "vessel":
            label = (o.attrs.get("name") or o.attrs.get("mmsi") or o.id)
            results.append(_result("vessel", o.id, str(label), o.lon, o.lat))

    # 5. Chokepoints (fuzzy substring)
    qlower = q.lower()
    for cid, name, lon, lat in _CHOKEPOINTS:
        if qlower in cid or qlower in name.lower():
            results.append(_result("chokepoint", f"chokepoint:{cid}", name, lon, lat))

    return {"results": results[:limit]}
