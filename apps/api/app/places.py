"""Airport + seaport reference data: loader, unified search, bbox GeoJSON.

Two curated keyless datasets ship in ``app/data/``:

- ``airports.json`` — ~5.3k rows ``{name, iata, icao, lat, lon, type, iso}``
  (type is 'large' | 'medium'). IATA is the 3-letter code (LAX), ICAO the
  4-letter (KLAX / EGLL).
- ``ports.json`` — ~1.1k rows ``{name, lat, lon}``.

The single-field ``/api/search`` resolver was burying airports/ports under
fuzzy VESSEL-NAME substring hits (q="Singapore" → ships named SINGAPORE;
q="LAX" → GALAXY). ``search_places`` ranks a place-CODE match first so those
public reference points resolve; ``bbox_features`` powers the map overlays.

Both files load ONCE (module-level ``functools.lru_cache``); the JSON is a few
hundred KB and never changes at runtime.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

_DATA = Path(__file__).resolve().parent / "data"

PlaceKind = Literal["airport", "port"]


@lru_cache(maxsize=1)
def airports() -> list[dict[str, Any]]:
    """The airport rows, loaded once. Keys: name, iata, icao, lat, lon, type, iso."""
    with (_DATA / "airports.json").open(encoding="utf-8") as fh:
        rows = json.load(fh)
    return rows if isinstance(rows, list) else []


@lru_cache(maxsize=1)
def ports() -> list[dict[str, Any]]:
    """The seaport rows, loaded once. Keys: name, lat, lon."""
    with (_DATA / "ports.json").open(encoding="utf-8") as fh:
        rows = json.load(fh)
    return rows if isinstance(rows, list) else []


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
    slug = "".join(ch if ch.isalnum() else "-" for ch in name.lower()).strip("-")
    return {
        "kind": "port",
        "id": f"port:{slug}-{idx}",
        "label": f"Port: {name}",
        "lat": float(p["lat"]),
        "lon": float(p["lon"]),
        "iata": "",
        "icao": "",
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
    """GeoJSON FeatureCollection of airports OR ports inside a bbox.

    Airport feature props: ``{name, iata, icao, kind:"airport", atype}``.
    Port feature props: ``{name, kind:"port"}``. Geometry is a Point [lon, lat].
    When airports overflow ``limit``, large airports are kept before medium
    (stable within each rank) so a zoomed-out view still shows the majors.
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
            features.append(
                {
                    "type": "Feature",
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
    else:  # port
        rows = [p for p in ports() if _in_box(float(p["lat"]), float(p["lon"]))]
        for p in rows[:limit]:
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point", "coordinates": [float(p["lon"]), float(p["lat"])],
                    },
                    "properties": {"name": p.get("name") or "", "kind": "port"},
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

    print(
        f"OK airports={len(airports())} ports={len(ports())} "
        f"LAX@{lax[0]['lat']:.2f},{lax[0]['lon']:.2f} "
        f"rotterdam_bbox_ports={len(fc['features'])}"
    )
