"""GET /api/status — PUBLIC live status + honest coverage.

Measured counts from the running snapshot (aircraft in the live feed, refresh
age) plus per-feed green/degraded health. Public (no auth) so it can back a
trust/status page. Deliberately states coverage limits rather than implying
total coverage.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter

from app.config import get_settings
from app.routes import adsb as adsb_routes

router = APIRouter(tags=["status"])

# Steady-state floor the aircraft union should hold (see CLAUDE.md guardrail).
_AIRCRAFT_FLOOR = 8000


def _feed(name: str, ok: bool, detail: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "status": "green" if ok else "degraded", "detail": detail, **extra}


@router.get("/api/status")
async def status() -> dict[str, Any]:
    s = get_settings()
    from app import ais_firehose, ais_keyless, marinetraffic  # noqa: PLC0415

    try:
        fc = await adsb_routes.global_snapshot()
        aircraft = len(fc.get("features") or [])
    except Exception:  # noqa: BLE001 — status must never 500
        aircraft = 0
    age = adsb_routes.snapshot_age_s()

    # Live vessels in the unified store: latest fix per MMSI across ALL AIS
    # sources (Digitraffic, Kystverket/Kystdatahuset, AISStream) accumulated
    # within the store retention window. Northern Europe only without an AISStream
    # key; global AIS needs one.
    vessels = 0
    parked = 0
    try:
        from app.correlate.store import store  # noqa: PLC0415
        from app.routes import maritime  # noqa: PLC0415

        vessels = len(store.latest("vessel"))
        parked = maritime.parked_count()
    except Exception:  # noqa: BLE001 — never let vessels break status
        vessels = 0

    keyless_ais_on = bool(
        ais_firehose.stats().get("enabled")
        or ais_keyless.stats().get("kystdatahuset_enabled")
        or ais_keyless.stats().get("digitraffic_mqtt_enabled")
    )

    feeds = [
        _feed(
            "ADS-B aircraft (OpenSky + airplanes.live grid)",
            aircraft >= _AIRCRAFT_FLOOR,
            f"{aircraft} aircraft in the live snapshot"
            + (f", refreshed {age}s ago" if age is not None else ""),
            count=aircraft,
            age_s=age,
        ),
        _feed(
            "AIS vessels — keyless",
            keyless_ais_on and vessels > 0,
            f"{vessels} vessels ({parked} parked, long-retained) — Northern Europe "
            "only (Norway + Baltic). Global AIS needs an AISStream key (BYOK).",
            count=vessels,
        ),
        _feed(
            "AIS vessels — AISStream (global firehose)",
            bool(s.aisstream_key),
            "GLOBAL coverage — live."
            if s.aisstream_key
            else "Dormant: set AISSTREAM_KEY (free at aisstream.io) for worldwide AIS. "
            "No keyless global feed exists from a server — this is the firehose.",
        ),
        _feed(
            "AIS vessels — MarineTraffic (global, paid)",
            bool(s.marinetraffic_key) and marinetraffic.stats().get("last_error") is None,
            (
                f"{marinetraffic.stats().get('vessels', 0)} vessels"
                + (f" · err: {marinetraffic.stats().get('last_error')}" if marinetraffic.stats().get("last_error") else "")
            )
            if s.marinetraffic_key
            else "Dormant: set MARINETRAFFIC_KEY (paid) to enable. May be IP-restricted.",
        ),
        _feed(
            "GPS/GNSS jamming (derived)",
            aircraft > 0,
            "Inference from ADS-B NACp/NIC degradation — not a direct RF/SIGINT cut.",
        ),
        _feed("USGS earthquakes", True, "Keyless, always on."),
        _feed(
            "Sentinel-1 SAR dark-vessel",
            True,
            "Curated chokepoint AOIs only (e.g. Strait of Hormuz); ~6 h revisit.",
        ),
        _feed(
            "NASA FIRMS fires",
            bool(s.firms_map_key),
            "Key configured." if s.firms_map_key else "Needs MAP_KEY (degrades off).",
        ),
        _feed(
            "AISStream global AIS",
            bool(s.aisstream_key),
            "BYOK, on-demand." if s.aisstream_key else "BYOK — bring a key to enable.",
        ),
    ]

    overall = "operational" if aircraft >= _AIRCRAFT_FLOOR else ("degraded" if aircraft else "down")
    return {
        "status": overall,
        "generated_at": int(time.time()),
        "build_id": s.build_id,
        "aircraft_count": aircraft,
        "aircraft_age_s": age,
        "aircraft_floor": _AIRCRAFT_FLOOR,
        "vessel_count": vessels,
        "parked_count": parked,
        "feeds": feeds,
        "note": (
            "Live counts from the running snapshot. Coverage is uneven by design — "
            "absence of a signal in a thin-coverage region is not evidence of absence. "
            "See /api/intel/sources (authenticated) for per-feed detail."
        ),
    }
