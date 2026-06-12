"""Geo + classification helpers for the intel layer.

The aircraft/vessel category logic MIRRORS the operator-visible frontend
dispatch in ``apps/web/src/globe/adapters/styles.ts`` (a CLAUDE.md sacred
invariant). Keep the two in sync: same ADS-B Mode-S category codes, same
emergency squawk set, same ITU-R M.1371 ship-type buckets, same military
callsign heuristic. An agent reasoning over ``category`` here must see the
same label the analyst sees on the globe.
"""

from __future__ import annotations

import math
import re
from typing import Any, NamedTuple

# ── Aircraft ────────────────────────────────────────────────────────────────

EMERGENCY_SQUAWKS: frozenset[str] = frozenset({"7500", "7600", "7700"})

# styles.ts isMilitaryCallsign — prefixes that don't collide with civil ops.
_MIL_CALLSIGN = re.compile(
    r"^(RCH|REACH|SAM|DUKE|GORDO|BISON|MAGMA|SCAR|PAT|SLAM|KING|EBONY|CONVOY|"
    r"NAVY|GAF|ASCOT|CHAOS|TITAN|VOODOO|MAKO|TREK|TANGO|VENOM|VIPER|HOMR|RAPTR)\d",
    re.IGNORECASE,
)

# adsb sources that imply a military feed (airplanes.live /mil etc.).
_MIL_SOURCES: frozenset[str] = frozenset({"adsb_mil", "airplanes_live"})

AircraftCategory = str  # airliner|private|helicopter|glider|military|emergency


def is_military_callsign(callsign: str | None) -> bool:
    return bool(callsign) and bool(_MIL_CALLSIGN.match(callsign or ""))


def aircraft_category(props: dict[str, Any]) -> AircraftCategory:
    """Classify one aircraft feature's properties.

    Priority order is identical to styles.ts: emergency → military →
    rotorcraft (A6/A7) → glider (B1) → light (A1/A2 = private) → airliner
    (A3/A4/A5 + everything uncategorised, e.g. OpenSky)."""
    squawk = props.get("squawk")
    if squawk is not None and str(squawk) in EMERGENCY_SQUAWKS:
        return "emergency"
    emergency = props.get("emergency")
    if isinstance(emergency, str) and emergency not in ("", "none"):
        return "emergency"

    callsign = props.get("callsign")
    source = props.get("source")
    if is_military_callsign(callsign) or source in _MIL_SOURCES:
        return "military"

    category = props.get("category")
    if category in ("A7", "A6"):
        return "helicopter"
    if category == "B1":
        return "glider"
    if category in ("A1", "A2"):
        return "private"
    return "airliner"


# ── Vessels (ITU-R M.1371 §3.1.1 ship type, 0-99) ────────────────────────────

VesselCategory = str  # cargo|tanker|fishing|passenger|military|sailing|pleasure|tug


def vessel_category(ship_type: Any) -> VesselCategory:
    """Collapse the ITU ship-type code into a render/analysis bucket.

    Mirrors styles.ts vessel classifier. Unknown / missing → 'other'."""
    try:
        code = int(ship_type)
    except (TypeError, ValueError):
        return "other"
    if code == 30:
        return "fishing"
    if code in (31, 32, 52):
        return "tug"
    if code == 35:
        return "military"
    if code == 36:
        return "sailing"
    if code == 37:
        return "pleasure"
    if 40 <= code <= 49:
        return "passenger"
    if code in (50, 53):
        return "tug"
    if code == 55:
        return "military"
    if 60 <= code <= 69:
        return "passenger"
    if 70 <= code <= 79:
        return "cargo"
    if 80 <= code <= 89:
        return "tanker"
    return "other"


# ── Bounding boxes & distance ────────────────────────────────────────────────


class BBox(NamedTuple):
    """West/South/East/North in degrees. Longitude is NOT normalised for
    antimeridian crossings — callers querying near ±180° should split."""

    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float

    def contains(self, lon: float, lat: float) -> bool:
        return (
            self.min_lon <= lon <= self.max_lon
            and self.min_lat <= lat <= self.max_lat
        )

    @property
    def center(self) -> tuple[float, float]:
        return ((self.min_lon + self.max_lon) / 2.0, (self.min_lat + self.max_lat) / 2.0)

    def as_dict(self) -> dict[str, float]:
        return {
            "min_lon": round(self.min_lon, 4),
            "min_lat": round(self.min_lat, 4),
            "max_lon": round(self.max_lon, 4),
            "max_lat": round(self.max_lat, 4),
        }


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Great-circle distance in km."""
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


NM_TO_KM = 1.852


def bbox_from_radius(lat: float, lon: float, radius_nm: float) -> BBox:
    """Square bbox circumscribing a radius (nm) around a point. Longitude
    degrees shrink with latitude, so we widen lon by sec(lat)."""
    radius_km = radius_nm * NM_TO_KM
    dlat = radius_km / 111.32
    c = math.cos(math.radians(lat))
    dlon = radius_km / (111.32 * max(c, 0.01))
    return BBox(
        min_lon=max(-180.0, lon - dlon),
        min_lat=max(-90.0, lat - dlat),
        max_lon=min(180.0, lon + dlon),
        max_lat=min(90.0, lat + dlat),
    )


def feature_lonlat(feature: dict[str, Any]) -> tuple[float, float] | None:
    """Pull (lon, lat) from a GeoJSON Point feature, ignoring altitude."""
    geom = feature.get("geometry") or {}
    if geom.get("type") != "Point":
        return None
    coords = geom.get("coordinates") or []
    if len(coords) < 2:
        return None
    try:
        return float(coords[0]), float(coords[1])
    except (TypeError, ValueError):
        return None
