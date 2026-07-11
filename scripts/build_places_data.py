#!/usr/bin/env python3
"""Build the committed places reference JSON under ``apps/api/app/data/``.

Rerunnable, keyless. Sources (all public, no API key):

- OurAirports ``airports.csv`` / ``runways.csv`` / ``airport-frequencies.csv``
  (``https://davidmegginson.github.io/ourairports-data/<name>.csv``).
- NGA World Port Index CSV (``wpi.csv``,
  ``https://msi.nga.mil/api/publications/download?type=view&key=16920959/SFH00000/UpdatedPub150.csv``).
- FAA NASR 28-day subscription ZIP → ``ILS.txt`` (fixed-width, CATEGORY at byte
  offset 173 width 9). The dated ZIP URL rots every 28 days, so this script
  does NOT auto-download it — pass ``--ils-txt`` pointing at an already
  extracted ``ILS.txt`` (see NASR link in docs/places-airspace-plan.md §1).
  Without it, every row gets ``ils_category=null`` (honest degrade, not an
  error).
- Wikidata SPARQL (``https://query.wikidata.org/sparql``) for military bases,
  direct ``P31`` (no subclass recursion — that 504s) of Q245016/Q744099/
  Q18691599.

Usage::

    python3 scripts/build_places_data.py --cache-dir /path/to/cache \\
        [--ils-txt /path/to/ILS.txt] [--out-dir apps/api/app/data]

Downloads land in ``--cache-dir`` (never the repo) and are reused on rerun;
delete a file from the cache dir to force a re-fetch. The NASR ZIP itself is
never fetched or cached by this script — only its already-extracted
``ILS.txt`` is consumed, and it is never committed.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = ROOT / "apps" / "api" / "app" / "data"

USER_AGENT = "OSINT-places-build/1.0 (repo build script; keyless reference data)"

CSV_SOURCES = {
    "airports.csv": "https://davidmegginson.github.io/ourairports-data/airports.csv",
    "runways.csv": "https://davidmegginson.github.io/ourairports-data/runways.csv",
    "airport-frequencies.csv": "https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv",
    "wpi.csv": "https://msi.nga.mil/api/publications/download?type=view&key=16920959/SFH00000/UpdatedPub150.csv",
}

# Wikidata: direct P31 of these three classes, each with a coordinate (P625).
# NOT subclass recursion (wdt:P31/wdt:P279*) — that query 504s upstream.
WIKIDATA_CLASSES = {
    "wikidata_air.json": ("Q744099", "air"),
    "wikidata_naval.json": ("Q18691599", "naval"),
    "wikidata_army.json": ("Q245016", "army"),
}
# Priority when one QID matches multiple classes: most-specific wins.
_BRANCH_PRIORITY = {"air": 0, "naval": 1, "army": 2}

MILITARY_NAME_RE = re.compile(r"AFB|Air Force Base|Naval Air|NAS |Army Airfield|MCAS", re.I)


# ── generic fetch helpers ────────────────────────────────────────────────────


def _curl_get(url: str, dest: Path, *, extra_headers: list[str] | None = None) -> None:
    """Fetch ``url`` to ``dest`` via curl -4 (host IPv6 is broken on this box)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["curl", "-4", "-sS", "-L", "--fail", "-o", str(dest), "-A", USER_AGENT]
    for h in extra_headers or []:
        cmd += ["-H", h]
    cmd.append(url)
    print(f"  fetching {url}", file=sys.stderr)
    subprocess.run(cmd, check=True, timeout=300)


def fetch_csv(name: str, cache_dir: Path) -> Path:
    path = cache_dir / name
    if path.exists() and path.stat().st_size > 0:
        return path
    _curl_get(CSV_SOURCES[name], path)
    return path


