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
- ``osm_military.json.gz`` — ~259k OpenStreetMap military features (bunkers,
  trenches, barracks, checkpoints, ranges, landuse...), columnar, built by
  ``scripts/build_osm_military.py``; expanded lazily by ``osm_military()`` on
  the first OSM-military bbox, entity or 3+ char search (~0.4 s, ~200 MB).

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
import zlib
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
def infrastructure() -> list[dict[str, Any]]:
    """Unified facility rows (power/nuclear, water, datacenters, telecom hubs,
    ground stations, telescopes, launch facilities). Keys: id, category,
    subcategory, name, lat, lon, source + per-source extras. Built by
    scripts/build_places_data.py; empty list when the file hasn't been built
    (honest degrade, never an error)."""
    path = _DATA / "infrastructure.json"
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as fh:
        rows = json.load(fh)
    return rows if isinstance(rows, list) else []


@lru_cache(maxsize=1)
def military() -> list[dict[str, Any]]:
    """Military installation rows (MIRTA + Wikidata garrisons/training areas).
    Same shape as infrastructure(); categories: military_installation,
    garrison, training."""
    path = _DATA / "military.json"
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as fh:
        rows = json.load(fh)
    return rows if isinstance(rows, list) else []


_OSM_TYPES = ("node", "way", "relation")


@lru_cache(maxsize=1)
def osm_military() -> list[dict[str, Any]]:
    """OpenStreetMap military features (~259k: bunkers, trenches, barracks,
    checkpoints, ranges, landuse...), expanded from the columnar
    ``osm_military.json.gz`` built by scripts/build_osm_military.py. Rows share
    the facility shape; id is ``osm-{n|w|r}{osm id}``. Empty fields are dropped,
    never filled in. Empty list when the file is absent (honest degrade)."""
    path = _DATA / "osm_military.json.gz"
    if not path.exists():
        return []
    import gzip

    with gzip.open(path, "rt", encoding="utf-8") as fh:
        d = json.load(fh)
    cats, labels, sts = d["categories"], d["category_labels"], d["statuses"]
    ctys, regs, plcs, ops = d["countries"], d["regions"], d["places"], d["operators"]
    rows: list[dict[str, Any]] = []
    for i in range(len(d["lat"])):
        otype = _OSM_TYPES[d["ot"][i]]
        oid = d["oid"][i]
        r: dict[str, Any] = {
            "id": f"osm-{otype[0]}{oid}",
            "category": cats[d["cat"][i]],
            "subcategory": labels[d["cat"][i]],
            "name": d["nm"][i],
            "lat": d["lat"][i],
            "lon": d["lon"][i],
            "country": ctys[d["cty"][i]],
            "region": regs[d["reg"][i]],
            "place": plcs[d["np"][i]],
            "operator": ops[d["op"][i]],
            "status": "" if d["st"][i] == 0 else sts[d["st"][i]],
            "start_year": d["yr"][i] or None,
            "osm_url": f"https://www.openstreetmap.org/{otype}/{oid}",
            "source": "openstreetmap",
        }
        rows.append({k: v for k, v in r.items() if v not in ("", None)})
    _assign_osm_branches(rows)
    return rows


# Branch keywords, checked naval → air → army on the lowercased name+operator.
# Only explicit service words: a name that says none of them gets NO branch.
_BRANCH_WORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("naval", ("naval", "navy", "marinebasis", "marinestützpunkt", "base navale",
               "base naval", "marina militare", "военно-морск", "海军", "海軍", "해군")),
    ("air", ("air base", "airbase", "air force", " afb", "air station", "fliegerhorst",
             "luftwaffe", "base aérienne", "base aerea", "base aérea", "aeronautica militare",
             "lotnisko wojskowe", "авиабаз", "空军", "空軍", "航空基地", "공군")),
    ("army", ("army", "kaserne", "caserne", "barracks", "garrison", "cuartel", "quartel",
              "kasarna", "koszary", "陆军", "陸軍", "육군")),
)
_BRANCH_NEAR_DEG = 0.03  # ~3 km: same installation as a Wikidata base point


