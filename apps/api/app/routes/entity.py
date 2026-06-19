"""GET /api/entity/{id} — entity enrichment.

Resolves an entity id (kind:source-key) into a rich profile by hitting the
appropriate upstream:
- aircraft:{icao24}  → OpenSky metadata + Hexdb registration lookup; airline
                       prefix from callsign lifts operator/IATA from a built-in
                       ICAO→airline table when Hexdb is silent on operator.
- vessel:{mmsi}      → GFW vessel search (if GFW_TOKEN configured); always
                       layered with no-key fields: ITU-R M.585 MMSI MID flag
                       lookup + OSM Nominatim reverse-geocode for nearest port
                       from the last AISStream position.
- quake:{id}         → USGS event detail
"""

from __future__ import annotations

import math
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.config import Settings, get_settings
from app.correlate.store import store
from app.upstream import cache, get_client

router = APIRouter(tags=["entity"])

# Strict id shapes. These values are interpolated into upstream URL PATHS
# (hexdb.io, planespotters.net, USGS) — without validation a crafted eid like
# "aircraft:../../x?y=" steers the backend to arbitrary paths on those hosts.
ICAO24_RE = re.compile(r"^[0-9a-fA-F]{6}$")
MMSI_RE = re.compile(r"^\d{1,9}$")
QUAKE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# ── ITU-R M.585 MMSI MID → flag country (top maritime flag states + key MIDs).
# Maps the first 3 digits of an MMSI to ISO country / flag of registry. Not
# exhaustive — covers ~80 frequently observed flags. Source: ITU MID table.
MMSI_MID_FLAG: dict[str, str] = {
    "201": "Albania", "202": "Andorra", "203": "Austria", "204": "Azores",
    "205": "Belgium", "206": "Belarus", "207": "Bulgaria", "208": "Vatican",
    "209": "Cyprus", "210": "Cyprus", "211": "Germany", "212": "Cyprus",
    "213": "Georgia", "214": "Moldova", "215": "Malta", "216": "Armenia",
    "218": "Germany", "219": "Denmark", "220": "Denmark", "224": "Spain",
    "225": "Spain", "226": "France", "227": "France", "228": "France",
    "229": "Malta", "230": "Finland", "231": "Faroe Islands", "232": "United Kingdom",
    "233": "United Kingdom", "234": "United Kingdom", "235": "United Kingdom",
    "236": "Gibraltar", "237": "Greece", "238": "Croatia", "239": "Greece",
    "240": "Greece", "241": "Greece", "242": "Morocco", "243": "Hungary",
    "244": "Netherlands", "245": "Netherlands", "246": "Netherlands",
    "247": "Italy", "248": "Malta", "249": "Malta", "250": "Ireland",
    "251": "Iceland", "252": "Liechtenstein", "253": "Luxembourg",
    "254": "Monaco", "255": "Madeira", "256": "Malta", "257": "Norway",
    "258": "Norway", "259": "Norway", "261": "Poland", "262": "Montenegro",
    "263": "Portugal", "264": "Romania", "265": "Sweden", "266": "Sweden",
    "267": "Slovakia", "268": "San Marino", "269": "Switzerland",
    "270": "Czech Republic", "271": "Turkey", "272": "Ukraine",
    "273": "Russia", "274": "North Macedonia", "275": "Latvia",
    "276": "Estonia", "277": "Lithuania", "278": "Slovenia", "279": "Serbia",
    "301": "Anguilla", "303": "Alaska (USA)", "304": "Antigua and Barbuda",
    "305": "Antigua and Barbuda", "306": "Curaçao", "307": "Aruba",
    "308": "Bahamas", "309": "Bahamas", "310": "Bermuda", "311": "Bahamas",
    "312": "Belize", "314": "Barbados", "316": "Canada", "319": "Cayman Islands",
    "321": "Costa Rica", "323": "Cuba", "325": "Dominica",
    "327": "Dominican Republic", "329": "Guadeloupe", "330": "Grenada",
    "331": "Greenland", "332": "Guatemala", "334": "Honduras", "336": "Haiti",
    "338": "United States", "339": "Jamaica", "341": "Saint Kitts and Nevis",
    "343": "Saint Lucia", "345": "Mexico", "347": "Martinique",
    "348": "Montserrat", "350": "Nicaragua", "351": "Panama", "352": "Panama",
    "353": "Panama", "354": "Panama", "355": "Panama", "356": "Panama",
    "357": "Panama", "358": "Puerto Rico", "359": "El Salvador",
    "361": "Saint Pierre and Miquelon", "362": "Trinidad and Tobago",
    "364": "Turks and Caicos Islands", "366": "United States",
    "367": "United States", "368": "United States", "369": "United States",
    "370": "Panama", "371": "Panama", "372": "Panama", "373": "Panama",
    "374": "Panama", "375": "Saint Vincent and the Grenadines",
    "376": "Saint Vincent and the Grenadines",
    "377": "Saint Vincent and the Grenadines", "378": "British Virgin Islands",
    "379": "United States Virgin Islands",
    "401": "Afghanistan", "403": "Saudi Arabia", "405": "Bangladesh",
    "408": "Bahrain", "410": "Bhutan", "412": "China", "413": "China",
    "414": "China", "416": "Taiwan", "417": "Sri Lanka", "419": "India",
    "422": "Iran", "423": "Azerbaijan", "425": "Iraq", "428": "Israel",
    "431": "Japan", "432": "Japan", "434": "Turkmenistan", "436": "Kazakhstan",
    "437": "Uzbekistan", "438": "Jordan", "440": "South Korea",
    "441": "South Korea", "443": "Palestine", "445": "North Korea",
    "447": "Kuwait", "450": "Lebanon", "451": "Kyrgyzstan", "453": "Macao",
    "455": "Maldives", "457": "Mongolia", "459": "Nepal", "461": "Oman",
    "463": "Pakistan", "466": "Qatar", "468": "Syria", "470": "United Arab Emirates",
    "472": "Tajikistan", "473": "Yemen", "475": "Yemen", "477": "Hong Kong",
    "478": "Bosnia and Herzegovina",
    "501": "Adelie Land", "503": "Australia", "506": "Myanmar", "508": "Brunei",
    "510": "Micronesia", "511": "Palau", "512": "New Zealand", "514": "Cambodia",
    "515": "Cambodia", "516": "Christmas Island", "518": "Cook Islands",
    "520": "Fiji", "523": "Cocos (Keeling) Islands", "525": "Indonesia",
    "529": "Kiribati", "531": "Laos", "533": "Malaysia", "536": "Northern Mariana Islands",
    "538": "Marshall Islands", "540": "New Caledonia", "542": "Niue",
    "544": "Nauru", "546": "French Polynesia", "548": "Philippines",
    "550": "Timor-Leste", "553": "Papua New Guinea", "555": "Pitcairn Island",
    "557": "Solomon Islands", "559": "American Samoa", "561": "Samoa",
    "563": "Singapore", "564": "Singapore", "565": "Singapore", "566": "Singapore",
    "567": "Thailand", "570": "Tonga", "572": "Tuvalu", "574": "Vietnam",
    "576": "Vanuatu", "577": "Vanuatu", "578": "Wallis and Futuna",
    "601": "South Africa", "603": "Angola", "605": "Algeria", "607": "Saint Paul",
    "608": "Ascension Island", "609": "Burundi", "610": "Benin", "611": "Botswana",
    "612": "Central African Republic", "613": "Cameroon", "615": "Congo",
    "616": "Comoros", "617": "Cape Verde", "618": "Crozet Archipelago",
    "619": "Côte d'Ivoire", "620": "Comoros", "621": "Djibouti", "622": "Egypt",
    "624": "Ethiopia", "625": "Eritrea", "626": "Gabon", "627": "Ghana",
    "629": "Gambia", "630": "Guinea-Bissau", "631": "Equatorial Guinea",
    "632": "Guinea", "633": "Burkina Faso", "634": "Kenya", "635": "Kerguelen",
    "636": "Liberia", "637": "Liberia", "638": "South Sudan", "642": "Libya",
    "644": "Lesotho", "645": "Mauritius", "647": "Madagascar", "649": "Mali",
    "650": "Mozambique", "654": "Mauritania", "655": "Malawi", "656": "Niger",
    "657": "Nigeria", "659": "Namibia", "660": "Réunion", "661": "Rwanda",
    "662": "Sudan", "663": "Senegal", "664": "Seychelles", "665": "Saint Helena",
    "666": "Somalia", "667": "Sierra Leone", "668": "São Tomé and Príncipe",
    "669": "Eswatini", "670": "Chad", "671": "Togo", "672": "Tunisia",
    "674": "Tanzania", "675": "Uganda", "676": "Democratic Republic of the Congo",
    "677": "Tanzania", "678": "Zambia", "679": "Zimbabwe",
    "701": "Argentina", "710": "Brazil", "720": "Bolivia", "725": "Chile",
    "730": "Colombia", "735": "Ecuador", "740": "Falkland Islands",
    "745": "French Guiana", "750": "Guyana", "755": "Paraguay", "760": "Peru",
    "765": "Suriname", "770": "Uruguay", "775": "Venezuela",
}

