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
                            "country": ev.get("country"),
                            "where": ev.get("where_description"),
                            "label": f"{side_a} vs {side_b} · {VIOLENCE_TYPES.get(tov, 'violence')}",
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
