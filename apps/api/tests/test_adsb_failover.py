"""ADS-B degradation ladder: firehoses 429 → OpenSky authed fallback."""

from __future__ import annotations

import asyncio

import httpx
import pytest

import app.routes.adsb as adsb
import app.upstream as upstream


def test_try_firehose_all_429_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(upstream, "_CLIENT", client)
    try:
        assert asyncio.run(adsb._try_firehose()) is None
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


def test_fanout_unions_opensky_firehose_and_grid(monkeypatch: pytest.MonkeyPatch) -> None:
    osky_fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "aircraft:abc123",
                "geometry": {"type": "Point", "coordinates": [1.0, 2.0, 1000]},
                "properties": {"icao24": "abc123", "kind": "aircraft"},
            }
        ],
    }

    async def fake_opensky() -> dict:
        return osky_fc

    async def no_firehose() -> None:
        return None

    async def fake_grid() -> list[dict]:
        # raw aggregator dict for a DIFFERENT aircraft — proves the union.
        return [{"hex": "def456", "lat": 3.0, "lon": 4.0, "alt_baro": 5000}]

    monkeypatch.setattr(adsb, "_opensky_cached", fake_opensky)
    monkeypatch.setattr(adsb, "_firehose_throttled", no_firehose)
    monkeypatch.setattr(adsb, "_grid_fanout", fake_grid)
    out = asyncio.run(adsb._do_global_fanout())
    ids = {f["id"] for f in out["features"]}
    assert ids == {"aircraft:abc123", "aircraft:def456"}  # breadth ∪ grid


def test_grid_overlay_wins_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    # Same icao24 from OpenSky (breadth) and the grid (fresh): grid wins because
    # it is merged last.
    osky_fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "aircraft:abc123",
                "geometry": {"type": "Point", "coordinates": [1.0, 2.0, 1000]},
                "properties": {"icao24": "abc123", "source": "opensky"},
            }
        ],
    }

    async def fake_opensky() -> dict:
        return osky_fc

    async def no_firehose() -> None:
        return None

    async def fake_grid() -> list[dict]:
        return [{"hex": "abc123", "lat": 9.0, "lon": 9.0, "alt_baro": 7000}]

    monkeypatch.setattr(adsb, "_opensky_cached", fake_opensky)
    monkeypatch.setattr(adsb, "_firehose_throttled", no_firehose)
    monkeypatch.setattr(adsb, "_grid_fanout", fake_grid)
    out = asyncio.run(adsb._do_global_fanout())
    feats = out["features"]
    assert len(feats) == 1
    assert feats[0]["properties"]["source"] == "adsb"  # grid feature, not opensky
    assert feats[0]["geometry"]["coordinates"][0] == 9.0


def test_merge_with_previous_carries_recent_drops_stale() -> None:
    import time as _time

    now = _time.time()
    new = {
        "type": "FeatureCollection",
        "features": [{"id": "aircraft:a", "properties": {"seen_at": now}}],
    }
    prev = {
        "type": "FeatureCollection",
        "features": [
            {"id": "aircraft:a", "properties": {"seen_at": now - 5, "old": True}},
            {"id": "aircraft:b", "properties": {"seen_at": now - 5}},
            {"id": "aircraft:c", "properties": {"seen_at": now - 300}},
        ],
    }
    merged = adsb._merge_with_previous(new, prev)  # default max_age_s = 180
    ids = {f["id"] for f in merged["features"]}
    assert ids == {"aircraft:a", "aircraft:b"}  # b carried (5s), c aged out (300s)
    a = next(f for f in merged["features"] if f["id"] == "aircraft:a")
    assert "old" not in a["properties"]  # fresh fix wins over carried copy


def test_opensky_pulls_anonymously_without_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    # OpenSky /states/all serves anonymous requests; with no creds we must still
    # pull it (it is the only ~13k global breadth source) — NOT skip it.
    from app.config import Settings

    monkeypatch.setattr(
        adsb,
        "get_settings",
        lambda: Settings(opensky_client_id="", opensky_client_secret=""),
    )
    raw = {
        "time": 123,
        "states": [
            # icao24, callsign, country, t_pos, last_contact, lon, lat, baro,
            # on_ground, vel, track, vrate, sensors, geo_alt, squawk, spi, src
            ["abc123", "TEST    ", "DE", None, None, 2.0, 1.0, 1000, False,
             100, 90, 0, None, 1100, None, False, 0],
        ],
    }
    captured: dict[str, object] = {}

    async def fake_fetch(tm: object, bbox: object) -> dict:
        captured["anonymous"] = getattr(tm, "enabled", None) is False
        return raw

    monkeypatch.setattr(adsb, "fetch_states", fake_fetch)
    fc = asyncio.run(adsb._try_opensky_global())
    assert fc is not None
    assert captured["anonymous"] is True  # no Authorization header path
    assert len(fc["features"]) == 1
    assert fc["features"][0]["properties"]["source"] == "opensky"
    assert "seen_at" in fc["features"][0]["properties"]
