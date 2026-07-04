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

from app import places
from app.config import get_settings
from app.correlate.store import store
from app.correlate.types import Observation
from app.upstream import cache, get_client

router = APIRouter(tags=["search"])

LATLON_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*[,/\s]\s*(-?\d+(?:\.\d+)?)\s*$")
ICAO24_RE = re.compile(r"^[0-9a-f]{6}$", re.IGNORECASE)
MMSI_RE = re.compile(r"^\d{9}$")


SearchKind = Literal["aircraft", "vessel", "place", "chokepoint", "airport", "port"]


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


def _place_display_name(rec: dict[str, Any]) -> str:
    """The plain place name from a places.search_places record's label.

    Labels are "CODE · Name" (airport) / "Port: Name" (port); strip the prefix
    so we can test an EXACT name match against the query."""
    label = str(rec.get("label") or "")
    if rec.get("kind") == "airport":
        return label.split(" · ", 1)[-1]
    return label[len("Port: "):] if label.startswith("Port: ") else label


def _split_place_hits(
    q: str, hits: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split place hits into (exact, fuzzy) for merge ranking.

    A hit is EXACT when the query equals an airport's IATA/ICAO code OR the
    place's name (case-insensitive). Everything else (a name-substring hit) is
    fuzzy. Exact hits outrank fuzzy vessel/aircraft substring matches; fuzzy
    place hits fall below the existing entity matches. Pure — unit-testable."""
    ql = q.strip().lower()
    exact: list[dict[str, Any]] = []
    fuzzy: list[dict[str, Any]] = []
    for rec in hits:
        iata = str(rec.get("iata") or "").lower()
        icao = str(rec.get("icao") or "").lower()
        code_match = rec.get("kind") == "airport" and ql in {c for c in (iata, icao) if c}
        name_match = _place_display_name(rec).lower() == ql
        (exact if (code_match or name_match) else fuzzy).append(rec)
    return exact, fuzzy


def _place_result(rec: dict[str, Any]) -> dict[str, Any]:
    """Normalize a places record into the SearchResult shape."""
    return _result(
        rec["kind"], rec["id"], rec["label"], rec["lon"], rec["lat"], rec.get("detail") or None
    )


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


# ── Faceted object search (the Gotham "Search for Palantir Objects" panel) ────
# Unlike the single-field resolver above, this searches the shared observation
# store by TYPE + KEYWORD + drawn-AOI bbox + time window, and returns per-type
# facet counts so the UI can populate its object-type dropdown with live counts.

# Keyword-searchable attribute fields (same identifiers the resolver matches on).
_SEARCH_FIELDS = ("callsign", "icao24", "registration", "name", "mmsi", "operator", "flag")


def _label_for(o: Observation) -> str:
    a = o.attrs
    if o.emits_kind == "aircraft":
        return str(a.get("callsign") or a.get("registration") or a.get("icao24") or o.id)
    if o.emits_kind == "vessel":
        return str(a.get("name") or (f"MMSI {a['mmsi']}" if a.get("mmsi") else o.id))
    return str(a.get("name") or a.get("label") or o.id)


def filter_objects(
    observations: list[Observation],
    *,
    type_: str | None,
    q: str | None,
    bbox: tuple[float, float, float, float] | None,  # (min_lon, min_lat, max_lon, max_lat)
    since_s: float | None,
    now: float,
    limit: int,
) -> dict[str, Any]:
    """Filter latest-per-entity observations by facets → results + type counts.

    Pure (no store / no clock) so it unit-tests without network. Type counts are
    computed over the geo+time+keyword-matched set BEFORE the type filter, so the
    UI's object-type dropdown shows how many of each type match the current AOI /
    window (Gotham shows live counts per object type). Newest-first, then limited.
    """
    qlower = q.lower().strip() if q else None

    def geo_ok(o: Observation) -> bool:
        if bbox is None:
            return True
        min_lon, min_lat, max_lon, max_lat = bbox
        if not (min_lat <= o.lat <= max_lat):
            return False
        if min_lon <= max_lon:  # normal box
            return min_lon <= o.lon <= max_lon
        return o.lon >= min_lon or o.lon <= max_lon  # antimeridian wrap

    def time_ok(o: Observation) -> bool:
        return since_s is None or o.t >= now - since_s

    def kw_ok(o: Observation) -> bool:
        if qlower is None:
            return True
        for k in _SEARCH_FIELDS:
            v = o.attrs.get(k)
            if v is not None and qlower in str(v).lower():
                return True
        return qlower in o.id.lower()

    # Pre-type match set → drives facet counts.
    matched = [o for o in observations if geo_ok(o) and time_ok(o) and kw_ok(o)]
    by_type: dict[str, int] = {}
    for o in matched:
        by_type[o.emits_kind] = by_type.get(o.emits_kind, 0) + 1

    typed = matched if (not type_ or type_ == "all") else [o for o in matched if o.emits_kind == type_]
    typed.sort(key=lambda o: o.t, reverse=True)

    results = [
        {
            "kind": o.emits_kind,
            "id": o.id,
            "label": _label_for(o),
            "lon": o.lon,
            "lat": o.lat,
            "t": o.t,
            "source": o.source,
        }
        for o in typed[:limit]
    ]
    return {"results": results, "count": len(typed), "by_type": by_type}


@router.get("/api/search/objects")
async def search_objects(
    type: str = Query("all", max_length=24),
    q: str | None = Query(None, max_length=64),
    min_lon: float | None = Query(None, ge=-180, le=180),
    min_lat: float | None = Query(None, ge=-90, le=90),
    max_lon: float | None = Query(None, ge=-180, le=180),
    max_lat: float | None = Query(None, ge=-90, le=90),
    since_s: float | None = Query(None, ge=0, le=7 * 24 * 3600),
    limit: int = Query(200, ge=1, le=2000),
) -> dict[str, Any]:
    """Faceted search over the live object store (aircraft/vessels/quakes/…).

    All facets optional: type (or 'all'), keyword q, drawn-AOI bbox, rolling
    window since_s. Returns matched results + per-type counts for the facet UI.
    """
    import time as _time

    bbox: tuple[float, float, float, float] | None = None
    if None not in (min_lon, min_lat, max_lon, max_lat):
        bbox = (float(min_lon), float(min_lat), float(max_lon), float(max_lat))  # type: ignore[arg-type]

    return filter_objects(
        store.latest(),
        type_=type,
        q=q,
        bbox=bbox,
        since_s=since_s,
        now=_time.time(),
        limit=limit,
    )


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

    # 3b. Local airport/port reference data. An EXACT code (LAX / EGLL) or exact
    # place NAME (Rotterdam) must rank ABOVE the fuzzy vessel/aircraft substring
    # matches below — otherwise q="LAX" surfaces ships named GALAXY and the
    # airport never appears, and q="Singapore" buries the port under ships named
    # SINGAPORE. Exact place hits go in here (above §4); fuzzy name-contains hits
    # go after the entity matches (below §5).
    place_exact, place_fuzzy = _split_place_hits(q, places.search_places(q, limit=limit))
    place_seen: set[str] = {r["id"] for r in results}
    for rec in place_exact:
        if rec["id"] in place_seen:
            continue
        place_seen.add(rec["id"])
        results.append(_place_result(rec))

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

    # 5b. Fuzzy place hits (name-contains, not an exact code/name) — below the
    # entity matches, still above the Nominatim fallback and dedup-guarded.
    for rec in place_fuzzy:
        if len(results) >= limit:
            break
        if rec["id"] in place_seen:
            continue
        place_seen.add(rec["id"])
        results.append(_place_result(rec))

    # 6. Nominatim forward-geocode — only if no results so far. Local airport/
    # port hits already populated `results`, so Nominatim (and any duplicate
    # place hit) is skipped whenever a reference place matched.
    if not results:
        s = get_settings()
        base = s.nominatim_url or ("" if s.commercial_mode else "https://nominatim.openstreetmap.org")
        if base:
            norm = q.lower()
            cache_key = f"nominatim:fwd:{norm}:{limit}"

            async def _nominatim_load() -> list[dict[str, Any]]:
                try:
                    r = await get_client().get(
                        f"{base.rstrip('/')}/search",
                        params={
                            "q": q,
                            "format": "jsonv2",
                            "limit": limit,
                            "addressdetails": "0",
                        },
                        headers={"User-Agent": "osint-console/0.1"},
                    )
                except Exception:  # noqa: BLE001
                    return []
                if r.status_code != 200:
                    return []
                try:
                    rows = r.json()
                except Exception:
                    return []
                out: list[dict[str, Any]] = []
                for row in rows if isinstance(rows, list) else []:
                    try:
                        rlat = float(row["lat"])
                        rlon = float(row["lon"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    label = row.get("display_name") or row.get("name") or q
                    out.append(
                        _result("place", f"poi:{rlat},{rlon}", str(label), rlon, rlat)
                    )
                return out

            cached = await cache.get_or_fetch(cache_key, 24 * 3600.0, _nominatim_load)
            # cache.get_or_fetch wraps the loader return in whatever the loader
            # returns, so cached is a list[dict] here.
            if isinstance(cached, list):
                results.extend(cached)
            elif isinstance(cached, dict) and "results" in cached:
                results.extend(cached["results"])

    return {"results": results[:limit]}
