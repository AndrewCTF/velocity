"""Keyless AIS provider registry + per-provider parsing.

Every provider here is ANONYMOUS: no API key, no signup, no credit card. That
constraint is not a preference, it is the whole point of this module — the
pipeline has to produce vessel coverage with zero credentials configured, so a
provider that starts asking for a key is a bug, not a feature request.

MEASURED (2026-10-03, this egress), which is why the registry looks like it does:

  shipxplorer   30 737 unique MMSIs, 200 OK, 6.5 MB, ~1.9 s.  The ONLY keyless
                 source with any global breadth. `sate=true` adds ~10 MMSIs, so
                 its satellite-AIS contribution is marginal, not "sat included".
  kystdatahuset 3.6 MB GeoJSON, Norway. Dense, regional.
  digitraffic   MQTT-over-WSS, Baltic. Live push, regional.
  kystverket    TCP NMEA 153.44.253.27:5631 — DEAD (connect timeout) from here.
                 RE-CONFIRMED keyless 2026-10-04 from the operator's own terms:
                 "Access does not require user registration" (NLOD). So DEAD is
                 an EGRESS result, not a gate — re-probe from another address.
                 Note the raw TCP socket is the ONLY keyless path; the BarentsWatch
                 REST API needs an OAuth2 client. BarentsWatch docs also state
                 the open set includes NORWEGIAN SATELLITES + Equinor offshore
                 stations + Svalbard, i.e. the one keyless non-terrestrial maritime
                 net found so far. See docs/keyless-own-network-feeds-2026-10-04.md.

The one genuinely NEW keyless own-network source, absent from this registry
entirely: USCG Nationwide AIS via NOAA Marine Cadastre, anonymous Azure blob,
CC0, GeoParquet, 2009→2025 (archive not live). Docs + verified paths in
docs/keyless-own-network-feeds-2026-10-04.md §1. Its Zone15-17 files are the
remote Pacific EEZ where every live keyless feed measures zero.

The measured ceiling matters more than the total. Of those 30 737 vessels, the
deep-ocean boxes (mid-Pacific, S-Atlantic, Indian Ocean) return ZERO, both by
per-bbox query and by filtering the world pull ourselves. So "global" describes
the QUERY, not the coverage: this is coastal + major-shipping-lane AIS. Real
open-ocean coverage is the SAR side of the pipeline (see ais_pipeline.sar), which
finds vessels by radar rather than by radio.

`bounds` on data.shipxplorer.com/live is a trap worth documenting: only the
full-world form (85,180,-85,-180) works. Any restricted bbox — verified against
a Rotterdam control box that MUST return vessels, and it returned 0 — silently
yields an empty set. ``fetch_shipxplorer`` therefore always requests the world
and we filter locally.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx

log = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# ── ShipXplorer /live ─────────────────────────────────────────────────────────
# Row layout of each vessel array, validated live 2026-10-03 against a 30k-vessel
# body. Positional access only — the payload carries no keys.
_SX_NAME, _SX_LAT, _SX_LON, _SX_TS, _SX_SOG = 0, 1, 2, 3, 5
_SX_SRC, _SX_TYPE, _SX_MMSI, _SX_FLAG, _SX_HEADING = 6, 7, 8, 16, 22
_SHIPXPLORER_HEADERS = {
    "user-agent": _UA,
    "accept": "application/json, text/plain, */*",
    "referer": "https://www.shipxplorer.com/",
    "origin": "https://www.shipxplorer.com",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
}
_SHIPXPLORER_TYPES = [
    "CARGO",
    "FISHING",
    "HSC",
    "OTHER",
    "PASSENGER",
    "PLEASURE",
    "SAILING",
    "TANKER",
    "TUG",
    "UNKNOWN",
]
# The only bounds value the endpoint honours (see module docstring).
_SHIPXPLORER_WORLD_BOUNDS = "85,180,-85,-180"


@dataclass(frozen=True)
class Fix:
    """One normalized vessel fix, from any provider.

    ``t`` is the age-stamp of the DATA (upstream serve time), not the wall clock
    of the response. The observation store is last-write-wins on ``id``, so an
    optimistic ``t`` is a correctness bug: it lets a cached tier steal an MMSI
    from a live source and pins itself in retention forever.
    """

    mmsi: int
    lat: float
    lon: float
    t: float
    source: str
    sog: float | None = None
    cog: float | None = None
    heading: float | None = None
    name: str | None = None
    ship_type: Any = None
    flag: str | None = None
    # 'AIS' | 'SAT' — how we heard it. SAT is rare in the keyless feeds but the
    # field is preserved because it is the provenance an analyst needs.
    origin: str = "AIS"


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def valid_mmsi(v: Any) -> int | None:
    """Return a 9-digit MMSI, or None.

    Rejects anything that isn't a plausible MMSI so a schema drift thins the feed
    toward zero instead of emitting garbage ids that pollute the store.
    """
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        m = v
    elif isinstance(v, str) and v.strip().isdigit():
        m = int(v.strip())
    else:
        return None
    return m if 100_000_000 <= m < 1_000_000_000 else None


# ShipXplorer ships the type as a NAME; the globe's icon dispatch and every
# other AIS source speak the ITU-R M.1371 code (0-99). Names enumerated from a
# full world pull on 2026-10-04 (29 644 rows); a "<base>, Hazmat A-D" suffix is
# the code's last digit 1-4. "?" and unseen names map to None, never a guess.
_TYPE_NAME_ITU = {
    "wig": 20,
    "fishing": 30,
    "towing": 31,
    "dredging": 33,
    "diving ops": 34,
    "military ops": 35,
    "sailing": 36,
    "pleasure craft": 37,
    "hsc": 40,
    "pilot": 50,
    "sar": 51,
    "tug": 52,
    "port tender": 53,
    "anti-pollution equipment": 54,
    "law enforcement": 55,
    "spare - local vessel": 56,
    "medical transport": 58,
    "ship according to rr resolution no. 18": 59,
    "passenger": 60,
    "cargo": 70,
    "tanker": 80,
    "other": 90,
}


def itu_ship_type(v: Any) -> int | None:
    """ITU ship-type code from a code (OpenWaters) or a type name (ShipXplorer)."""
    if isinstance(v, bool):
        return None
    if isinstance(v, float):
        if not v.is_integer():  # also rejects nan / inf
            return None
        v = int(v)
    if isinstance(v, int):
        return v if 0 <= v <= 99 else None
    if not isinstance(v, str):
        return None
    s = v.strip().lower()
    if s.isdigit():
        return int(s) if int(s) <= 99 else None
    base, _, hazmat = s.partition(", hazmat ")
    code = _TYPE_NAME_ITU.get(base)
    if code is None or not hazmat:
        return code
    return code + "abcd".index(hazmat) + 1 if hazmat in ("a", "b", "c", "d") else code


def parse_shipxplorer(payload: Any, *, now: float | None = None) -> list[Fix]:
    """Parse a ShipXplorer /live body into fixes. Pure; unit-testable offline.

    Body shape: ``[vesselsById, {"total": N, ...}, [], {}]``. Rows without a
    valid MMSI or an in-range position are skipped.
    """
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], dict):
        return []
    wall = time.time() if now is None else now
    out: list[Fix] = []
    for a in payload[0].values():
        if not isinstance(a, list) or len(a) <= _SX_MMSI:
            continue
        mmsi = valid_mmsi(a[_SX_MMSI])
        if mmsi is None:
            continue
        lat, lon = (
            _num(a[_SX_LAT] if len(a) > _SX_LAT else None),
            _num(a[_SX_LON] if len(a) > _SX_LON else None),
        )
        if lat is None or lon is None:
            continue
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        # ts is epoch MILLISECONDS; absent/garbage falls back to "as of now",
        # which is the honest reading when the row carries no usable stamp.
        ts = _num(a[_SX_TS] if len(a) > _SX_TS else None)
        t = wall if ts is None or ts <= 0 else (ts / 1000.0)
        sog = _num(a[_SX_SOG] if len(a) > _SX_SOG else None)
        if sog is not None and sog >= 102.3:
            sog = None  # AIS "not available"
        heading = _num(a[_SX_HEADING] if len(a) > _SX_HEADING else None)
        if heading is not None and heading >= 511:
            heading = None
        name = a[_SX_NAME] if isinstance(a[_SX_NAME], str) else None
        if name:
            name = name.strip() or None
        out.append(
            Fix(
                mmsi=mmsi,
                lat=lat,
                lon=lon,
                t=t,
                source="shipxplorer",
                sog=sog,
                heading=heading,
                name=name,
                ship_type=a[_SX_TYPE] if isinstance(a[_SX_TYPE], str) else None,
                flag=a[_SX_FLAG] if len(a) > _SX_FLAG and isinstance(a[_SX_FLAG], str) else None,
                origin=(a[_SX_SRC] if isinstance(a[_SX_SRC], str) else "AIS"),
            )
        )
    return out


def shipxplorer_url(base: str, zoom: int = 6) -> str:
    """Full query string for the world pull.

    ``bounds`` is pinned to the full-world form because every restricted value
    returns an empty set (module docstring). Callers filter locally.
    """
    from urllib.parse import urlencode

    q: list[tuple[str, str]] = [
        ("vessel", ""),
        ("port", ""),
        ("zoom", str(zoom)),
        ("vesselid", ""),
        ("bounds", _SHIPXPLORER_WORLD_BOUNDS),
        ("timestamp", "false"),
        ("lastReport", "3600"),
        ("designator", "iata"),
        ("os", "web"),
        ("ais", "true"),
        ("sate", "true"),
    ]
    q += [("types[]", t) for t in _SHIPXPLORER_TYPES]
    return f"{base}?{urlencode(q)}"


async def fetch_shipxplorer(
    client: httpx.AsyncClient, url: str, *, zoom: int = 6
) -> tuple[list[Fix], dict[str, Any]]:
    """One world pull. Returns (fixes, telemetry incl. the server's ``total``).

    The reported total is the provider's own count, kept separate from the
    number of rows we accepted so a schema drift is visible instead of silent.
    """
    r = await client.get(shipxplorer_url(url, zoom), headers=_SHIPXPLORER_HEADERS, timeout=45.0)
    if r.status_code != 200:
        raise RuntimeError(f"shipxplorer http {r.status_code}")
    payload = r.json()
    total = None
    if isinstance(payload, list) and len(payload) > 1 and isinstance(payload[1], dict):
        total = payload[1].get("total")
    return parse_shipxplorer(payload), {"provider_total": total, "bytes": len(r.content)}


# ── Kystdatahuset (Norway) — REST GeoJSON ─────────────────────────────────────

_KYSTDATAHUSET_URL = "https://kystdatahuset.no/ws/api/ais/realtime/geojson"


def parse_kystdatahuset(
    features: Iterable[dict[str, Any]], *, now: float | None = None
) -> list[Fix]:
    """Parse Kystdatahuset realtime GeoJSON features into fixes.

    Geometry is a LineString (recent track) whose LAST coordinate is the newest
    fix, or a bare Point. ``speed`` is SOG in knots.
    """
    wall = time.time() if now is None else now
    out: list[Fix] = []
    for feat in features:
        if not isinstance(feat, dict):
            continue
        props = feat.get("properties") or {}
        mmsi = valid_mmsi(props.get("mmsi"))
        if mmsi is None:
            continue
        fix = _latest_coord(feat.get("geometry") or {})
        if fix is None:
            continue
        lon, lat = fix
        out.append(
            Fix(
                mmsi=mmsi,
                lat=lat,
                lon=lon,
                t=wall,
                source="kystdatahuset",
                sog=_kn(props.get("speed")),
                cog=_deg(props.get("cog")),
                heading=_deg(props.get("true_heading")),
                name=_clean_name(props.get("ship_name")),
                ship_type=props.get("ship_type"),
            )
        )
    return out


def _latest_coord(geom: dict[str, Any]) -> tuple[float, float] | None:
    coords, gtype = geom.get("coordinates"), geom.get("type")
    if gtype == "Point" and isinstance(coords, list) and len(coords) >= 2:
        pt = coords
    elif gtype == "LineString" and isinstance(coords, list) and coords:
        pt = coords[-1]
    else:
        return None
    if not isinstance(pt, list) or len(pt) < 2:
        return None
    lon, lat = _num(pt[0]), _num(pt[1])
    if lon is None or lat is None:
        return None
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        return None
    return lon, lat


async def fetch_kystdatahuset(
    client: httpx.AsyncClient, url: str = _KYSTDATAHUSET_URL
) -> list[Fix]:
    r = await client.get(
        url, headers={"user-agent": _UA, "accept": "application/json"}, timeout=45.0
    )
    if r.status_code != 200:
        raise RuntimeError(f"kystdatahuset http {r.status_code}")
    body = r.json()
    return parse_kystdatahuset(body.get("features") or [])


# ── Digitraffic (Finland/Baltic) — MQTT-over-WSS payloads ────────────────────
# The wire codec lives in app/mqtt_client.py (shared with the user-configured
# broker). This module only owns the payload shape.


def parse_digitraffic(topic: str, payload: bytes, *, now: float | None = None) -> Fix | None:
    """Decode one Digitraffic PUBLISH (``vessels-v2/<mmsi>/location``)."""
    parts = topic.split("/")
    if len(parts) < 2:
        return None
    mmsi = valid_mmsi(parts[1])
    if mmsi is None:
        return None
    try:
        d = json.loads(payload)
    except (ValueError, TypeError):
        return None
    lat, lon = _num(d.get("lat")), _num(d.get("lon"))
    if lat is None or lon is None:
        return None
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        return None
    wall = time.time() if now is None else now
    return Fix(
        mmsi=mmsi,
        lat=lat,
        lon=lon,
        t=wall,
        source="digitraffic",
        sog=_kn(d.get("sog")),
        cog=_deg(d.get("cog")),
        heading=_deg(d.get("heading")),
        name=_clean_name(d.get("name") or d.get("shipName")),
    )


# ── OpenWaters (ais.openwaters.io) — keyless multi-source aggregate ──────────
#
# The single best keyless source found, measured 2026-10-03: a COMPLETE
# 133-tile sweep of its accepted longitude window returned 16 220 UNIQUE
# MMSIs (complete=True, 0 failed tiles, 66 s at concurrency 2), richer per
# vessel than ShipXplorer, and it is itself an aggregate that has already
# deduped four independent feeds (AISHub 12.3k, BarentsWatch 1.9k,
# Digitraffic 0.9k, AISStream 0.5k, plus public ed25519 relay stations).
#
# Two constraints, both MEASURED by probing the anonymous API, and the second
# one is undocumented and easy to get wrong:
#   * a response caps at ~2000 vessels and sets `truncated: true`. Summing raw
#     feature counts across tiles over-reports; count UNIQUE MMSI.
#   * the anonymous bbox accepts ONLY longitude in [-90, +81] — a 171 degree
#     window. Latitude is unrestricted (-90..90 all fine) and tile SIZE is
#     irrelevant (4 deg and 9 deg tiles fail/pass identically). Everything
#     outside that window answers HTTP 400 "bbox out of range", which is NOT a
#     rate limit: sustained back-to-back requests succeed, and a 45 s wait does
#     not change the answer for the same box.
#     Consequence: this endpoint CANNOT serve a world sweep anonymously. A
#     naive 400-tile grid has ~50% of its tiles rejected — measured 20 ok / 20
#     rejected over the first 40 — and every rejected tile is silently missing
#     coverage. ``openwaters_tiles`` therefore emits ONLY tiles inside the
#     window and reports the covered fraction, so a caller is never misled into
#     reading a partial count as global.
#
# Deep ocean is still empty inside the covered window: all six open-ocean boxes
# returned 0 vessels, independently reproducing the ShipXplorer result.

_OPENWATERS_BASE = "https://ais.openwaters.io/v1"
# Measured anonymous longitude window (inclusive). Outside it the API answers
# 400 "bbox out of range" regardless of tile size or latitude.
_OPENWATERS_LON_MIN = -90.0
_OPENWATERS_LON_MAX = 81.0
# 9x9 = 81 sq deg, comfortably inside the ~100 sq deg area limit.
_OPENWATERS_TILE_DEG = 9.0
_OPENWATERS_MAX_TILES = 400

# ── Satellite AIS: measured NOT available from the keyless path ─────────────
# Recorded because it is the single most-asked-for capability and the obvious
# assumption is wrong. Probed 2026-10-03:
#   * OpenWaters' /v1/stations listed NO satellite station. An earlier read of
#     that endpoint appeared to show a `barentswatch/sat` row; re-probing
#     returned 22 stations with zero satellite entries, so that reading was a
#     transient/misread and must not be relied on.
#   * A Barents Sea bbox (20-30E/70-78N) returned 18 vessels, ALL `aishub`,
#     zero tagged SAT.
#   * No `sat` source value appears on any vessel in the accepted window.
# Every dedicated satellite-AIS vendor (exactEarth, FleetMon, Kpler, Spire)
# serves a live map but gates its API: exactEarth /v2/vessels -> HTTP 401,
# FleetMon API -> 401, GFW gateway -> 401 "invalid token". Global Fishing
# Watch's live map is public HTML but its data layer is token-gated (the page
# ships Authorization headers), so it is a map, not a keyless feed.
# Conclusion: IDENTIFIED satellite AIS (an MMSI you can track) is not obtainable
# without a credential, and this flag stays False for that reason.
#
# Narrower than it reads, since 2026-10-04: VesselFinder's public map does serve
# its "Satellite Position" markers keylessly (ais_pipeline.vesselfinder.parse_sfl
# — about 10 000 open-ocean positions with a type class and a heading). Those
# carry no MMSI, no name and no age, so they are a separate, unidentified layer
# (/api/maritime/satellite) and are never merged into the vessel store. They do
# not make this flag True; the other open-ocean path is SAR (ais_pipeline.sar).
SATELLITE_AIS_KEYLESS = False


def _iso_to_epoch(v: Any) -> float | None:
    """Parse the RFC3339 stamps openwaters returns (``seen``, ``last_seen``)."""
    if not isinstance(v, str) or not v:
        return None
    txt = v.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(txt).timestamp()
    except ValueError:
        return None


def parse_openwaters(payload: Any, *, now: float | None = None) -> list[Fix]:
    """Parse an OpenWaters GeoJSON FeatureCollection into fixes. Pure."""
    if not isinstance(payload, dict):
        return []
    feats = payload.get("features")
    if not isinstance(feats, list):
        return []
    wall = time.time() if now is None else now
    out: list[Fix] = []
    for feat in feats:
        if not isinstance(feat, dict):
            continue
        props = feat.get("properties") or {}
        mmsi = valid_mmsi(props.get("mmsi"))
        if mmsi is None:
            continue
        coords = (feat.get("geometry") or {}).get("coordinates")
        if not isinstance(coords, list) or len(coords) < 2:
            continue
        lon, lat = _num(coords[0]), _num(coords[1])
        if lon is None or lat is None:
            continue
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        seen = _iso_to_epoch(props.get("seen"))
        out.append(
            Fix(
                mmsi=mmsi,
                lat=lat,
                lon=lon,
                # Per-row `seen` is the DATA's age. Default to wall clock only
                # when the row carries no usable stamp.
                t=wall if seen is None else seen,
                source="openwaters",
                sog=_kn(props.get("sog")),
                cog=_deg(props.get("cog")),
                heading=_deg(props.get("heading")),
                name=_clean_name(props.get("name")),
                ship_type=props.get("type"),
                flag=props.get("flag") if isinstance(props.get("flag"), str) else None,
                # Keep the upstream provenance; SAT rows are labelled by source.
                origin=props.get("source") if isinstance(props.get("source"), str) else "AIS",
            )
        )
    return out


async def fetch_openwaters_tile(
    client: httpx.AsyncClient, bbox: tuple[float, float, float, float]
) -> tuple[list[Fix], bool]:
    """One bbox tile. Returns (fixes, truncated).

    Two DISTINCT rejections, which must not be confused:
      * HTTP 400 "bbox out of range" — the box is outside the accepted
        longitude window. Retrying cannot help; ``openwaters_tiles`` already
        clips so this should not happen.
      * HTTP 429 — a genuine rate limit. Retrying with backoff DOES help.
    """
    q = ",".join(str(x) for x in bbox)
    r = await client.get(
        f"{_OPENWATERS_BASE}/vessels",
        params={"bbox": q},
        headers={"user-agent": _UA, "accept": "application/json"},
        timeout=30.0,
    )
    if r.status_code == 429:
        raise _RateLimited("openwaters rate limited")
    if r.status_code != 200:
        raise RuntimeError(f"openwaters http {r.status_code} for bbox {bbox}")
    body = r.json()
    return parse_openwaters(body), bool(body.get("truncated"))


class _RateLimited(RuntimeError):
    """429 from openwaters — retryable, unlike a 400 bbox rejection."""


def openwaters_tiles(
    *,
    tile_deg: float = _OPENWATERS_TILE_DEG,
    lat0: float = -80.0,
    lat1: float = 80.0,
    lon_min: float = _OPENWATERS_LON_MIN,
    lon_max: float = _OPENWATERS_LON_MAX,
) -> list[tuple[float, float, float, float]]:
    """Tiles covering the longitude window the anonymous API actually accepts.

    Deliberately emits ONLY tiles inside ``[lon_min, lon_max]``. Tiles outside
    it are guaranteed 400s, and including them would turn an incomplete sweep
    into a plausible-looking but wrong vessel count. Longitude wraps: a tile
    whose east edge would pass ``lon_max`` is trimmed to the window edge so the
    boundary column is still covered instead of being dropped.
    """
    out: list[tuple[float, float, float, float]] = []
    la = lat0
    while la < lat1:
        lo = lon_min
        while lo < lon_max:
            out.append((lo, la, min(lo + tile_deg, lon_max), min(la + tile_deg, lat1)))
            lo += tile_deg
        la += tile_deg
    return out[:_OPENWATERS_MAX_TILES]


def openwaters_longitude_coverage() -> dict[str, Any]:
    """How much of the globe this endpoint can serve anonymously.

    Returned by the sweep so a caller can state coverage honestly instead of
    calling a 171-of-360 degree result "global".
    """
    span = _OPENWATERS_LON_MAX - _OPENWATERS_LON_MIN
    return {
        "lonMin": _OPENWATERS_LON_MIN,
        "lonMax": _OPENWATERS_LON_MAX,
        "lonSpanDeg": span,
        "fractionOfGlobe": round(span / 360.0, 4),
        "note": (
            "Anonymous bbox access is limited to this longitude window; tiles "
            "outside it answer HTTP 400. Not a rate limit — verified by retry "
            "and by waiting. Coverage west of 90W and east of 81E comes from "
            "ShipXplorer instead."
        ),
    }


async def fetch_openwaters_world(
    client: httpx.AsyncClient,
    *,
    tile_deg: float = _OPENWATERS_TILE_DEG,
    lat0: float = -80.0,
    lat1: float = 80.0,
    max_tiles: int = _OPENWATERS_MAX_TILES,
    concurrency: int = 2,
    retries: int = 4,
    max_split_depth: int = 4,
    max_split_requests: int = 400,
) -> tuple[list[Fix], dict[str, Any]]:
    """Tile the accepted longitude window and return the deduped union.

    Concurrency is deliberately LOW. Measured on a 133-tile slice:
      * concurrency 4 → 13 tiles rate-limited (HTTP 429), sweep incomplete
      * concurrency 3 →  3 tiles rate-limited
      * concurrency 2 →  0 tiles rate-limited, ``complete: true``, 66 s
    Speed here is worth nothing next to a silently short count, so 2 is the
    default and ``concurrency`` is a knob an operator can raise knowingly.
    ``tilesFailed`` is always reported so an incomplete sweep is visible
    rather than being read as a coverage number.

    A tile the server caps (``truncated``) is quartered and re-asked, up to
    ``max_split_depth`` levels and ``max_split_requests`` extra requests per
    sweep. Measured 2026-10-04: 18 of 342 nine-degree tiles came back capped,
    all of them over the densest water. What is still capped at the smallest
    tile is counted in ``tilesTruncated`` and makes the sweep incomplete.
    """
    tiles = openwaters_tiles(tile_deg=tile_deg, lat0=lat0, lat1=lat1)[:max_tiles]
    sem = asyncio.Semaphore(concurrency)
    by_mmsi: dict[int, Fix] = {}
    truncated = 0
    failed = 0
    split = 0
    split_budget = max_split_requests

    async def fetch(bbox):
        """One tile with retries. Returns (fixes, truncated) or None on failure."""
        async with sem:
            for attempt in range(retries + 1):
                try:
                    return await fetch_openwaters_tile(client, bbox)
                except _RateLimited:
                    # 429 is a real limit: back off harder and wait it out. A
                    # 133-tile sweep trips this, so the wait has to be long
                    # enough to matter (measured: ~2 s).
                    if attempt == retries:
                        return None
                    await asyncio.sleep((4.0 * (attempt + 1)) * (0.75 + random.random()))
                except Exception as e:  # noqa: BLE001
                    # 400 / DNS / timeout — not worth hammering. One short
                    # retry, then count it as a hole in the sweep.
                    if attempt >= min(retries, 1):
                        log.warning("openwaters tile %s failed: %s", bbox, e)
                        return None
                    await asyncio.sleep(1.0 * (0.5 + random.random()))
        return None

    async def one(bbox, depth: int = 0) -> list[Fix]:
        nonlocal truncated, failed, split, split_budget
        got = await fetch(bbox)
        if got is None:
            failed += 1
            return []
        fixes, tr = got
        if not tr:
            return fixes
        # The server capped this tile's rows, so the busiest water (ports,
        # straits) is exactly what is missing. Quarter it and ask again — the
        # semaphore is released first, so children queue like any other tile.
        if depth >= max_split_depth or split_budget < 4:
            truncated += 1  # still capped at the smallest tile we will ask for
            return fixes
        split += 1
        split_budget -= 4
        lon0, la0, lon1, la1 = bbox
        mlon, mlat = (lon0 + lon1) / 2.0, (la0 + la1) / 2.0
        quads = [
            (lon0, la0, mlon, mlat),
            (mlon, la0, lon1, mlat),
            (lon0, mlat, mlon, la1),
            (mlon, mlat, lon1, la1),
        ]
        out = list(fixes)  # keep the parent's rows: a failed child must not lose them
        for sub in await asyncio.gather(*(one(q, depth + 1) for q in quads)):
            out.extend(sub)
        return out

    for batch in await asyncio.gather(*(one(b) for b in tiles)):
        for fx in batch:
            cur = by_mmsi.get(fx.mmsi)
            # Freshest-wins within the sweep: a vessel on a tile border appears
            # in two tiles with different `seen` stamps.
            if cur is None or fx.t > cur.t:
                by_mmsi[fx.mmsi] = fx

    return list(by_mmsi.values()), {
        "tiles": len(tiles),
        "tilesSplit": split,
        # Tiles STILL capped after splitting — rows are missing there.
        "tilesTruncated": truncated,
        "tilesFailed": failed,
        "uniqueMmsi": len(by_mmsi),
        # A sweep with dead or still-capped tiles is not a window count. Say so.
        "complete": failed == 0 and truncated == 0,
        "longitude": openwaters_longitude_coverage(),
    }


async def fetch_openwaters_stations(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    """Upstream station health — which receivers back this aggregate, and how stale.

    Useful on its own: a station whose `last_age_s` climbs means that feed has
    gone quiet even though the aggregate still answers 200.
    """
    r = await client.get(
        f"{_OPENWATERS_BASE}/stations",
        headers={"user-agent": _UA, "accept": "application/json"},
        timeout=30.0,
    )
    if r.status_code != 200:
        raise RuntimeError(f"openwaters stations http {r.status_code}")
    return r.json() or []


# ── field hygiene ────────────────────────────────────────────────────────────

_SOG_NA, _COG_NA, _HEADING_NA = 102.3, 360.0, 511.0


def _kn(v: Any) -> float | None:
    """Speed in knots with the AIS 'not available' sentinel masked."""
    x = _num(v)
    return None if x is None or x >= _SOG_NA else x


def _deg(v: Any) -> float | None:
    """Angle in degrees with 'unavailable' (360 / 511) masked."""
    x = _num(v)
    if x is None:
        return None
    return None if x >= _COG_NA or x == _HEADING_NA else x


def _clean_name(v: Any) -> str | None:
    """Trim a ship name. AIS pads static fields with '@' and spaces."""
    if not isinstance(v, str):
        return None
    name = v.replace("@", "").strip()
    return name or None