def fetch_wikidata_class(cache_name: str, qid: str, cache_dir: Path) -> Path:
    path = cache_dir / cache_name
    if path.exists() and path.stat().st_size > 0:
        return path
    query = (
        "SELECT ?item ?itemLabel ?coord WHERE { "
        f"?item wdt:P31 wd:{qid} . ?item wdt:P625 ?coord . "
        'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }'
    )
    dest = path
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "curl", "-4", "-sS", "-G", "--fail", "-o", str(dest),
        "https://query.wikidata.org/sparql",
        "--data-urlencode", f"query={query}",
        "-H", "Accept: application/sparql-results+json",
        "-H", f"User-Agent: {USER_AGENT}",
        "--max-time", "90",
    ]
    print(f"  querying wikidata P31={qid}", file=sys.stderr)
    subprocess.run(cmd, check=True, timeout=120)
    return dest


# ── (a) airports.json v2 + airports_detail.json ─────────────────────────────


def _to_float(v: str) -> float | None:
    v = (v or "").strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _to_bool01(v: str) -> bool:
    return str(v or "").strip() == "1"


def load_airports_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def build_airports(rows: list[dict[str, str]]) -> tuple[list[dict[str, Any]], set[str]]:
    """Returns (airports.json rows, set of idents kept — for detail filtering)."""
    out: list[dict[str, Any]] = []
    kept_idents: set[str] = set()
    for row in rows:
        atype_raw = str(row.get("type") or "")
        atype = atype_raw.replace("_airport", "")
        if atype not in ("large", "medium"):
            continue
        lat = _to_float(row.get("latitude_deg") or "")
        lon = _to_float(row.get("longitude_deg") or "")
        if lat is None or lon is None:
            continue
        ident = str(row.get("ident") or "").strip()
        name = str(row.get("name") or "").strip()
        kept_idents.add(ident)
        out.append(
            {
                "name": name,
                "iata": str(row.get("iata_code") or "").strip(),
                "icao": ident,
                "lat": lat,
                "lon": lon,
                "type": atype,
                "iso": str(row.get("iso_country") or "").strip(),
                "elevation_ft": (
                    int(float(row["elevation_ft"])) if str(row.get("elevation_ft") or "").strip() else None
                ),
                "municipality": str(row.get("municipality") or "").strip(),
                "scheduled_service": str(row.get("scheduled_service") or "").strip().lower() == "yes",
                "military": bool(MILITARY_NAME_RE.search(name)),
            }
        )
    return out, kept_idents


def load_ils_categories(ils_txt: Path | None, airports_rows: list[dict[str, str]]) -> dict[tuple[str, str], str]:
    """Parse FAA NASR ILS.txt (ILS1 records) → {(icao_ident, runway_end): category}.

    ILS.txt keys ILS1 records by the FAA LID (e.g. "JFK"), not ICAO ident
    (e.g. "KJFK"); join via ``local_code`` from OurAirports airports.csv,
    which carries the same FAA LID for US airports. Fixed-width offsets
    (1-indexed per Layout_Data/ils_rf.txt, converted to 0-indexed slices):
      runway end ident: offset 16 width 3  -> [15:18]
      airport LID (E7):  offset 160 width 4 -> [159:163]
      ILS category (I20): offset 173 width 9 -> [172:181]
    Verified against the live NASR effective-2026-06-11 sample: KJFK 04R=IIIB,
    13L=II, 22L=III, 04L/22R/31L/31R=I.
    """
    if ils_txt is None or not ils_txt.exists():
        print("  no --ils-txt given/found — ils_category will be null everywhere", file=sys.stderr)
        return {}

    lid_to_icao: dict[str, str] = {}
    for row in airports_rows:
        lid = str(row.get("local_code") or "").strip()
        icao = str(row.get("ident") or "").strip()
        if lid and icao and str(row.get("iso_country") or "") == "US":
            lid_to_icao[lid] = icao

    out: dict[tuple[str, str], str] = {}
    with ils_txt.open(encoding="latin-1") as fh:
        for line in fh:
            if not line.startswith("ILS1"):
                continue
            if len(line) < 181:
                continue
            rwy_end = line[15:18].strip()
            lid = line[159:163].strip()
            category = line[172:181].strip()
            if not (rwy_end and lid and category):
                continue
            icao = lid_to_icao.get(lid)
            if not icao:
                continue
            out[(icao, rwy_end)] = category
    return out


