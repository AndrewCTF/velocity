"""Airport + seaport + base reference data: loader, unified search, bbox
GeoJSON, and per-entity detail lookups.

Curated keyless datasets ship in ``app/data/``:

- ``airports.json`` — ~5.3k rows ``{name, iata, icao, lat, lon, type, iso,
  elevation_ft, municipality, scheduled_service, military}`` (type is
  'large' | 'medium'). IATA is the 3-letter code (LAX), ICAO the 4-letter
  (KLAX / EGLL).
- ``airports_detail.json`` — keyed by ICAO ident, large+medium only:
  ``{runways: [...], frequencies: [...]}``. Loaded lazily, never by the bbox
  path (keeps ``/api/places/airports`` fast).
- ``ports.json`` — ~3.8k WPI rows ``{name, lat, lon, wpi}``.
- ``ports_detail.json`` — keyed by WPI (string): harbor/repair/depth fields.
- ``bases.json`` — ~7.2k rows ``{name, lat, lon, branch}`` (branch is
  'air' | 'naval' | 'army'); no stable upstream id, so entity ids are a
  content hash of name+coords (``_base_id``).

The single-field ``/api/search`` resolver was burying airports/ports under
fuzzy VESSEL-NAME substring hits (q="Singapore" → ships named SINGAPORE;
q="LAX" → GALAXY). ``search_places`` ranks a place-CODE match first so those
public reference points resolve; ``bbox_features`` powers the map overlays.

ID CONTRACT (2026-07-11, coordinated with the frontend adapters): a clicked
map feature becomes a Cesium entity id from ``PollGeoJsonAdapter``'s
"prefer the upstream Feature.id, else a content hash" rule
(``globe/adapters/PollGeoJsonAdapter.ts`` — checks ``f.id != null`` BEFORE
falling back to ``identityKey(props)``, which does not recognize
iata/icao/wpi). ``bbox_features`` therefore sets the GeoJSON Feature's
top-level ``id`` explicitly — never relies on the fallback hash — so a
clicked airport/port/base entity carries the SAME id ``/api/entity/{id}``
expects: ``airport:{iata-or-icao}``, ``port:{wpi}``, ``base:{content-hash}``.
This matches ``_airport_record``'s id (``search_places``/``/api/search``
results resolve to the identical entity id a map click produces).

All files load ONCE (module-level ``functools.lru_cache``); the JSON is a few
MB at most and never changes at runtime.
"""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

_DATA = Path(__file__).resolve().parent / "data"

PlaceKind = Literal["airport", "port", "base"]


@lru_cache(maxsize=1)
def airports() -> list[dict[str, Any]]:
    """The airport rows, loaded once. Keys: name, iata, icao, lat, lon, type, iso,
    elevation_ft, municipality, scheduled_service, military."""
    with (_DATA / "airports.json").open(encoding="utf-8") as fh:
        rows = json.load(fh)
    return rows if isinstance(rows, list) else []


@lru_cache(maxsize=1)
def ports() -> list[dict[str, Any]]:
    """The seaport rows, loaded once. Keys: name, lat, lon, wpi."""
    with (_DATA / "ports.json").open(encoding="utf-8") as fh:
        rows = json.load(fh)
    return rows if isinstance(rows, list) else []


@lru_cache(maxsize=1)
def bases() -> list[dict[str, Any]]:
    """The military-base rows, loaded once. Keys: name, lat, lon, branch."""
    with (_DATA / "bases.json").open(encoding="utf-8") as fh:
        rows = json.load(fh)
    return rows if isinstance(rows, list) else []


@lru_cache(maxsize=1)
def airports_detail() -> dict[str, dict[str, Any]]:
    """Per-ICAO runway/frequency detail (large+medium only). Loaded lazily —
    only entity enrichment touches this, never the bbox map-overlay path."""
    with (_DATA / "airports_detail.json").open(encoding="utf-8") as fh:
        rows = json.load(fh)
    return rows if isinstance(rows, dict) else {}


