"""UCDP GED candidate events — research-grade armed-conflict events with
NAMED actors (side_a / side_b / dyad), the threat-actor complement to GDELT's
CAMEO-coded news entities.

The UCDP API (ucdpapi.pcr.uu.se) became TOKEN-GATED (``x-ucdp-access-token``
header) — verified live 2026-07-11; there is no keyless path anymore. Like
ACLED, the layer therefore requires a configured ``ucdp_token`` and degrades
to an empty FeatureCollection with ``unavailable: true`` without one — never
fabricated events, never a 500.

Deaths fields are UCDP's own *estimates* (best/low/high); GDELT mention
counts are reporting intensity. The two must never be conflated — they ride
in separately-named props.
"""

from __future__ import annotations

from typing import Any

from app.config import get_settings
from app.geo.adminshapes import country_name_to_iso3
from app.upstream import cache, get_client

# Monthly candidate releases; this version string is the latest stable GED
# candidate at wiring time. Override via query if UCDP bumps it.
DEFAULT_VERSION = "25.0.11"
_API = "https://ucdpapi.pcr.uu.se/api/candidateged/{version}"
_TTL = 3600.0
_MAX_FEATURES = 4000
_PAGESIZE = 1000

# type_of_violence per UCDP codebook.
VIOLENCE_TYPES = {1: "state-based conflict", 2: "non-state conflict", 3: "one-sided violence"}

# where_prec → admin level whose real boundary the frontend should shade
# (1=some city/town, 2=some other defined point, 3=region/province level).
def shape_level_for_where_prec(value: Any) -> str | None:
    prec = parse_where_prec(value)
    if prec in (1, 2):
        return "adm2"
    if prec == 3:
        return "adm1"
    return None

# where_prec (UCDP codebook location precision) → approximate uncertainty
# radius in metres, so the frontend can draw an area instead of a bare pin.
# 6 (country-only) and 7 (international waters/estimate) are too coarse for a
# meaningful area — no radius is fabricated for them.
_WHERE_PREC_RADIUS_M: dict[int, float] = {
    1: 2000.0,
    2: 25000.0,
    3: 40000.0,
    4: 90000.0,
    5: 100000.0,
}


def parse_where_prec(value: Any) -> int | None:
    """Defensive int parse of UCDP ``where_prec`` (missing/garbage → None)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def radius_for_where_prec(value: Any) -> float | None:
    """Uncertainty radius in metres for a ``where_prec`` code; None when the
    precision is absent or too coarse (never fabricated)."""
    prec = parse_where_prec(value)
    return _WHERE_PREC_RADIUS_M.get(prec) if prec is not None else None


async def ucdp_events(version: str = DEFAULT_VERSION) -> dict[str, Any]:
    """UCDP GED candidate events as GeoJSON. Empty + ``unavailable`` without a
    configured token (honest degrade, mirrors the ACLED pattern)."""
    token = get_settings().ucdp_token
    if not token:
        return {
            "type": "FeatureCollection",
            "features": [],
            "unavailable": True,
            "note": "UCDP API requires a token (set OSINT_UCDP_TOKEN); no keyless path exists",
        }

    key = f"conflict:ucdp:{version}"

    async def load() -> dict[str, Any]:
        features: list[dict[str, Any]] = []
        page = 0
        client = get_client()
        while len(features) < _MAX_FEATURES:
            try:
                r = await client.get(
                    _API.format(version=version),
                    params={"pagesize": _PAGESIZE, "page": page},
                    headers={"x-ucdp-access-token": token},
                )
            except Exception as e:  # noqa: BLE001 — degrade, never 500 the layer
                if not features:
                    return {
                        "type": "FeatureCollection", "features": [], "unavailable": True,
                        "note": str(e)[:120],
                    }
                break
            if r.status_code != 200:
                if not features:
                    return {
                        "type": "FeatureCollection", "features": [], "unavailable": True,
                        "note": f"ucdp http {r.status_code}",
                    }
                break
            body = r.json()
            rows = body.get("Result") or []
            for ev in rows:
                try:
                    lat, lon = float(ev["latitude"]), float(ev["longitude"])
                except (KeyError, TypeError, ValueError):
                    continue
                side_a = str(ev.get("side_a") or "Unknown")
                side_b = str(ev.get("side_b") or "Unknown")
                tov = ev.get("type_of_violence")
                where_prec = parse_where_prec(ev.get("where_prec"))
                country = ev.get("country")
                features.append(
                    {
                        "type": "Feature",
                        "id": f"conflict_ucdp:{ev.get('id')}",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {
                            "kind": "conflict",
                            "source": "ucdp-ged-candidate",
                            "id": str(ev.get("id")),
                            # Named threat actors — the whole point of the layer.
                            "side_a": side_a,
                            "side_b": side_b,
                            "dyad_name": ev.get("dyad_name"),
                            "type_of_violence": VIOLENCE_TYPES.get(tov, str(tov)),
                            # UCDP's own death ESTIMATES (not GDELT mention counts).
                            "deaths_best": ev.get("best"),
                            "deaths_low": ev.get("low"),
                            "deaths_high": ev.get("high"),
                            "date_start": ev.get("date_start"),
                            "country": country,
                            "where": ev.get("where_description"),
                            # Location precision → uncertainty area (metres);
                            # radius_m is None when precision is unknown/coarse.
                            "where_prec": where_prec,
                            "radius_m": radius_for_where_prec(where_prec),
                            # Country + admin level so the frontend can shade the
                            # REAL admin unit (country name → ISO3; UCDP ships names).
                            "iso3": country_name_to_iso3(country) if country else None,
                            "shape_level": shape_level_for_where_prec(where_prec),
                            "label": (
                                f"{side_a} vs {side_b} · {VIOLENCE_TYPES.get(tov, 'violence')}"
                            ),
                        },
                    }
                )
            if len(rows) < _PAGESIZE:
                break
            page += 1
        return {"type": "FeatureCollection", "features": features[:_MAX_FEATURES]}

    out = await cache.get_or_fetch(key, _TTL, load)
    if out.get("unavailable"):
        # Transient upstream failure — retry sooner than the hourly TTL.
        cache.shorten(key, 60.0)
    return out