# Airline ICAO 3-letter callsign prefix → (operator name, IATA code).
# ~50 commonly observed commercial airlines; covers most callsigns seen in
# OpenSky state vectors. Not exhaustive — fallback is None.
AIRLINE_ICAO: dict[str, tuple[str, str]] = {
    "AAL": ("American Airlines", "AA"),
    "ACA": ("Air Canada", "AC"),
    "AFL": ("Aeroflot", "SU"),
    "AFR": ("Air France", "AF"),
    "AIC": ("Air India", "AI"),
    "ANA": ("All Nippon Airways", "NH"),
    "ANZ": ("Air New Zealand", "NZ"),
    "ASA": ("Alaska Airlines", "AS"),
    "AUA": ("Austrian Airlines", "OS"),
    "AWE": ("US Airways", "US"),
    "AZA": ("ITA Airways", "AZ"),
    "BAW": ("British Airways", "BA"),
    "BEL": ("Brussels Airlines", "SN"),
    "CCA": ("Air China", "CA"),
    "CES": ("China Eastern", "MU"),
    "CFG": ("Condor", "DE"),
    "CPA": ("Cathay Pacific", "CX"),
    "CSN": ("China Southern", "CZ"),
    "DAL": ("Delta Air Lines", "DL"),
    "DLH": ("Lufthansa", "LH"),
    "EIN": ("Aer Lingus", "EI"),
    "ELY": ("El Al", "LY"),
    "ETD": ("Etihad", "EY"),
    "EVA": ("EVA Air", "BR"),
    "EZY": ("easyJet", "U2"),
    "FDX": ("FedEx Express", "FX"),
    "FIN": ("Finnair", "AY"),
    "GEC": ("Lufthansa Cargo", "LH"),
    "IBE": ("Iberia", "IB"),
    "ICE": ("Icelandair", "FI"),
    "JAL": ("Japan Airlines", "JL"),
    "JBU": ("JetBlue", "B6"),
    "KAL": ("Korean Air", "KE"),
    "KLM": ("KLM", "KL"),
    "LAN": ("LATAM", "LA"),
    "LOT": ("LOT Polish Airlines", "LO"),
    "NAX": ("Norwegian", "DY"),
    "QFA": ("Qantas", "QF"),
    "QTR": ("Qatar Airways", "QR"),
    "RYR": ("Ryanair", "FR"),
    "SAS": ("Scandinavian Airlines", "SK"),
    "SIA": ("Singapore Airlines", "SQ"),
    "SVA": ("Saudia", "SV"),
    "SWA": ("Southwest Airlines", "WN"),
    "SWR": ("Swiss", "LX"),
    "THA": ("Thai Airways", "TG"),
    "THY": ("Turkish Airlines", "TK"),
    "TVF": ("Transavia France", "TO"),
    "UAE": ("Emirates", "EK"),
    "UAL": ("United Airlines", "UA"),
    "UPS": ("UPS Airlines", "5X"),
    "VIR": ("Virgin Atlantic", "VS"),
    "VLG": ("Vueling", "VY"),
    "WJA": ("WestJet", "WS"),
    "WZZ": ("Wizz Air", "W6"),
}


