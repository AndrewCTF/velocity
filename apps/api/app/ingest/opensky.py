"""OpenSky Network ingest.

Per research_updated.md §2.1:
- Basic auth is dead since 18 Mar 2026 — OAuth2 client_credentials is the only
  authenticated path.
- Token TTL ~30 min; we refresh at ≤5 min remaining.
- Anonymous requests still work (400 credits/day) and the API surface is the
  same — we fall back to anonymous when no client_id/secret is configured,
  so the platform shows aircraft on first boot with zero setup.

State-vector shape (positional list — `extended=1` swap not needed):
  0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
  5 longitude, 6 latitude, 7 baro_altitude, 8 on_ground, 9 velocity,
  10 true_track, 11 vertical_rate, 12 sensors, 13 geo_altitude, 14 squawk,
  15 spi, 16 position_source, 17 category
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx

from app.upstream import get_client

TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network/"
    "protocol/openid-connect/token"
)
STATES_URL = "https://opensky-network.org/api/states/all"


@dataclass
class _Token:
    value: str
    expires_at: float  # monotonic seconds


class OpenSkyTokenManager:
    """Caches an OAuth2 access token; refreshes when ≤5 min remains."""

    def __init__(self, client_id: str, client_secret: str) -> None:
        self._cid = client_id
        self._csec = client_secret
        self._token: _Token | None = None

    @property
    def enabled(self) -> bool:
        return bool(self._cid and self._csec)

    async def get(self) -> str | None:
        if not self.enabled:
            return None
        now = time.monotonic()
        if self._token and self._token.expires_at - 300 > now:
            return self._token.value
        r = await get_client().post(
            TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": self._cid,
                "client_secret": self._csec,
            },
        )
        r.raise_for_status()
        j = r.json()
        self._token = _Token(value=j["access_token"], expires_at=now + int(j["expires_in"]))
        return self._token.value


async def fetch_states(
    tm: OpenSkyTokenManager,
    bbox: tuple[float, float, float, float] | None,
) -> dict[str, Any]:
    """Return raw OpenSky JSON ({time, states: [...]})."""
    params: dict[str, Any] = {}
    if bbox is not None:
        lamin, lomin, lamax, lomax = bbox
        params.update(lamin=lamin, lomin=lomin, lamax=lamax, lomax=lomax)

    headers: dict[str, str] = {}
    token = await tm.get()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    r = await get_client().get(STATES_URL, params=params, headers=headers)
    if r.status_code == 429:
        # rate-limit — surface upstream signal to caller
        raise httpx.HTTPStatusError("rate limited", request=r.request, response=r)
    r.raise_for_status()
    return r.json()  # type: ignore[no-any-return]


def states_to_geojson(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize OpenSky state vectors → GeoJSON FeatureCollection."""
    features: list[dict[str, Any]] = []
    for s in raw.get("states") or []:
        if not s or s[5] is None or s[6] is None:
            continue
        icao24 = s[0]
        callsign = (s[1] or "").strip() or None
        lon = float(s[5])
        lat = float(s[6])
        baro_alt = s[7]
        on_ground = bool(s[8])
        velocity = s[9]
        track = s[10]
        geo_alt = s[13]
        squawk = s[14]
        features.append(
            {
                "type": "Feature",
                "id": f"aircraft:{icao24}",
                "geometry": {
                    "type": "Point",
                    "coordinates": [lon, lat, geo_alt if geo_alt is not None else (baro_alt or 0)],
                },
                "properties": {
                    "icao24": icao24,
                    "callsign": callsign,
                    "origin": s[2],
                    "on_ground": on_ground,
                    "velocity_ms": velocity,
                    "track_deg": track,
                    "baro_alt_m": baro_alt,
                    "geo_alt_m": geo_alt,
                    "squawk": squawk,
                    # time_position = unix time of the LAST position report for this
                    # state vector (may be null). last_contact = unix time of the
                    # last message of any kind. Kept so the caller can stamp an
                    # honest position age (seen_pos_s) instead of pretending a
                    # cached daily snapshot is "now" — see _try_opensky_global.
                    "time_position": s[3],
                    "last_contact": s[4],
                    "kind": "aircraft",
                },
            }
        )
    return {"type": "FeatureCollection", "features": features, "as_of": raw.get("time")}