@lru_cache(maxsize=1)
def ports_detail() -> dict[str, dict[str, Any]]:
    """Per-WPI harbor/repair/depth detail, keyed by WPI string."""
    with (_DATA / "ports_detail.json").open(encoding="utf-8") as fh:
        rows = json.load(fh)
    return rows if isinstance(rows, dict) else {}


@lru_cache(maxsize=1)
def _airport_index() -> dict[str, dict[str, Any]]:
    """IATA/ICAO (uppercased) -> airport row, for O(1) code lookup."""
    idx: dict[str, dict[str, Any]] = {}
    for a in airports():
        iata = str(a.get("iata") or "").strip().upper()
        icao = str(a.get("icao") or "").strip().upper()
        if iata:
            idx.setdefault(iata, a)
        if icao:
            idx.setdefault(icao, a)
    return idx


@lru_cache(maxsize=1)
def _port_index() -> dict[str, dict[str, Any]]:
    """WPI (string) -> port row, for O(1) lookup."""
    return {str(p["wpi"]): p for p in ports() if p.get("wpi") is not None}


def airport_by_code(code: str) -> dict[str, Any] | None:
    """Resolve an airport by IATA or ICAO code (case-insensitive, either)."""
    return _airport_index().get(str(code or "").strip().upper())


def airport_detail(icao: str) -> dict[str, Any] | None:
    """Runways/frequencies for an ICAO ident, or None if not in the detail set
    (small/non-scheduled airports outside the large+medium coverage)."""
    return airports_detail().get(str(icao or "").strip().upper())


def port_by_wpi(wpi: str) -> dict[str, Any] | None:
    """Resolve a port row by its World Port Index number."""
    return _port_index().get(str(wpi or "").strip())


def port_detail(wpi: str) -> dict[str, Any] | None:
    """Harbor/repair/depth fields for a WPI, or None if WPI carries none."""
    return ports_detail().get(str(wpi or "").strip())


def _base_id(b: dict[str, Any]) -> str:
    """Stable content-hash id for a base row. bases.json (Wikidata SPARQL, no
    per-row upstream id) has nothing to key on but name+coords; hashing them
    is deterministic across process restarts as long as the row itself is
    unchanged, which is the same stability guarantee ``ports.json``'s old
    slug-index id had — see the module docstring's ID CONTRACT note."""
    name = str(b.get("name") or "")
    lat = float(b.get("lat") or 0.0)
    lon = float(b.get("lon") or 0.0)
    raw = f"{name}|{lat:.4f}|{lon:.4f}".encode()
    return hashlib.md5(raw).hexdigest()[:16]


# ── record shaping ───────────────────────────────────────────────────────────


def _airport_code(a: dict[str, Any]) -> str:
    """Display code: IATA if present (LAX), else ICAO (OMNK)."""
    return str(a.get("iata") or a.get("icao") or "").strip()


def _airport_record(a: dict[str, Any]) -> dict[str, Any]:
    iata = str(a.get("iata") or "").strip()
    icao = str(a.get("icao") or "").strip()
    code = _airport_code(a)
    name = str(a.get("name") or code or "Airport")
    atype = str(a.get("type") or "")
    iso = str(a.get("iso") or "")
    detail_bits = [b for b in (f"{atype.capitalize()} airport" if atype else "", iso) if b]
    return {
        "kind": "airport",
        "id": f"airport:{code or name}",
        "label": f"{code} · {name}" if code else name,
        "lat": float(a["lat"]),
        "lon": float(a["lon"]),
        "iata": iata,
        "icao": icao,
        "detail": " · ".join(detail_bits),
    }