def load_ils_presence_osm(
    cache_dir: Path, overpass_url: str, airports_out: list[dict[str, Any]]
) -> set[str]:
    """GLOBAL ILS presence from OSM: ``aeroway=navigationaid`` elements tagged
    ils/localizer/glidepath, associated to the nearest kept airport within
    ~6 km. Presence-only — never a CAT I/II/III category (that stays NASR/US;
    OurAirports navaids.csv carries NO ILS rows at all, verified 2026-07-11).
    Empty set when ``overpass_url`` is not supplied (honest degrade)."""
    if not overpass_url:
        print("  no --overpass-url — ils_present stays limited to NASR-cat airports", file=sys.stderr)
        return set()
    path = cache_dir / "osm_ils.json"
    if not (path.exists() and path.stat().st_size > 0):
        # OSM tags ILS installations as man_made=beacon + beacon:type=ILS
        # (~2.1k uses per taginfo 2026-07-11); aeroway=navigationaid values are
        # runway *lighting* codes (als/papi/…), not ILS — verified live.
        query = '[out:json][timeout:300];nwr["beacon:type"~"ILS",i];out center;'
        cmd = [
            "curl", "-4", "-sS", "--fail", "-o", str(path), overpass_url,
            "--data-urlencode", f"data={query}", "-A", USER_AGENT, "--max-time", "360",
        ]
        print("  querying overpass for ILS navigation aids", file=sys.stderr)
        subprocess.run(cmd, check=True, timeout=400)
    with path.open(encoding="utf-8") as fh:
        elements = json.load(fh).get("elements", [])
    # Coarse grid index over kept airports for nearest-within-6km association.
    grid: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for a in airports_out:
        grid.setdefault((int(a["lat"] * 10), int(a["lon"] * 10)), []).append(a)
    present: set[str] = set()
    import math

    for el in elements:
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        best, best_d = None, 6.0  # km
        ci, cj = int(lat * 10), int(lon * 10)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for a in grid.get((ci + di, cj + dj), []):
                    dlat = (a["lat"] - lat) * 111.0
                    dlon = (a["lon"] - lon) * 111.0 * math.cos(math.radians(lat))
                    d = math.hypot(dlat, dlon)
                    if d < best_d:
                        best, best_d = a, d
        if best is not None:
            present.add(str(best["icao"]))
    print(f"  osm ILS elements={len(elements)} matched airports={len(present)}", file=sys.stderr)
    return present


def build_airports_detail(
    runways_path: Path,
    freq_path: Path,
    kept_idents: set[str],
    ils_map: dict[tuple[str, str], str],
    ils_present: set[str] | None = None,
) -> dict[str, dict[str, Any]]:
    detail: dict[str, dict[str, Any]] = {}

    with runways_path.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            ident = str(row.get("airport_ident") or "").strip()
            if ident not in kept_idents:
                continue
            le_ident = str(row.get("le_ident") or "").strip()
            he_ident = str(row.get("he_ident") or "").strip()
            # Each runway END can carry its own ILS approach with its own
            # category (e.g. KJFK 04R=IIIB vs the opposite end 22L=III) — the
            # spec's runways[] schema has one `ils_category` per row, so we
            # surface the le-end's category there (falling back to he-end if
            # le has none) and additionally keep both explicit sub-fields so
            # a differing he-end category is never silently dropped.
            le_cat = ils_map.get((ident, le_ident))
            he_cat = ils_map.get((ident, he_ident))
            rec = {
                "le_ident": le_ident,
                "he_ident": he_ident,
                "length_ft": int(float(row["length_ft"])) if str(row.get("length_ft") or "").strip() else None,
                "width_ft": int(float(row["width_ft"])) if str(row.get("width_ft") or "").strip() else None,
                "surface": str(row.get("surface") or "").strip(),
                "lighted": _to_bool01(row.get("lighted") or ""),
                "closed": _to_bool01(row.get("closed") or ""),
                "ils_category": le_cat or he_cat,
                "ils_category_le": le_cat,
                "ils_category_he": he_cat,
            }
            detail.setdefault(ident, {"runways": [], "frequencies": []})["runways"].append(rec)

    with freq_path.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            ident = str(row.get("airport_ident") or "").strip()
            if ident not in kept_idents:
                continue
            rec = {
                "type": str(row.get("type") or "").strip(),
                "desc": str(row.get("description") or "").strip(),
                "mhz": _to_float(row.get("frequency_mhz") or ""),
            }
            detail.setdefault(ident, {"runways": [], "frequencies": []})["frequencies"].append(rec)

    # Airport-level global ILS presence (navaids.csv) — presence only, never a
    # category. An airport with a NASR per-end category is by definition
    # ILS-present too.
    for ident, rec_d in detail.items():
        has_cat = any(r.get("ils_category") for r in rec_d.get("runways", []))
        rec_d["ils_present"] = bool(has_cat or (ils_present and ident in ils_present))

    return detail


