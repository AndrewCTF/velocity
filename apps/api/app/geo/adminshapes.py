"""Keyless admin-boundary resolver — geoBoundaries gbOpen.

Conflict/strike events carry an uncertainty ``radius_m``; the operator wants
the ACTUAL place shaded — the real admin unit (district/region) containing the
event. geoBoundaries publishes open ADM1/ADM2 boundaries per country:

    https://www.geoboundaries.org/api/current/gbOpen/{ISO3}/{ADM1|ADM2}/

returns metadata whose ``simplifiedGeometryGeoJSON`` is a github-raw URL to a
simplified FeatureCollection (UKR ADM2 = 698 KB, 495 features, median 27
points/polygon — verified live 2026-07-13). Containment over the simplified
polygons is pure-python ray casting (with hole support) behind a per-feature
bbox prefilter computed at load; the full 495-polygon sweep costs ~1 ms, so no
shapely dependency.

Downloads cache to disk (``./data/adminshapes`` next to the tile cache;
30-day refresh, stale file kept when a refetch fails) and index in memory per
``(iso3, level)`` behind an asyncio.Lock. Countries with no gbOpen data are
negative-cached for ~1 h so we don't hammer the API.

Also home to the two country-code mappings the event feeds need to reach this
resolver: FIPS 10-4 → ISO3 (GDELT ActionGeo_CountryCode) and country-name →
ISO3 (UCDP / ACLED ship names, not codes).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.upstream import get_client

log = logging.getLogger("app.geo.adminshapes")

_API = "https://www.geoboundaries.org/api/current/gbOpen/{iso3}/{level}/"
_CACHE_DIR = Path("./data/adminshapes")  # monkeypatched to tmp dirs in tests
_REFRESH_SEC = 30 * 86400.0  # boundaries barely change; refresh monthly
_MISS_TTL_SEC = 3600.0  # negative cache for countries with no gbOpen data
_GEOM_TIMEOUT_S = 30.0  # geometry files run to a few MB for big countries

_LEVELS = ("adm1", "adm2")

# (iso3, level) → list of (bbox, feature); [] = fetched but empty/missing.
_Entry = tuple[tuple[float, float, float, float], dict[str, Any]]
_INDEX: dict[tuple[str, str], list[_Entry]] = {}
_INDEX_LOADED_AT: dict[tuple[str, str], float] = {}
_MISS_UNTIL: dict[tuple[str, str], float] = {}
_LOCKS: dict[tuple[str, str], asyncio.Lock] = {}


# ------------------------------------------------------------- containment


def _ring_contains(ring: list[Any], lon: float, lat: float) -> bool:
    """Even-odd ray casting: does ``ring`` (a linear ring of [lon, lat]
    positions) contain the point?"""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def _polygon_contains(coords: list[Any], lon: float, lat: float) -> bool:
    """GeoJSON Polygon coordinate array: ring 0 = exterior, rest = holes."""
    if not coords or not _ring_contains(coords[0], lon, lat):
        return False
    return not any(_ring_contains(hole, lon, lat) for hole in coords[1:])


def _geometry_contains(geom: dict[str, Any], lon: float, lat: float) -> bool:
    gtype = geom.get("type")
    coords = geom.get("coordinates") or []
    if gtype == "Polygon":
        return _polygon_contains(coords, lon, lat)
    if gtype == "MultiPolygon":
        return any(_polygon_contains(poly, lon, lat) for poly in coords)
    return False


def _geometry_bbox(geom: dict[str, Any]) -> tuple[float, float, float, float] | None:
    """(min_lon, min_lat, max_lon, max_lat) over every position in the
    geometry; None for non-polygon/degenerate geometries."""
    gtype = geom.get("type")
    coords = geom.get("coordinates") or []
    polys = [coords] if gtype == "Polygon" else coords if gtype == "MultiPolygon" else []
    min_lon = min_lat = float("inf")
    max_lon = max_lat = float("-inf")
    seen = False
    for poly in polys:
        for ring in poly:
            for pt in ring:
                lon, lat = pt[0], pt[1]
                seen = True
                min_lon, max_lon = min(min_lon, lon), max(max_lon, lon)
                min_lat, max_lat = min(min_lat, lat), max(max_lat, lat)
    return (min_lon, min_lat, max_lon, max_lat) if seen else None


def _build_index(features: list[dict[str, Any]]) -> list[_Entry]:
    out: list[_Entry] = []
    for feat in features:
        geom = feat.get("geometry") or {}
        bbox = _geometry_bbox(geom)
        if bbox is not None:
            out.append((bbox, feat))
    return out


# ------------------------------------------------------------ fetch / cache


def _cache_path(iso3: str, level: str) -> Path:
    return _CACHE_DIR / f"{iso3}_{level.upper()}.geojson"


def _read_geojson(path: Path) -> dict[str, Any] | None:
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and data.get("type") == "FeatureCollection":
        return data
    return None


def _write_geojson(path: Path, data: dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".tmp.{os.getpid()}")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(path)  # atomic — never leave a half-written cache file
    except OSError:  # disk cache is best-effort; the in-memory index still works
        log.warning("adminshapes: could not write cache file %s", path)


async def _download(iso3: str, level: str) -> dict[str, Any] | None:
    """Fetch metadata then the simplified GeoJSON; None on any failure (the
    caller decides between stale-cache fallback and negative caching)."""
    client = get_client()
    try:
        meta_r = await client.get(
            _API.format(iso3=iso3, level=level.upper()), follow_redirects=True
        )
        if meta_r.status_code != 200:
            return None
        meta = meta_r.json()
        if isinstance(meta, list):  # some API paths wrap the record in a list
            meta = meta[0] if meta else {}
        url = meta.get("simplifiedGeometryGeoJSON") if isinstance(meta, dict) else None
        if not isinstance(url, str) or not url.startswith("http"):
            return None
        geo_r = await client.get(url, follow_redirects=True, timeout=_GEOM_TIMEOUT_S)
        if geo_r.status_code != 200:
            return None
        data = geo_r.json()
    except Exception:  # noqa: BLE001 — resolver degrades to None, never raises
        return None
    if isinstance(data, dict) and data.get("type") == "FeatureCollection":
        return data
    return None


async def _load(iso3: str, level: str) -> list[_Entry]:
    """Disk-cache-aware load of one (iso3, level) file → bbox index.

    Fresh cache file → no network. Stale/missing → refetch; on refetch
    failure a stale file is still served (keep-stale beats empty)."""
    path = _cache_path(iso3, level)
    data: dict[str, Any] | None = None
    try:
        fresh = path.exists() and (time.time() - path.stat().st_mtime) < _REFRESH_SEC
    except OSError:
        fresh = False
    if fresh:
        data = _read_geojson(path)
    if data is None:
        data = await _download(iso3, level)
        if data is not None:
            _write_geojson(path, data)
        elif path.exists():
            data = _read_geojson(path)  # keep stale on refetch failure
    if not data:
        return []
    return _build_index(data.get("features") or [])


async def _index_for(iso3: str, level: str) -> list[_Entry]:
    """In-memory index for (iso3, level); [] when the country/level has no
    usable gbOpen data (negative-cached ~1 h)."""
    key = (iso3, level)
    now = time.monotonic()
    if _MISS_UNTIL.get(key, 0.0) > now:
        return []
    cached = _INDEX.get(key)
    if cached is not None and now - _INDEX_LOADED_AT.get(key, 0.0) < _REFRESH_SEC:
        return cached
    lock = _LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        # Re-check under the lock — a concurrent caller may have loaded it.
        now = time.monotonic()
        if _MISS_UNTIL.get(key, 0.0) > now:
            return []
        cached = _INDEX.get(key)
        if cached is not None and now - _INDEX_LOADED_AT.get(key, 0.0) < _REFRESH_SEC:
            return cached
        entries = await _load(iso3, level)
        if entries:
            _INDEX[key] = entries
            _INDEX_LOADED_AT[key] = now
        else:
            _MISS_UNTIL[key] = now + _MISS_TTL_SEC
        return entries


# ----------------------------------------------------------------- resolve


async def resolve(iso3: str, lon: float, lat: float, level: str) -> dict[str, Any] | None:
    """Admin unit containing (lon, lat) in country ``iso3`` at ``level``
    ("adm1" | "adm2").

    Returns ``{id, name, level, iso3, geometry}`` or None (unknown country,
    no gbOpen data, or point outside every polygon). ADM2 requests fall back
    to ADM1 when the country has no usable ADM2 file; the returned ``level``
    reflects the level actually used. Never raises on upstream failure."""
    iso3 = (iso3 or "").strip().upper()
    lvl = (level or "").strip().lower()
    if len(iso3) != 3 or not iso3.isalpha() or lvl not in _LEVELS:
        return None
    tries = ("adm2", "adm1") if lvl == "adm2" else ("adm1",)
    for try_level in tries:
        entries = await _index_for(iso3, try_level)
        if not entries:
            continue  # ADM2 file missing/empty → fall back to ADM1
        for bbox, feat in entries:
            if not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
                continue  # bbox prefilter — skip the ray cast entirely
            geom = feat.get("geometry") or {}
            if _geometry_contains(geom, lon, lat):
                props = feat.get("properties") or {}
                return {
                    "id": props.get("shapeID"),
                    "name": props.get("shapeName"),
                    "level": try_level,
                    "iso3": iso3,
                    "geometry": geom,
                }
        return None  # file present, point in no polygon — don't blur to ADM1
    return None


# ------------------------------------------------- FIPS 10-4 → ISO 3166-1 a3
# GDELT ActionGeo_CountryCode is FIPS 10-4, NOT ISO — the two alphabets
# collide viciously (FIPS UP=Ukraine, IZ=Iraq, GM=Germany, IS=Israel...).
# Static table sourced from the FIPS 10-4 / NGA GEC list; codes with no ISO
# equivalent (Dhekelia, Paracel/Spratly Islands, dissolved entities) are
# deliberately OMITTED rather than guessed. Kosovo uses geoBoundaries' XKX.

_FIPS_TO_ISO3: dict[str, str] = {
    "AA": "ABW", "AC": "ATG", "AE": "ARE", "AF": "AFG", "AG": "DZA",
    "AJ": "AZE", "AL": "ALB", "AM": "ARM", "AN": "AND", "AO": "AGO",
    "AQ": "ASM", "AR": "ARG", "AS": "AUS", "AT": "AUS",  # Ashmore/Cartier → AUS
    "AU": "AUT", "AV": "AIA", "AY": "ATA",
    "BA": "BHR", "BB": "BRB", "BC": "BWA", "BD": "BMU", "BE": "BEL",
    "BF": "BHS", "BG": "BGD", "BH": "BLZ", "BK": "BIH", "BL": "BOL",
    "BM": "MMR", "BN": "BEN", "BO": "BLR", "BP": "SLB", "BQ": "UMI",
    "BR": "BRA", "BS": "ATF", "BT": "BTN", "BU": "BGR", "BV": "BVT",
    "BX": "BRN", "BY": "BDI",
    "CA": "CAN", "CB": "KHM", "CD": "TCD", "CE": "LKA", "CF": "COG",
    "CG": "COD", "CH": "CHN", "CI": "CHL", "CJ": "CYM", "CK": "CCK",
    "CM": "CMR", "CN": "COM", "CO": "COL", "CQ": "MNP", "CR": "AUS",
    "CS": "CRI", "CT": "CAF", "CU": "CUB", "CV": "CPV", "CW": "COK",
    "CY": "CYP",
    "DA": "DNK", "DJ": "DJI", "DO": "DMA", "DQ": "UMI", "DR": "DOM",
    "EC": "ECU", "EG": "EGY", "EI": "IRL", "EK": "GNQ", "EN": "EST",
    "ER": "ERI", "ES": "SLV", "ET": "ETH", "EU": "ATF", "EZ": "CZE",
    "FG": "GUF", "FI": "FIN", "FJ": "FJI", "FK": "FLK", "FM": "FSM",
    "FO": "FRO", "FP": "PYF", "FQ": "UMI", "FR": "FRA", "FS": "ATF",
    "GA": "GMB", "GB": "GAB", "GG": "GEO", "GH": "GHA", "GI": "GIB",
    "GJ": "GRD", "GK": "GGY", "GL": "GRL", "GM": "DEU", "GO": "ATF",
    "GP": "GLP", "GQ": "GUM", "GR": "GRC", "GT": "GTM", "GV": "GIN",
    "GY": "GUY", "GZ": "PSE",
    "HA": "HTI", "HK": "HKG", "HM": "HMD", "HO": "HND", "HQ": "UMI",
    "HR": "HRV", "HU": "HUN",
    "IC": "ISL", "ID": "IDN", "IM": "IMN", "IN": "IND", "IO": "IOT",
    "IR": "IRN", "IS": "ISR", "IT": "ITA", "IV": "CIV", "IZ": "IRQ",
    "JA": "JPN", "JE": "JEY", "JM": "JAM", "JN": "SJM", "JO": "JOR",
    "JQ": "UMI", "JU": "ATF",
    "KE": "KEN", "KG": "KGZ", "KN": "PRK", "KQ": "UMI", "KR": "KIR",
    "KS": "KOR", "KT": "CXR", "KU": "KWT", "KV": "XKX", "KZ": "KAZ",
    "LA": "LAO", "LE": "LBN", "LG": "LVA", "LH": "LTU", "LI": "LBR",
    "LO": "SVK", "LQ": "UMI", "LS": "LIE", "LT": "LSO", "LU": "LUX",
    "LY": "LBY",
    "MA": "MDG", "MB": "MTQ", "MC": "MAC", "MD": "MDA", "MF": "MYT",
    "MG": "MNG", "MH": "MSR", "MI": "MWI", "MJ": "MNE", "MK": "MKD",
    "ML": "MLI", "MN": "MCO", "MO": "MAR", "MP": "MUS", "MQ": "UMI",
    "MR": "MRT", "MT": "MLT", "MU": "OMN", "MV": "MDV", "MX": "MEX",
    "MY": "MYS", "MZ": "MOZ",
    "NC": "NCL", "NE": "NIU", "NF": "NFK", "NG": "NER", "NH": "VUT",
    "NI": "NGA", "NL": "NLD", "NN": "SXM", "NO": "NOR", "NP": "NPL",
    "NR": "NRU", "NS": "SUR", "NU": "NIC", "NZ": "NZL",
    "OD": "SSD",
    "PA": "PRY", "PC": "PCN", "PE": "PER", "PK": "PAK", "PL": "POL",
    "PM": "PAN", "PO": "PRT", "PP": "PNG", "PS": "PLW", "PU": "GNB",
    "QA": "QAT",
    "RB": "SRB", "RE": "REU", "RM": "MHL", "RN": "MAF", "RO": "ROU",
    "RP": "PHL", "RQ": "PRI", "RS": "RUS", "RW": "RWA",
    "SA": "SAU", "SB": "SPM", "SC": "KNA", "SE": "SYC", "SF": "ZAF",
    "SG": "SEN", "SH": "SHN", "SI": "SVN", "SL": "SLE", "SM": "SMR",
    "SN": "SGP", "SO": "SOM", "SP": "ESP", "ST": "LCA", "SU": "SDN",
    "SV": "SJM", "SW": "SWE", "SX": "SGS", "SY": "SYR", "SZ": "CHE",
    "TB": "BLM", "TD": "TTO", "TE": "ATF", "TH": "THA", "TI": "TJK",
    "TK": "TCA", "TL": "TKL", "TN": "TON", "TO": "TGO", "TP": "STP",
    "TS": "TUN", "TT": "TLS", "TU": "TUR", "TV": "TUV", "TW": "TWN",
    "TX": "TKM", "TZ": "TZA",
    "UG": "UGA", "UK": "GBR", "UP": "UKR", "US": "USA", "UV": "BFA",
    "UY": "URY", "UZ": "UZB",
    "VC": "VCT", "VE": "VEN", "VI": "VGB", "VM": "VNM", "VQ": "VIR",
    "VT": "VAT",
    "WA": "NAM", "WE": "PSE", "WF": "WLF", "WI": "ESH", "WQ": "UMI",
    "WS": "WSM", "WZ": "SWZ",
    "YM": "YEM",
    "ZA": "ZMB", "ZI": "ZWE",
}


def fips_to_iso3(code: Any) -> str | None:
    """ISO 3166-1 alpha-3 for a FIPS 10-4 country code (GDELT
    ActionGeo_CountryCode); None when missing/unknown — never guessed."""
    if not isinstance(code, str):
        return None
    return _FIPS_TO_ISO3.get(code.strip().upper())


# ------------------------------------------------------ country name → ISO3
# UCDP and ACLED ship country NAMES. Official ISO names come from the bundled
# app/data/countries_iso.json; the alias map covers the common short forms and
# UCDP's historical "(...)" suffixes ("Russia (Soviet Union)", "DR Congo
# (Zaire)"). Lookups also retry with a trailing parenthetical stripped.

_NAME_ALIASES: dict[str, str] = {
    # UCDP historical composites
    "russia (soviet union)": "RUS", "dr congo (zaire)": "COD",
    "myanmar (burma)": "MMR", "cambodia (kampuchea)": "KHM",
    "yemen (north yemen)": "YEM", "zimbabwe (rhodesia)": "ZWE",
    "madagascar (malagasy)": "MDG", "vietnam (north vietnam)": "VNM",
    "serbia (yugoslavia)": "SRB",
    # Short/common forms (ACLED + UCDP use plain names, ISO uses long forms)
    "russia": "RUS", "united states": "USA", "syria": "SYR", "iran": "IRN",
    "venezuela": "VEN", "bolivia": "BOL", "tanzania": "TZA", "vietnam": "VNM",
    "south korea": "KOR", "north korea": "PRK", "turkey": "TUR",
    "czech republic": "CZE", "ivory coast": "CIV", "cote d'ivoire": "CIV",
    "myanmar": "MMR", "burma": "MMR", "laos": "LAO", "moldova": "MDA",
    "bolivia (plurinational state)": "BOL",
    "dr congo": "COD", "democratic republic of congo": "COD",
    "democratic republic of the congo": "COD",
    "republic of congo": "COG", "republic of the congo": "COG", "congo": "COG",
    "bosnia-herzegovina": "BIH", "bosnia and herzegovina": "BIH",
    "kosovo": "XKX", "north macedonia": "MKD", "macedonia": "MKD",
    "united kingdom": "GBR", "palestine": "PSE", "east timor": "TLS",
    "timor-leste": "TLS", "cape verde": "CPV", "brunei": "BRN",
    "swaziland": "SWZ", "eswatini": "SWZ", "micronesia": "FSM",
    "saint vincent and grenadines": "VCT", "gambia": "GMB", "bahamas": "BHS",
    "netherlands": "NLD", "niger": "NER", "philippines": "PHL",
    "sudan": "SDN", "south sudan": "SSD", "taiwan": "TWN",
    "united arab emirates": "ARE",
}


def _norm_name(name: str) -> str:
    return " ".join(name.replace("’", "'").casefold().split())


@lru_cache(maxsize=1)
def _name_index() -> dict[str, str]:
    index = dict(_NAME_ALIASES)
    path = Path(__file__).resolve().parent.parent / "data" / "countries_iso.json"
    try:
        with path.open(encoding="utf-8") as fh:
            rows = json.load(fh)
    except (OSError, ValueError):  # bundled file — should never happen
        log.warning("adminshapes: countries_iso.json unreadable")
        return index
    for row in rows:
        name, a3 = row.get("name"), row.get("alpha-3")
        if name and a3:
            index.setdefault(_norm_name(str(name)), str(a3).upper())
    return index


def country_name_to_iso3(name: Any) -> str | None:
    """ISO 3166-1 alpha-3 for a country name as UCDP/ACLED write it; None
    when unknown — never guessed."""
    if not isinstance(name, str) or not name.strip():
        return None
    index = _name_index()
    norm = _norm_name(name)
    hit = index.get(norm)
    if hit:
        return hit
    if norm.endswith(")") and "(" in norm:  # "russia (soviet union)" pattern
        return index.get(norm[: norm.rindex("(")].strip())
    return None