def _port_record(p: dict[str, Any], idx: int) -> dict[str, Any]:
    name = str(p.get("name") or "Port")
    wpi = p.get("wpi")
    if wpi:
        rec_id = f"port:{wpi}"
    else:
        # Backward-compat fallback for any row that somehow lacks a WPI
        # (shouldn't happen post-2026-07-11 WPI rebuild, but never crash).
        slug = "".join(ch if ch.isalnum() else "-" for ch in name.lower()).strip("-")
        rec_id = f"port:{slug}-{idx}"
    return {
        "kind": "port",
        "id": rec_id,
        "label": f"Port: {name}",
        "lat": float(p["lat"]),
        "lon": float(p["lon"]),
        "iata": "",
        "icao": "",
        "wpi": str(wpi) if wpi else "",
        "detail": "Seaport",
    }


# ── unified search ───────────────────────────────────────────────────────────


def search_places(q: str, limit: int = 8) -> list[dict[str, Any]]:
    """Rank airports + ports for a free-text query.

    Tiers (each de-duped by record id, higher tier wins):
      1. EXACT airport code match — IATA (3) or ICAO (4), case-insensitive.
      2. Name ``startswith(q)`` — airports first, then ports.
      3. Name ``contains(q)`` — airports first, then ports.
    """
    ql = q.strip()
    if not ql:
        return []
    qlow = ql.lower()

    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _push(rec: dict[str, Any]) -> None:
        if rec["id"] in seen:
            return
        seen.add(rec["id"])
        out.append(rec)

    aps = airports()
    pos = ports()

    # Tier 1 — exact IATA/ICAO code. A 3-char query can only be IATA; a 4-char
    # query can only be ICAO — but checking both is harmless (they never collide
    # on length) and keeps the branch simple.
    for a in aps:
        iata = str(a.get("iata") or "").strip().lower()
        icao = str(a.get("icao") or "").strip().lower()
        if (iata and iata == qlow) or (icao and icao == qlow):
            _push(_airport_record(a))

    # Tier 2 — name startswith (airports, then ports).
    for a in aps:
        if str(a.get("name") or "").lower().startswith(qlow):
            _push(_airport_record(a))
    for i, p in enumerate(pos):
        if str(p.get("name") or "").lower().startswith(qlow):
            _push(_port_record(p, i))

    # Tier 3 — name contains (airports, then ports).
    for a in aps:
        if qlow in str(a.get("name") or "").lower():
            _push(_airport_record(a))
    for i, p in enumerate(pos):
        if qlow in str(p.get("name") or "").lower():
            _push(_port_record(p, i))

    return out[:limit]


# ── bbox GeoJSON ─────────────────────────────────────────────────────────────

# type-priority for the airport keep-order when a bbox overflows `limit`.
_ATYPE_RANK = {"large": 0, "medium": 1}


