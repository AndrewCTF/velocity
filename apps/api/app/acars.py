"""Keyless ACARS / VDL / HFDL / SATCOM feed — airframes.io community firehose.

airframes.io aggregates aircraft datalink messages (ACARS over VHF, VDL-M2,
HFDL, Iridium/Inmarsat SATCOM) from ~6000+ volunteer ground stations worldwide
and exposes them over a **keyless** public REST API — no token, no key. This is
the aircraft-messaging analog of the open ADS-B feeds: where ADS-B gives
position, ACARS gives the operational text (OOOI times, position reports, free
text, CPDLC, weather requests) the cockpit datalinks.

Coverage is community-station-shaped (dense over North America / Europe / busy
oceanic tracks, sparse elsewhere) — NOT a guaranteed-global feed, and we do not
claim one. ``/api/acars`` reports the live station + position counts so the
coverage is always measured, never asserted.

Endpoints (verified keyless, HTTP 200):
  GET https://api.airframes.io/messages?limit=N   → recent messages (N≤100)
  GET https://api.airframes.io/stats              → station/mode counts
"""

from __future__ import annotations

import logging
from typing import Any

from app.upstream import cache, get_client

log = logging.getLogger("velocity.acars")

_BASE = "https://api.airframes.io"
_UA = "Mozilla/5.0 (compatible; velocity-osint/1.0)"
_TTL_S = 15.0  # airframes updates continuously; 15s keeps us off their back
_STATS_TTL_S = 60.0


def normalize(m: dict[str, Any]) -> dict[str, Any]:
    """Flatten one airframes message to the compact shape the globe/intel layers
    use. ``flight`` arrives as a nested object; ``station`` as ``{ident,...}``;
    ``latitude``/``longitude`` are present only on position-bearing messages.
    """
    fl = m.get("flight")
    if isinstance(fl, dict):
        flight = fl.get("flight") or fl.get("flightIata") or fl.get("flightIcao")
    else:
        flight = fl
    st = m.get("station")
    station = st.get("ident") if isinstance(st, dict) else st
    text = (m.get("text") or "").strip() or None
    # The real airframe identity lives on the nested `airframe` object; the
    # top-level `tail` is usually null. `airframe.icao` is the ICAO24 hex — the
    # reliable key for matching an ACARS message to a selected ADS-B aircraft.
    af = m.get("airframe")
    af = af if isinstance(af, dict) else {}
    tail = m.get("tail") or af.get("tail") or None
    icao = m.get("fromHex") or af.get("icao") or None
    # Datalink SYSTEM (the carrier), normalized from the raw sourceType/source.
    # The raw `mode` is unreliable here (VDL puts the mode digit there, e.g. "2"),
    # so the system facet keys off sourceType: dumpvdl2→VDL, dumphfdl→HFDL,
    # acarsdec→ACARS (VHF), satdump/iridium/inmarsat→SATCOM.
    st_type = (m.get("sourceType") or m.get("source") or "").lower()
    if "hfdl" in st_type:
        system = "HFDL"
    elif "vdl" in st_type:
        system = "VDL"
    elif any(k in st_type for k in ("irid", "inmar", "satcom", "aero", "satdump")):
        system = "SATCOM"
    elif st_type:
        system = "ACARS"
    else:
        system = None
    return {
        "id": m.get("id"),
        "t": m.get("timestamp"),
        "label": m.get("label"),
        "tail": tail,
        "icao": icao.lower() if isinstance(icao, str) else None,
        "flight": flight or None,
        "lat": m.get("latitude"),
        "lon": m.get("longitude"),
        "freq": m.get("frequency"),
        "mode": m.get("mode") or m.get("sourceType") or m.get("source"),
        "system": system,
        "station": station,
        "text": text,
    }


async def fetch_recent(limit: int = 100) -> list[dict[str, Any]]:
    """Recent datalink messages, normalized. ``limit`` capped at 100 (airframes'
    own server cap). Best-effort: upstream errors return ``[]`` rather than
    raising, so a flaky firehose never 500s the route."""
    limit = max(1, min(int(limit), 100))

    async def load() -> list[dict[str, Any]]:
        # NOTE: bare /messages intermittently 404s; /messages?limit=N is stable.
        r = await get_client().get(
            f"{_BASE}/messages",
            params={"limit": limit},
            headers={"User-Agent": _UA, "Accept": "application/json"},
        )
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []

    try:
        raw = await cache.get_or_fetch(f"acars:msgs:{limit}", _TTL_S, load)
    except Exception as exc:  # noqa: BLE001 — keyless community feed, degrade
        log.debug("acars: fetch failed: %s", exc)
        return []
    return [normalize(m) for m in (raw or [])]


def to_geojson(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Position-bearing messages → a GeoJSON FeatureCollection for a globe layer.

    Only messages with lat+lon become features (ACARS carries position
    intermittently); the rest are aircraft-keyed by tail/flight and surface in a
    list/panel instead. Mirrors the cams layer shape (``routes/cams.py``).
    """
    feats: list[dict[str, Any]] = []
    for m in messages:
        if m.get("lat") is None or m.get("lon") is None:
            continue
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [m["lon"], m["lat"], 0]},
            "properties": {
                "id": f"acars:{m.get('id')}",
                "tail": m.get("tail"),
                "flight": m.get("flight"),
                "label": m.get("label"),
                "mode": m.get("mode"),
                "station": m.get("station"),
                "text": m.get("text"),
                "t": m.get("t"),
                "kind": "acars",
            },
        })
    return {"type": "FeatureCollection", "features": feats}


async def stats() -> dict[str, Any]:
    """airframes station/mode counts (the live coverage measure)."""
    async def load() -> dict[str, Any]:
        r = await get_client().get(
            f"{_BASE}/stats", headers={"User-Agent": _UA, "Accept": "application/json"}
        )
        r.raise_for_status()
        return r.json()

    try:
        return await cache.get_or_fetch("acars:stats", _STATS_TTL_S, load)
    except Exception as exc:  # noqa: BLE001
        log.debug("acars: stats failed: %s", exc)
        return {}