def _assign_osm_branches(rows: list[dict[str, Any]]) -> None:
    """Give OSM bases/airfields a service branch (air|naval|army) from data,
    never a guess: airfield is air by its OSM tag; a base takes the branch of a
    Wikidata base within ~3 km, else an explicit service word in its name or
    operator. ``branch_basis`` says which. Anything else stays unbranched."""
    near: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for b in bases():
        near.setdefault((int(b["lat"] // 0.1), int(b["lon"] // 0.1)), []).append(b)
    for r in rows:
        cat = r["category"]
        if cat == "airfield":
            r["branch"], r["branch_basis"] = "air", "OSM military=airfield"
            continue
        if cat != "base":
            continue
        cy, cx = int(r["lat"] // 0.1), int(r["lon"] // 0.1)
        best, best_d = None, _BRANCH_NEAR_DEG
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for b in near.get((cy + dy, cx + dx), ()):
                    d = max(abs(b["lat"] - r["lat"]), abs(b["lon"] - r["lon"]))
                    if d <= best_d:
                        best, best_d = b, d
        if best is not None and best.get("branch") in ("air", "naval", "army"):
            r["branch"], r["branch_basis"] = best["branch"], f"Wikidata base nearby: {best['name']}"
            continue
        text = f"{r.get('name', '')} {r.get('operator', '')}".lower()
        for branch, words in _BRANCH_WORDS:
            if any(w in text for w in words):
                r["branch"], r["branch_basis"] = branch, "service named in OSM name/operator"
                break


# OSM marks a site out of use with a lifecycle tag (disused:/abandoned:/ruins);
# a site with none is presumed in use. That is the whole basis of the filter.
_INACTIVE_STATUSES = frozenset({"disused", "abandoned", "ruins"})


def _status_class(r: dict[str, Any]) -> str:
    return "inactive" if r.get("status") in _INACTIVE_STATUSES else "active"


@lru_cache(maxsize=1)
def _osm_military_index() -> dict[str, dict[str, Any]]:
    return {r["id"]: r for r in osm_military()}


@lru_cache(maxsize=1)
def _facility_index() -> dict[str, dict[str, Any]]:
    """facility id -> row, over infrastructure() + military()."""
    idx: dict[str, dict[str, Any]] = {}
    for r in infrastructure() + military():
        rid = str(r.get("id") or "")
        if rid:
            idx.setdefault(rid, r)
    return idx


def facility_by_id(fid: str) -> dict[str, Any] | None:
    """Resolve an infrastructure/military row by its dataset id (the part
    after the ``facility:``/``military:`` entity-id prefix)."""
    fid = str(fid or "").strip()
    if fid.startswith("osm-"):  # separate index: a MIRTA click never loads 259k OSM rows
        return _osm_military_index().get(fid)
    return _facility_index().get(fid)


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


def approach_capability(detail: dict[str, Any] | None) -> dict[str, Any]:
    """Derived landing-capability tier for ANY airport, worldwide — the honest
    non-US counterpart to the US-only FAA NASR CAT I/II/III rating.

    Sources actually on record (never guessed):
      - ``ils_category*`` per runway end — FAA NASR, US only, the only place a
        CAT I/II/III string may come from.
      - ``ils_present`` — OurAirports navaids.csv, global, presence-only.
      - runway ``lighted`` / ``length_ft`` — OurAirports, global.

    Output is ALWAYS labeled derived (``approach_capability_derived: true``)
    with the exact basis facts listed, so the UI can render it visually
    distinct from a measured NASR category. Tiers:
      - "precision (ILS present)" — an ILS exists on record.
      - "non-precision/visual (lighted)" — no ILS on record, lighted runway.
      - "visual only (no ILS/lighting on record)" — neither on record.
    Absence of data lowers the tier honestly; it never invents a CAT level.
    """
    detail = detail or {}
    runways = [r for r in detail.get("runways") or [] if not r.get("closed")]
    cats = sorted(
        {
            str(c)
            for r in runways
            for c in (r.get("ils_category_le"), r.get("ils_category_he"))
            if c
        }
    )
    ils = bool(detail.get("ils_present") or cats)
    lighted = any(r.get("lighted") for r in runways)
    lengths = [r.get("length_ft") for r in runways if isinstance(r.get("length_ft"), (int, float))]
    basis: list[str] = []
    if cats:
        basis.append(f"FAA NASR ILS categories on record: {', '.join(cats)}")
    elif ils:
        basis.append("ILS navaid on record (OurAirports navaids.csv, category unknown)")
    else:
        basis.append("no ILS on record")
    basis.append("lighted runway" if lighted else "no lighted runway on record")
    if lengths:
        basis.append(f"longest runway {max(lengths)} ft")
    if ils:
        tier = "precision (ILS present)"
    elif lighted:
        tier = "non-precision/visual (lighted)"
    else:
        tier = "visual only (no ILS/lighting on record)"
    return {
        "approach_capability": tier,
        "approach_capability_derived": True,
        "approach_capability_basis": basis,
        "ils_present": ils,
    }


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

    # Tier 4 — named OSM military features (startswith, then contains), after
    # every airport/port so a base never buries the airport it shares a name with.
    if len(out) < limit and len(qlow) >= 3:
        named = _osm_military_named()
        for pass_contains in (False, True):
            for low, r in named:
                if len(out) >= limit:
                    break
                if low.startswith(qlow) if not pass_contains else qlow in low:
                    _push(_osm_military_record(r))

    return out[:limit]


@lru_cache(maxsize=1)
def _osm_military_named() -> list[tuple[str, dict[str, Any]]]:
    return [(r["name"].lower(), r) for r in osm_military() if r.get("name")]


def _osm_military_record(r: dict[str, Any]) -> dict[str, Any]:
    where = r.get("place") or r.get("region") or ""
    bits = [r.get("subcategory") or "", where, r.get("country") or ""]
    return {
        "kind": "place",
        "id": f"military:{r['id']}",
        "label": f"Military: {r['name']}",
        "lat": float(r["lat"]),
        "lon": float(r["lon"]),
        "iata": "",
        "icao": "",
        "detail": " · ".join(b for b in bits if b),
    }


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

    features: list[dict[str, Any]] = []

    if kind == "airport":
        rows = _rows_in_box("airport", minlon, minlat, maxlon, maxlat)
        if large_only:
            rows = [a for a in rows if str(a.get("type") or "") == "large"]
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
        rows = _rows_in_box("port", minlon, minlat, maxlon, maxlat)
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
        rows = _rows_in_box("base", minlon, minlat, maxlon, maxlat)
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


# ── coarse spatial index ─────────────────────────────────────────────────────
#
# Every /api/places/* request used to scan its whole dataset in Python and filter
# by bbox (and, for infrastructure, by category too). That is ~5.3k airports,
# ~3.8k ports, ~7.2k bases and ~125k facility rows, per request, on the event
# loop. It matters because the frontend re-fires these on every camera settle
# and the nine generated infra.* layers all share ONE endpoint: measured
# 2026-07-27, /api/places/infrastructure alone took 144 requests in 74 seconds,
# each a full pass over the same rows for a different category.
#
# A 10-degree lat/lon bucket index (648 cells) built once per (dataset,
# category) turns that into "visit the handful of cells the viewport touches".
# Rows are still filtered exactly inside the visited cells, so results are
# identical — this only skips rows that could not have matched.
_GRID_DEG = 10.0


def _cell(lat: float, lon: float) -> tuple[int, int]:
    return (int((lat + 90.0) // _GRID_DEG), int((lon + 180.0) // _GRID_DEG))


def _cells_for_box(
    minlon: float, minlat: float, maxlon: float, maxlat: float
) -> list[tuple[int, int]]:
    """Every grid cell a bbox touches, antimeridian-aware."""
    y0 = int((max(-90.0, minlat) + 90.0) // _GRID_DEG)
    y1 = int((min(90.0, maxlat) + 90.0) // _GRID_DEG)
    if minlon <= maxlon:
        spans = [(minlon, maxlon)]
    else:  # wrapped box → two spans
        spans = [(minlon, 180.0), (-180.0, maxlon)]
    out: list[tuple[int, int]] = []
    for lo, hi in spans:
        x0 = int((max(-180.0, lo) + 180.0) // _GRID_DEG)
        x1 = int((min(180.0, hi) + 180.0) // _GRID_DEG)
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                out.append((y, x))
    return out


@lru_cache(maxsize=64)
def _grid(
    key: str, category: str | None = None, status: str | None = None
) -> dict[tuple[int, int], list[dict[str, Any]]]:
    """Bucket one dataset (optionally one category of it) by 10-degree cell.

    Cached per (key, category); the datasets themselves are already
    ``lru_cache``d and never change at runtime, so this is built once.
    """
    if key == "airport":
        rows = airports()
    elif key == "port":
        rows = ports()
    elif key == "base":
        rows = bases()
    elif key == "infrastructure":
        rows = infrastructure()
    elif key == "military":
        rows = military()
    elif key == "osm_military":
        rows = osm_military()
    else:  # pragma: no cover — callers pass a literal
        rows = []
    grid: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for r in rows:
        if category is not None:
            if str(r.get("category") or "") != category:
                # `nuclear` is a filter over power rows, not a stored category.
                if not (category == "nuclear" and r.get("nuclear")):
                    continue
        if status is not None and _status_class(r) != status:
            continue
        try:
            lat, lon = float(r["lat"]), float(r["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            continue
        grid.setdefault(_cell(lat, lon), []).append(r)
    return grid


def _rows_in_box(
    key: str,
    minlon: float,
    minlat: float,
    maxlon: float,
    maxlat: float,
    category: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    """Rows whose lat/lon fall inside the bbox, visiting only the cells it touches."""

    def _in_box(lat: float, lon: float) -> bool:
        if not (minlat <= lat <= maxlat):
            return False
        if minlon <= maxlon:
            return minlon <= lon <= maxlon
        return lon >= minlon or lon <= maxlon  # antimeridian wrap

    grid = _grid(key, category, status)
    out: list[dict[str, Any]] = []
    for c in _cells_for_box(minlon, minlat, maxlon, maxlat):
        bucket = grid.get(c)
        if not bucket:
            continue
        for r in bucket:
            if _in_box(float(r["lat"]), float(r["lon"])):
                out.append(r)
    return out


def facility_bbox_features(
    dataset: Literal["infrastructure", "military", "osm_military"],
    minlon: float,
    minlat: float,
    maxlon: float,
    maxlat: float,
    limit: int,
    category: str | None = None,
    status: Literal["active", "inactive"] | None = None,
    thin: bool = False,
) -> dict[str, Any]:
    """GeoJSON FeatureCollection of facility/military rows inside a bbox,
    optionally filtered to one ``category``. Feature.id = ``facility:{id}`` /
    ``military:{id}`` per the ID CONTRACT (module docstring) so map clicks
    resolve through ``/api/entity/{id}`` and the selection AI brief."""

    # The grid is keyed by (dataset, category), so the category filter is applied
    # ONCE at index build instead of on every row of every request — which is the
    # whole cost when nine category layers share this endpoint.
    rows = _rows_in_box(dataset, minlon, minlat, maxlon, maxlat, category or None, status)
    total = len(rows)
    if thin:
        rows = _thin(rows, minlon, minlat, maxlon, maxlat)
    if len(rows) > limit:
        # Over the cap, keep a hash-stable subset instead of the first cells in
        # grid order (which emptied the south/east of a dense view). A row kept
        # in a wide view is kept in every narrower view containing it, so
        # zooming in only adds markers, never swaps them.
        rows = sorted(rows, key=lambda r: zlib.crc32(str(r.get("id")).encode()))[:limit]
    prefix = "facility" if dataset == "infrastructure" else "military"
    features: list[dict[str, Any]] = []
    for r in rows:
        try:
            lat, lon = float(r["lat"]), float(r["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        props = {
            "name": r.get("name") or "",
            "kind": prefix,
            "category": r.get("category") or "",
            "subcategory": r.get("subcategory") or "",
        }
        extras = (
            "fuel",
            "capacity_mw",
            "operator",
            "component",
            "operational_status",
            "status",
            "country",
            "region",
            "place",
            "start_year",
            "branch",
            "osm_url",
        )
        for extra in extras:
            if r.get(extra) not in (None, ""):
                props[extra] = r[extra]
        features.append(
            {
                "type": "Feature",
                "id": f"{prefix}:{r.get('id')}",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": props,
            }
        )
    fc: dict[str, Any] = {"type": "FeatureCollection", "features": features}
    if len(features) < total:
        fc["truncated"] = True
        fc["total"] = total
    return fc


_THIN_CELLS = 32  # ≈ one marker per 60 px across a 1920 px view, per layer


def _thin(
    rows: list[dict[str, Any]], minlon: float, minlat: float, maxlon: float, maxlat: float
) -> list[dict[str, Any]]:
    """Declutter: keep one row per cell of an ABSOLUTE power-of-two grid sized
    to ~1/48 of the view, so markers do not pile up and the kept set does not
    reshuffle as the view pans. Named rows win a cell, then a stable hash.
    Zooming in shrinks the cell until every row is shown."""
    import math

    span = max(maxlat - minlat, (maxlon - minlon) % 360 or 360.0, 1e-9)
    cell = 2.0 ** math.floor(math.log2(span / _THIN_CELLS))
    best: dict[tuple[int, int], tuple[tuple[int, int], dict[str, Any]]] = {}
    for r in rows:
        key = (math.floor(float(r["lat"]) / cell), math.floor(float(r["lon"]) / cell))
        rank = (0 if r.get("name") else 1, zlib.crc32(str(r.get("id")).encode()))
        cur = best.get(key)
        if cur is None or rank < cur[0]:
            best[key] = (rank, r)
    return [r for _, r in best.values()]


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