def bbox_features(
    kind: PlaceKind,
    minlon: float,
    minlat: float,
    maxlon: float,
    maxlat: float,
    limit: int,
    large_only: bool = False,
) -> dict[str, Any]:
    """GeoJSON FeatureCollection of airports, ports, OR bases inside a bbox.

    Airport feature props: ``{name, iata, icao, kind:"airport", atype}``.
    Port feature props: ``{name, kind:"port", wpi}``.
    Base feature props: ``{name, kind:"base", branch}``.
    Geometry is a Point [lon, lat]. When airports overflow ``limit``, large
    airports are kept before medium (stable within each rank) so a
    zoomed-out view still shows the majors.

    Every feature carries a top-level GeoJSON ``id`` — ``airport:{code}``,
    ``port:{wpi}``, ``base:{hash}`` — matching what ``/api/entity/{id}``
    resolves (see module docstring, ID CONTRACT). ``PollGeoJsonAdapter``
    prefers this ``Feature.id`` over its content-hash fallback, so a map
    click and a search-result click land on the identical entity id.
    """

    def _in_box(lat: float, lon: float) -> bool:
        if not (minlat <= lat <= maxlat):
            return False
        if minlon <= maxlon:  # normal box
            return minlon <= lon <= maxlon
        return lon >= minlon or lon <= maxlon  # antimeridian wrap

    features: list[dict[str, Any]] = []

    if kind == "airport":
        rows = [
            a
            for a in airports()
            if (not large_only or str(a.get("type") or "") == "large")
            and _in_box(float(a["lat"]), float(a["lon"]))
        ]
        if len(rows) > limit:
            # Stable sort by type rank keeps large before medium; Python's sort
            # is stable so original order is preserved within each rank.
            rows = sorted(rows, key=lambda a: _ATYPE_RANK.get(str(a.get("type") or ""), 2))
        for a in rows[:limit]:
            code = _airport_code(a) or str(a.get("name") or "")
            features.append(
                {
                    "type": "Feature",
                    "id": f"airport:{code}",
                    "geometry": {
                        "type": "Point", "coordinates": [float(a["lon"]), float(a["lat"])],
                    },
                    "properties": {
                        "name": a.get("name") or "",
                        "iata": a.get("iata") or "",
                        "icao": a.get("icao") or "",
                        "kind": "airport",
                        "atype": a.get("type") or "",
                    },
                }
            )
    elif kind == "port":
        rows = [p for p in ports() if _in_box(float(p["lat"]), float(p["lon"]))]
        for p in rows[:limit]:
            wpi = p.get("wpi")
            features.append(
                {
                    "type": "Feature",
                    "id": f"port:{wpi}" if wpi else f"port:{p.get('name') or ''}",
                    "geometry": {
                        "type": "Point", "coordinates": [float(p["lon"]), float(p["lat"])],
                    },
                    "properties": {
                        "name": p.get("name") or "",
                        "kind": "port",
                        "wpi": str(wpi) if wpi else "",
                    },
                }
            )
    else:  # base
        rows = [b for b in bases() if _in_box(float(b["lat"]), float(b["lon"]))]
        for b in rows[:limit]:
            features.append(
                {
                    "type": "Feature",
                    "id": f"base:{_base_id(b)}",
                    "geometry": {
                        "type": "Point", "coordinates": [float(b["lon"]), float(b["lat"])],
                    },
                    "properties": {
                        "name": b.get("name") or "",
                        "kind": "base",
                        "branch": b.get("branch") or "",
                    },
                }
            )

    return {"type": "FeatureCollection", "features": features}


if __name__ == "__main__":
    # Self-check (no network) — must exit 0.
    lax = search_places("LAX")
    assert lax, "LAX resolved nothing"
    assert lax[0]["kind"] == "airport", lax[0]
    assert lax[0]["iata"] == "LAX", lax[0]
    assert abs(lax[0]["lat"] - 33.94) < 0.05, lax[0]

    egll = search_places("EGLL")
    assert egll and egll[0]["icao"] == "EGLL", egll[:1]

    fc = bbox_features("port", 4.0, 51.0, 5.0, 52.0, 2000)
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) >= 1, "no ports in Rotterdam bbox"
    assert fc["features"][0]["id"].startswith("port:")

    kjfk = airport_by_code("KJFK")
    assert kjfk is not None and kjfk["icao"] == "KJFK", kjfk
    assert airport_detail("KJFK") is not None

    rotterdam = port_by_wpi("31140")
    assert rotterdam is not None and "Rotterdam" in str(rotterdam["name"]), rotterdam
    assert port_detail("31140") is not None

    fc_base = bbox_features("base", -180.0, -90.0, 180.0, 90.0, 10)
    assert fc_base["features"], "no bases at all"
    assert fc_base["features"][0]["id"].startswith("base:")

    print(
        f"OK airports={len(airports())} ports={len(ports())} bases={len(bases())} "
        f"LAX@{lax[0]['lat']:.2f},{lax[0]['lon']:.2f} "
        f"rotterdam_bbox_ports={len(fc['features'])}"
    )