# ── (b) ports.json v2 + ports_detail.json ───────────────────────────────────

_PORT_STRING_FIELDS = {
    "harborSize": "Harbor Size",
    "harborType": "Harbor Type",
    "shelter": "Shelter Afforded",
    "repairs": "Repairs",
    "dryDock": "Dry Dock",
    "railway": "Railway",
    "portSecurity": "Port Security",
    "harborUse": "Harbor Use",
    "cargoPierDepth": "Cargo Pier Depth (m)",
    "channelDepth": "Channel Depth (m)",
}
_PORT_MAX_VESSEL_FIELDS = {
    "maxVesselLength": "Maximum Vessel Length (m)",
    "maxVesselBeam": "Maximum Vessel Beam (m)",
    "maxVesselDraft": "Maximum Vessel Draft (m)",
}


def build_ports(wpi_path: Path) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    ports_rows: list[dict[str, Any]] = []
    detail: dict[str, dict[str, Any]] = {}
    with wpi_path.open(encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            wpi_raw = str(row.get("World Port Index Number") or "").strip()
            if not wpi_raw:
                continue
            wpi = str(int(float(wpi_raw)))
            name = str(row.get("Main Port Name") or "").strip() or f"WPI {wpi}"
            lat = _to_float(row.get("Latitude") or "")
            lon = _to_float(row.get("Longitude") or "")
            if lat is None or lon is None:
                continue
            ports_rows.append({"name": name, "lat": lat, "lon": lon, "wpi": wpi})

            drec: dict[str, Any] = {}
            for key, col in _PORT_STRING_FIELDS.items():
                val = str(row.get(col) or "").strip()
                if val and val not in ("", " "):
                    if key in ("cargoPierDepth", "channelDepth"):
                        depth = _to_float(val)
                        drec[key] = depth
                    else:
                        drec[key] = val
                elif key in ("cargoPierDepth", "channelDepth"):
                    drec[key] = None
            for key, col in _PORT_MAX_VESSEL_FIELDS.items():
                num = _to_float(row.get(col) or "")
                if num is not None and num > 0:
                    drec[key] = num
            detail[wpi] = drec
    return ports_rows, detail


# ── (c) bases.json ───────────────────────────────────────────────────────────


def _wkt_point_to_lonlat(wkt: str) -> tuple[float, float] | None:
    m = re.match(r"Point\(([-\d.]+)\s+([-\d.]+)\)", wkt.strip())
    if not m:
        return None
    return float(m.group(1)), float(m.group(2))


def build_bases(cache_dir: Path) -> list[dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}  # qid -> row (with _priority for merge)
    for cache_name, (qid, branch) in WIKIDATA_CLASSES.items():
        path = fetch_wikidata_class(cache_name, qid, cache_dir)
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
        for b in data["results"]["bindings"]:
            item_uri = b["item"]["value"]
            item_qid = item_uri.rsplit("/", 1)[-1]
            coord = b.get("coord", {}).get("value", "")
            lonlat = _wkt_point_to_lonlat(coord)
            if lonlat is None:
                continue
            lon, lat = lonlat
            label = b.get("itemLabel", {}).get("value") or item_qid
            prio = _BRANCH_PRIORITY[branch]
            existing = best.get(item_qid)
            if existing is None or prio < existing["_priority"]:
                best[item_qid] = {
                    "name": label,
                    "lat": lat,
                    "lon": lon,
                    "branch": branch,
                    "_priority": prio,
                }
    rows = list(best.values())
    for r in rows:
        r.pop("_priority", None)
    return rows


# ── (d) infrastructure.json + military.json ─────────────────────────────────
#
# Unified facility rows {kind:"facility", category, subcategory, name, lat,
# lon, source, ...extras}. Sources (all keyless):
#   power / nuclear ....... WRI Global Power Plant Database v1.3 (CSV in zip)
#   ground_station ........ SatNOGS Network API
#   telescope / launch .... Wikidata SPARQL (astronomical observatory Q1254933,
#                           spaceport Q194188)
#   water_treatment / desalination / datacenter / telecom_hub
#                          Overpass snapshot (gated on --overpass-url)
# military.json: HIFLD/Esri-federal MIRTA points (831 US DoD sites) +
# Wikidata garrisons (Q88556) / military training areas (Q1778846).

WRI_GPPD_ZIP = "https://wri-dataportal-prod.s3.amazonaws.com/manual/global_power_plant_database_v_1_3.zip"
SATNOGS_STATIONS = "https://network.satnogs.org/api/stations/?format=json"
MIRTA_QUERY = (
    "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/"
    "MIRTA_Points_A_view/FeatureServer/0/query"
)

# Professional facility naming per WRI primary_fuel.
FUEL_LABELS = {
    "Wind": "wind turbine farm",
    "Nuclear": "nuclear power station",
    "Geothermal": "geothermal power plant",
    "Hydro": "hydroelectric power plant",
    "Solar": "solar photovoltaic plant",
    "Gas": "gas-fired thermal power plant",
    "Coal": "coal-fired thermal power plant",
    "Oil": "oil-fired thermal power plant",
    "Biomass": "biomass power plant",
    "Waste": "waste-to-energy plant",
    "Wave and Tidal": "wave/tidal power plant",
    "Petcoke": "petcoke-fired thermal power plant",
    "Cogeneration": "cogeneration plant",
    "Storage": "energy storage facility",
}

INFRA_WIKIDATA_CLASSES = {
    "wikidata_observatory.json": ("Q1254933", "telescope", "astronomical observatory"),
    "wikidata_spaceport.json": ("Q194188", "launch", "spaceport / launch facility"),
}
MIL_WIKIDATA_CLASSES = {
    "wikidata_garrison.json": ("Q88556", "garrison", "garrison"),
    "wikidata_training.json": ("Q1778846", "training", "military training area"),
}

OVERPASS_FACILITY_QUERIES = {
    # category -> (overpass filter clauses, subcategory label)
    "water_treatment": ('nwr["man_made"="wastewater_plant"]', "wastewater treatment plant"),
    "water_works": ('nwr["man_made"="water_works"]', "water treatment works"),
    "desalination": ('nwr["water_works"="desalination"];nwr["man_made"="desalination_plant"]', "desalination plant"),
    "datacenter": ('nwr["telecom"="data_center"];nwr["building"="data_centre"]', "data center"),
    "telecom_hub": ('nwr["telecom"="exchange"]', "telecom exchange / hub"),
}


def build_power_plants(cache_dir: Path) -> list[dict[str, Any]]:
    zpath = cache_dir / "global_power_plant_database.zip"
    if not (zpath.exists() and zpath.stat().st_size > 0):
        _curl_get(WRI_GPPD_ZIP, zpath)
    import io
    import zipfile

    rows: list[dict[str, Any]] = []
    with zipfile.ZipFile(zpath) as zf:
        csv_name = next(n for n in zf.namelist() if n.endswith("global_power_plant_database.csv"))
        with zf.open(csv_name) as fh:
            for row in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8")):
                lat = _to_float(row.get("latitude") or "")
                lon = _to_float(row.get("longitude") or "")
                name = str(row.get("name") or "").strip()
                if lat is None or lon is None or not name:
                    continue
                fuel = str(row.get("primary_fuel") or "").strip()
                cap = _to_float(row.get("capacity_mw") or "")
                year_raw = str(row.get("commissioning_year") or "").strip()
                rows.append(
                    {
                        "id": str(row.get("gppd_idnr") or "").strip(),
                        "category": "power",
                        "subcategory": FUEL_LABELS.get(fuel, f"{fuel.lower()} power plant" if fuel else "power plant"),
                        "fuel": fuel,
                        "nuclear": fuel == "Nuclear",
                        "name": name,
                        "lat": lat,
                        "lon": lon,
                        "iso3": str(row.get("country") or "").strip(),
                        "capacity_mw": cap,
                        "commissioning_year": int(float(year_raw)) if year_raw else None,
                        "owner": str(row.get("owner") or "").strip() or None,
                        "source": "wri-gppd-v1.3",
                    }
                )
    return rows


def build_satnogs_stations(cache_dir: Path) -> list[dict[str, Any]]:
    path = cache_dir / "satnogs_stations.json"
    if not (path.exists() and path.stat().st_size > 0):
        _curl_get(SATNOGS_STATIONS, path, extra_headers=["Accept: application/json"])
    with path.open(encoding="utf-8") as fh:
        stations = json.load(fh)
    rows: list[dict[str, Any]] = []
    for s in stations:
        lat, lon = s.get("lat"), s.get("lng")
        if lat is None or lon is None:
            continue
        rows.append(
            {
                "id": f"satnogs-{s.get('id')}",
                "category": "ground_station",
                "subcategory": "satellite ground station (SatNOGS)",
                "name": str(s.get("name") or f"SatNOGS {s.get('id')}"),
                "lat": float(lat),
                "lon": float(lon),
                "altitude_m": s.get("altitude"),
                "status": s.get("status"),
                "source": "satnogs-network",
            }
        )
    return rows


def build_wikidata_facilities(cache_dir: Path, classes: dict[str, tuple[str, str, str]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for cache_name, (qid, category, sublabel) in classes.items():
        path = fetch_wikidata_class(cache_name, qid, cache_dir)
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
        for b in data["results"]["bindings"]:
            item_qid = b["item"]["value"].rsplit("/", 1)[-1]
            if item_qid in seen:
                continue
            lonlat = _wkt_point_to_lonlat(b.get("coord", {}).get("value", ""))
            if lonlat is None:
                continue
            lon, lat = lonlat
            seen.add(item_qid)
            rows.append(
                {
                    "id": f"wd-{item_qid}",
                    "category": category,
                    "subcategory": sublabel,
                    "name": b.get("itemLabel", {}).get("value") or item_qid,
                    "lat": lat,
                    "lon": lon,
                    "source": "wikidata",
                }
            )
    return rows


def build_mirta(cache_dir: Path) -> list[dict[str, Any]]:
    """Esri federal-data MIRTA points (831 US DoD installations/ranges/training
    areas), paged via resultOffset."""
    path = cache_dir / "mirta_points.json"
    if not (path.exists() and path.stat().st_size > 0):
        feats: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = cache_dir / f"_mirta_{offset}.json"
            _curl_get(
                f"{MIRTA_QUERY}?where=1%3D1&outFields=*&resultOffset={offset}&f=geojson", page
            )
            with page.open(encoding="utf-8") as fh:
                data = json.load(fh)
            got = data.get("features", [])
            feats.extend(got)
            page.unlink()
            if not got or not (data.get("properties") or {}).get("exceededTransferLimit"):
                break
            offset += len(got)
        path.write_text(json.dumps({"features": feats}), encoding="utf-8")
    with path.open(encoding="utf-8") as fh:
        feats = json.load(fh)["features"]
    rows: list[dict[str, Any]] = []
    for f in feats:
        geom = f.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        lon, lat = geom["coordinates"][:2]
        p = f.get("properties") or {}
        name = str(p.get("siteName") or p.get("featureName") or "").strip()
        if not name:
            continue
        rows.append(
            {
                "id": f"mirta-{p.get('OBJECTID')}",
                "category": "military_installation",
                "subcategory": "US DoD installation/range/training area (MIRTA)",
                "name": name,
                "lat": float(lat),
                "lon": float(lon),
                "component": str(p.get("siteReportingComponent") or "").upper() or None,
                "operational_status": p.get("siteOperationalStatus"),
                "joint_base": str(p.get("isJointBase") or "") == "Yes",
                "state": p.get("stateNameCode"),
                "country": p.get("countryName"),
                "source": "esri-federal-mirta",
            }
        )
    return rows


def build_overpass_facilities(cache_dir: Path, overpass_url: str) -> list[dict[str, Any]]:
    if not overpass_url:
        print("  no --overpass-url — OSM facility categories stay empty (honest degrade)", file=sys.stderr)
        return []
    rows: list[dict[str, Any]] = []
    for category, (clauses, sublabel) in OVERPASS_FACILITY_QUERIES.items():
        path = cache_dir / f"osm_{category}.json"
        if not (path.exists() and path.stat().st_size > 0):
            parts = "".join(c + ";" for c in clauses.split(";") if c)
            query = f"[out:json][timeout:600][maxsize:2073741824];({parts});out center;"
            # Planet-wide way/relation queries 504 under load — try the given
            # endpoint then the other public mirror; a category that still
            # fails is SKIPPED (empty, honest degrade), never fatal.
            mirrors = [overpass_url, "https://overpass-api.de/api/interpreter",
                       "https://overpass.kumi.systems/api/interpreter"]
            ok = False
            for ep in dict.fromkeys(mirrors):
                cmd = [
                    "curl", "-4", "-sS", "--fail", "-o", str(path), ep,
                    "--data-urlencode", f"data={query}", "-A", USER_AGENT, "--max-time", "660",
                ]
                print(f"  querying overpass ({ep.split('/')[2]}): {category}", file=sys.stderr)
                try:
                    subprocess.run(cmd, check=True, timeout=700)
                    ok = True
                    break
                except subprocess.CalledProcessError as exc:
                    path.unlink(missing_ok=True)
                    print(f"    {category} failed on {ep}: {exc}", file=sys.stderr)
            if not ok:
                print(f"  SKIPPING {category} — all overpass endpoints failed (rows stay empty)", file=sys.stderr)
                continue
        with path.open(encoding="utf-8") as fh:
            elements = json.load(fh).get("elements", [])
        out_cat = "water_treatment" if category == "water_works" else category
        # Water plants: OSM carries ~90k mostly-unnamed village sewage works;
        # keep only named/operator-attributed plants (still ~31k) so the
        # committed dataset stays a usable size. Small categories keep all.
        require_name = out_cat == "water_treatment"
        for el in elements:
            lat = el.get("lat") or (el.get("center") or {}).get("lat")
            lon = el.get("lon") or (el.get("center") or {}).get("lon")
            if lat is None or lon is None:
                continue
            tags = el.get("tags") or {}
            if require_name and not (tags.get("name") or tags.get("operator")):
                continue
            rows.append(
                {
                    "id": f"osm-{el.get('type')}-{el.get('id')}",
                    "category": out_cat,
                    "subcategory": sublabel,
                    "name": str(tags.get("name") or tags.get("operator") or sublabel),
                    "lat": float(lat),
                    "lon": float(lon),
                    "operator": tags.get("operator"),
                    "source": "osm-overpass-snapshot",
                }
            )
        print(f"  osm {category}: {len(elements)} elements", file=sys.stderr)
    return rows


# ── main ──────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cache-dir", type=Path, required=True, help="dir for downloaded raw sources (never the repo)")
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR, help="apps/api/app/data by default")
    ap.add_argument("--ils-txt", type=Path, default=None, help="path to extracted NASR ILS.txt (optional)")
    ap.add_argument(
        "--overpass-url", default="", help="Overpass API endpoint for OSM snapshots (optional, e.g. https://overpass-api.de/api/interpreter)"
    )
    args = ap.parse_args()

    cache_dir: Path = args.cache_dir
    out_dir: Path = args.out_dir
    cache_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    ils_txt = args.ils_txt
    if ils_txt is None:
        candidate = cache_dir / "ILS.txt"
        ils_txt = candidate if candidate.exists() else None

    print("== airports ==", file=sys.stderr)
    airports_csv = fetch_csv("airports.csv", cache_dir)
    runways_csv = fetch_csv("runways.csv", cache_dir)
    freq_csv = fetch_csv("airport-frequencies.csv", cache_dir)
    airport_rows_raw = load_airports_csv(airports_csv)
    airports_out, kept_idents = build_airports(airport_rows_raw)
    ils_map = load_ils_categories(ils_txt, airport_rows_raw)
    ils_present = load_ils_presence_osm(cache_dir, args.overpass_url, airports_out)
    airports_detail_out = build_airports_detail(runways_csv, freq_csv, kept_idents, ils_map, ils_present)

    # NASR-preserve guard: without --ils-txt the fresh build carries no
    # categories — merge the previously committed ones instead of silently
    # wiping them (this exact wipe happened live on 2026-07-11).
    prev_detail_path = out_dir / "airports_detail.json"
    if not ils_map and prev_detail_path.exists():
        prev = json.loads(prev_detail_path.read_text(encoding="utf-8"))
        merged = 0
        for ident, rec_d in airports_detail_out.items():
            prev_rwys = {
                (r.get("le_ident"), r.get("he_ident")): r for r in (prev.get(ident) or {}).get("runways", [])
            }
            for r in rec_d.get("runways", []):
                pr = prev_rwys.get((r.get("le_ident"), r.get("he_ident")))
                if pr and any(pr.get(k) for k in ("ils_category", "ils_category_le", "ils_category_he")):
                    for k in ("ils_category", "ils_category_le", "ils_category_he"):
                        r[k] = pr.get(k)
                    merged += 1
            if any(r.get("ils_category") for r in rec_d.get("runways", [])):
                rec_d["ils_present"] = True
        print(f"  preserved NASR ils categories on {merged} runway rows from previous build", file=sys.stderr)

    (out_dir / "airports.json").write_text(json.dumps(airports_out, indent=None, separators=(",", ":")), encoding="utf-8")
    (out_dir / "airports_detail.json").write_text(
        json.dumps(airports_detail_out, indent=None, separators=(",", ":")), encoding="utf-8"
    )
    print(
        f"airports.json rows={len(airports_out)} airports_detail.json keys={len(airports_detail_out)} "
        f"ils_matched={len(ils_map)} ils_present={len(ils_present)}",
        file=sys.stderr,
    )

    print("== ports ==", file=sys.stderr)
    wpi_csv = fetch_csv("wpi.csv", cache_dir)
    ports_out, ports_detail_out = build_ports(wpi_csv)
    (out_dir / "ports.json").write_text(json.dumps(ports_out, indent=None, separators=(",", ":")), encoding="utf-8")
    (out_dir / "ports_detail.json").write_text(
        json.dumps(ports_detail_out, indent=None, separators=(",", ":")), encoding="utf-8"
    )
    print(f"ports.json rows={len(ports_out)} ports_detail.json keys={len(ports_detail_out)}", file=sys.stderr)

    print("== bases ==", file=sys.stderr)
    bases_out = build_bases(cache_dir)
    (out_dir / "bases.json").write_text(json.dumps(bases_out, indent=None, separators=(",", ":")), encoding="utf-8")
    print(f"bases.json rows={len(bases_out)}", file=sys.stderr)

    print("== infrastructure ==", file=sys.stderr)
    infra_rows: list[dict[str, Any]] = []
    infra_rows += build_power_plants(cache_dir)
    infra_rows += build_satnogs_stations(cache_dir)
    infra_rows += build_wikidata_facilities(cache_dir, INFRA_WIKIDATA_CLASSES)
    infra_rows += build_overpass_facilities(cache_dir, args.overpass_url)
    (out_dir / "infrastructure.json").write_text(
        json.dumps(infra_rows, indent=None, separators=(",", ":")), encoding="utf-8"
    )
    from collections import Counter

    cat_counts = Counter(r["category"] for r in infra_rows)
    print(f"infrastructure.json rows={len(infra_rows)} by category={dict(cat_counts)}", file=sys.stderr)

    print("== military ==", file=sys.stderr)
    mil_rows = build_mirta(cache_dir) + build_wikidata_facilities(cache_dir, MIL_WIKIDATA_CLASSES)
    (out_dir / "military.json").write_text(
        json.dumps(mil_rows, indent=None, separators=(",", ":")), encoding="utf-8"
    )
    mil_counts = Counter(r["category"] for r in mil_rows)
    print(f"military.json rows={len(mil_rows)} by category={dict(mil_counts)}", file=sys.stderr)

    print("OK", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