@router.get("/api/entity/{eid:path}")
async def entity(
    eid: str,
    callsign: str | None = None,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    if ":" not in eid:
        raise HTTPException(400, "expect <kind>:<id>")
    kind, raw = eid.split(":", 1)
    raw = raw.strip()
    if not raw:
        raise HTTPException(400, "empty id")

    if kind == "aircraft":
        if not ICAO24_RE.match(raw):
            raise HTTPException(400, "aircraft id must be a 6-char ICAO24 hex")
        return await _enrich_aircraft(raw, callsign)
    if kind == "vessel":
        if not MMSI_RE.match(raw):
            raise HTTPException(400, "vessel id must be a numeric MMSI")
        return await _enrich_vessel(raw, settings)
    if kind == "quake":
        if not QUAKE_ID_RE.match(raw):
            raise HTTPException(400, "malformed quake id")
        return await _enrich_quake(raw)
    raise HTTPException(404, f"no enrichment for kind {kind}")


# ── aircraft ─────────────────────────────────────────────────────────────
def _airline_from_callsign(callsign: str | None) -> tuple[str, str, str] | None:
    """Return (icao_prefix, operator_name, iata_code) if callsign starts with a
    known 3-letter ICAO airline prefix. Callsigns look like 'DAL123' / 'BAW42K'
    — first 3 alpha chars are the operator's ICAO code per ICAO Doc 8585."""
    if not callsign:
        return None
    cs = callsign.strip().upper()
    if len(cs) < 3 or not cs[:3].isalpha():
        return None
    hit = AIRLINE_ICAO.get(cs[:3])
    if not hit:
        return None
    return cs[:3], hit[0], hit[1]


async def _planespotters_photo(icao24: str) -> dict[str, Any] | None:
    """Planespotters Net public photo lookup by ICAO24 hex.
    No auth required; returns the first photo's thumbnail + credit data so
    the UI can render an inline preview. 12h cache per icao24."""
    # Planespotters photos are photographer-copyrighted (non-commercial API
    # terms) — omitted on a commercial deployment.
    if get_settings().commercial_mode:
        return None
    key = f"planespotters:hex:{icao24}"

    async def load() -> dict[str, Any] | None:
        try:
            r = await get_client().get(
                f"https://api.planespotters.net/pub/photos/hex/{icao24}",
            )
        except Exception:
            return None
        if r.status_code != 200:
            return None
        try:
            j = r.json()
        except Exception:
            return None
        photos = j.get("photos") or []
        if not photos:
            return None
        first = photos[0] or {}
        thumb = first.get("thumbnail") or {}
        thumb_large = first.get("thumbnail_large") or {}
        thumb_url = thumb.get("src")
        full_url = thumb_large.get("src") or thumb_url
        if not thumb_url:
            return None
        return {
            "photo_thumb_url": thumb_url,
            "photo_full_url": full_url,
            "photo_photographer": first.get("photographer"),
            "photo_link": first.get("link"),
            "photo_license": first.get("license"),
        }

    return await cache.get_or_fetch(key, 12 * 3600.0, load)


async def _enrich_aircraft(icao24: str, callsign: str | None = None) -> dict[str, Any]:
    """Hexdb is a free, no-auth registry mapping ICAO24 → reg/operator/type.
    We layer an airline-callsign prefix lookup on top — Hexdb knows the
    aircraft's registered owner (often a leasing co.), but the callsign tells
    us the actual operator on that flight."""
    icao24 = icao24.lower()
    key = f"hexdb:{icao24}"

    async def load() -> dict[str, Any]:
        # https://hexdb.io/api-docs
        r = await get_client().get(f"https://hexdb.io/api/v1/aircraft/{icao24}")
        if r.status_code != 200:
            return {"icao24": icao24, "kind": "aircraft", "enrichment": None}
        j = r.json()
        return {
            "kind": "aircraft",
            "icao24": icao24,
            "registration": j.get("Registration"),
            "type": j.get("Type"),
            "icao_type": j.get("ICAOTypeCode"),
            "operator": j.get("RegisteredOwners"),
            "manufacturer": j.get("Manufacturer"),
            "country_origin": j.get("Country"),
            "mode_s": j.get("ModeS"),
            "source": "hexdb.io",
        }

    base = await cache.get_or_fetch(key, 24 * 3600.0, load)

    # Layer a Planespotters photo on top (separately cached, 12h) so the user
    # gets a visual reference for what the aircraft looks like.
    photo = await _planespotters_photo(icao24)

    # Layer the callsign-derived airline ID on top — never cached with the
    # Hexdb response because callsign varies per flight.
    airline = _airline_from_callsign(callsign)
    if airline is not None or photo is not None:
        out = dict(base)
        if airline is not None:
            icao_prefix, op_name, iata = airline
            out["operator_callsign"] = icao_prefix
            out["operator_iata"] = iata
            # Only override Hexdb operator if it was blank / missing.
            if not out.get("operator"):
                out["operator"] = op_name
        if photo is not None:
            for k, v in photo.items():
                if v is not None and v != "":
                    out[k] = v
        return out
    return base


# ── vessels ──────────────────────────────────────────────────────────────
def _flag_from_mmsi(mmsi: str) -> str | None:
    """ITU-R M.585: the MMSI's first 3 digits ('MID') encode the flag state.
    Some MMSIs are special (coast stations start with 00, group calls 0…) —
    we only recognize standard ship MMSIs whose first digit is 2–7."""
    digits = mmsi.strip()
    if len(digits) < 3 or not digits[:3].isdigit():
        return None
    if digits[0] not in "234567":
        return None  # coast stations, SAR, AtoN, etc. — not a ship flag
    return MMSI_MID_FLAG.get(digits[:3])


async def _nominatim_reverse(lat: float, lon: float) -> dict[str, Any] | None:
    """Reverse-geocode via OSM Nominatim. Free, no auth, but rate-limited and
    requires a contactable User-Agent — we set 'osint-console/0.1' per their
    usage policy. Cached 1h per ~11km grid cell (lat/lon rounded to 1 dp)."""
    # The public nominatim.openstreetmap.org instance forbids commercial/heavy
    # use; on a commercial deployment use the self-hosted NOMINATIM_URL, else skip.
    s = get_settings()
    base = s.nominatim_url or ("" if s.commercial_mode else "https://nominatim.openstreetmap.org")
    if not base:
        return None
    # Round to 1 decimal place (~11 km grid) so nearby vessels share a cache
    # entry and we don't hammer Nominatim from every selection.
    grid_lat = round(lat, 1)
    grid_lon = round(lon, 1)
    key = f"nominatim:rev:{grid_lat}:{grid_lon}"

    async def load() -> dict[str, Any] | None:
        try:
            r = await get_client().get(
                f"{base.rstrip('/')}/reverse",
                params={
                    "lat": f"{grid_lat}",
                    "lon": f"{grid_lon}",
                    "format": "jsonv2",
                    "zoom": "10",
                    # extratags=1 makes Nominatim include the OSM `extratags`
                    # map in the response, which is where wikidata IDs live.
                    # Without this the wikidata link below was never populated.
                    "extratags": "1",
                },
                headers={"User-Agent": "osint-console/0.1"},
            )
        except Exception:
            return None
        if r.status_code != 200:
            return None
        try:
            j = r.json()
        except Exception:
            return None
        # Filter out responses that name the surrounding water body — a ship
        # in the middle of the Baltic should NOT enrich as "nearest port:
        # Baltic Sea". Anything in OSM's `natural` category with a sea-like
        # `type` is geographic water, not a port; drop the row so the caller
        # falls back to "no nearby port" instead of showing a misleading match.
        category = (j or {}).get("category")
        type_ = (j or {}).get("type")
        if category == "natural" and type_ in {"sea", "ocean", "bay", "strait"}:
            return None
        return j  # type: ignore[no-any-return]

    return await cache.get_or_fetch(key, 3600.0, load)


async def _wikipedia_summary(title: str) -> dict[str, Any] | None:
    """Wikipedia REST page summary: returns {thumbnail.source, extract, …}.
    No auth, cached 24h per title. Used to surface a ship photo + blurb when
    GFW gives us a `shipname`, and as a fallback to a nearest-port article."""
    clean = (title or "").strip()
    if not clean:
        return None
    key = f"wiki:summary:{clean.lower()}"

    async def load() -> dict[str, Any] | None:
        # Wikipedia normalizes spaces → underscores; the REST endpoint accepts
        # either, but underscores are friendlier to URL routers / caches.
        from urllib.parse import quote

        path = quote(clean.replace(" ", "_"), safe="")
        try:
            r = await get_client().get(
                f"https://en.wikipedia.org/api/rest_v1/page/summary/{path}",
                headers={"User-Agent": "osint-console/0.1"},
            )
        except Exception:
            return None
        if r.status_code != 200:
            return None
        try:
            j = r.json()
        except Exception:
            return None
        # Wikipedia returns a "disambiguation" / "no_extract" type when the
        # article isn't a clean match; treat those as misses so we fall back.
        if j.get("type") in {"disambiguation", "no-extract"}:
            return None
        thumb = (j.get("thumbnail") or {}).get("source")
        extract = j.get("extract")
        page_url = (j.get("content_urls") or {}).get("desktop", {}).get("page")
        if not thumb and not extract:
            return None
        out: dict[str, Any] = {}
        if thumb:
            out["photo_thumb_url"] = thumb
        if extract:
            out["description"] = extract
        if page_url:
            out["photo_link"] = page_url
        out["photo_credit"] = "Wikipedia"
        return out

    return await cache.get_or_fetch(key, 24 * 3600.0, load)


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return float(2 * r * math.asin(math.sqrt(a)))


async def _enrich_vessel(mmsi: str, settings: Settings) -> dict[str, Any]:
    """Layered enrichment, key-optional:
       1. MMSI MID → flag country (no-key, instant).
       2. Last position from AISStream observation store → Nominatim reverse
          geocode for a 'near' description + distance (no-key, 1h cache).
       3. GFW v3 vessel identity search (only when GFW_TOKEN is set).
    Returns the union of whatever each layer produced."""
    out: dict[str, Any] = {
        "kind": "vessel",
        "mmsi": mmsi,
        "source": "mmsi+nominatim",
    }

    # Layer 1: flag country from MMSI MID.
    flag_country = _flag_from_mmsi(mmsi)
    if flag_country:
        out["flag_country"] = flag_country

    # Layer 2: reverse-geocode the last known position (from AIS observation
    # store) so the user sees a human-readable location.
    last = store.latest_for(f"vessel:{mmsi}")
    if last is not None:
        rev = await _nominatim_reverse(last.lat, last.lon)
        if rev:
            # Nominatim's display_name is the verbose path; 'name' (if any) is
            # the single-place label. Either is useful as a "near" string.
            name = rev.get("name") or rev.get("display_name")
            if name:
                out["nearest_port"] = str(name)[:140]
            # Where Nominatim returns its centroid, compute distance from
            # the actual vessel position so the UI can show "12 km from".
            try:
                rlat = float(rev.get("lat"))
                rlon = float(rev.get("lon"))
                out["nearest_port_distance_km"] = round(
                    _haversine_km(last.lat, last.lon, rlat, rlon), 1
                )
            except (TypeError, ValueError):
                pass
            # OSM provides a Wikidata id on many places — link if present.
            wikidata = (rev.get("extratags") or {}).get("wikidata")
            if wikidata:
                out["wikidata_url"] = f"https://www.wikidata.org/wiki/{wikidata}"

    # Layer 3: GFW (token-gated). Global Fishing Watch is CC BY-NC — disabled on
    # a commercial deployment regardless of token.
    token = "" if settings.commercial_mode else settings.gfw_token
    if not token:
        if not (flag_country or "nearest_port" in out):
            out["enrichment"] = None
            # Only surface the "configure GFW" note when literally nothing
            # else came back. If the MMSI MID flag or a nearest port resolved,
            # the panel already has useful content — pinning a "not configured"
            # banner on top of it just looks like an error state. Operators
            # who care about GFW data will notice the missing identity fields
            # (IMO, gear_type, …) on their own.
            out["note"] = "GFW_TOKEN not configured — showing MMSI+Nominatim only"
        # Even without GFW we can still try a Wikipedia photo for the nearest
        # port — gives the user *something* to look at.
        port_name = out.get("nearest_port")
        if port_name:
            wiki = await _wikipedia_summary(str(port_name).split(",")[0])
            if wiki:
                for k, v in wiki.items():
                    if v is not None and v != "" and k not in out:
                        out[k] = v
        return out

    key = f"gfw:vessel:{mmsi}"

    async def load() -> dict[str, Any]:
        r = await get_client().get(
            "https://gateway.api.globalfishingwatch.org/v3/vessels/search",
            params={"query": mmsi, "datasets[0]": "public-global-vessel-identity:latest"},
            headers={"Authorization": f"Bearer {token}"},
        )
        if r.status_code != 200:
            return {"kind": "vessel", "mmsi": mmsi, "enrichment": None}
        j = r.json()
        entries = j.get("entries") or []
        first = entries[0] if entries else {}
        return {
            "kind": "vessel",
            "mmsi": mmsi,
            "name": first.get("shipname"),
            "imo": first.get("imo"),
            "callsign": first.get("callsign"),
            "flag": first.get("flag"),
            "gear_type": first.get("geartype"),
            "vessel_type": first.get("vesselType"),
            "length_m": first.get("lengthM"),
            "width_m": first.get("widthM"),
            "first_seen": first.get("firstTransmissionDate"),
            "last_seen": first.get("lastTransmissionDate"),
            "source": "gfw.v3",
        }

    gfw = await cache.get_or_fetch(key, 3600.0, load)
    # Merge — GFW values take precedence (more specific), but no-key fields
    # remain visible (flag_country, nearest_port, etc).
    merged = dict(out)
    for k, v in gfw.items():
        if v is not None and v != "":
            merged[k] = v

    # Layer 4: Wikipedia ship article (best-effort photo + blurb). Try the
    # GFW shipname first; if no article (or no thumbnail) fall back to the
    # nearest-port article so the user always has *some* visual anchor.
    ship_name = merged.get("name")
    wiki: dict[str, Any] | None = None
    if ship_name:
        wiki = await _wikipedia_summary(str(ship_name))
    if not wiki and merged.get("nearest_port"):
        wiki = await _wikipedia_summary(str(merged["nearest_port"]).split(",")[0])
    if wiki:
        for k, v in wiki.items():
            if v is not None and v != "" and k not in merged:
                merged[k] = v
    return merged


# ── quakes ───────────────────────────────────────────────────────────────
async def _enrich_quake(qid: str) -> dict[str, Any]:
    key = f"usgs:detail:{qid}"

    async def load() -> dict[str, Any]:
        r = await get_client().get(
            "https://earthquake.usgs.gov/fdsnws/event/1/query",
            params={"format": "geojson", "eventid": qid},
        )
        if r.status_code != 200:
            return {"kind": "quake", "id": qid, "enrichment": None}
        j = r.json()
        p = j.get("properties") or {}
        g = j.get("geometry") or {}
        coords = g.get("coordinates") or [None, None, None]
        return {
            "kind": "quake",
            "id": qid,
            "mag": p.get("mag"),
            "place": p.get("place"),
            "time": p.get("time"),
            "url": p.get("url"),
            "felt": p.get("felt"),
            "mmi": p.get("mmi"),
            "cdi": p.get("cdi"),
            "alert": p.get("alert"),
            "tsunami": bool(p.get("tsunami")),
            "depth_km": coords[2],
            "lon": coords[0],
            "lat": coords[1],
            "source": "usgs",
        }

    return await cache.get_or_fetch(key, 600.0, load)
