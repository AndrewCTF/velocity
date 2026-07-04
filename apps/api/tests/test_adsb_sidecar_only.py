"""Sidecar-only mode: the snapshot fan-out serves the local tar1090 sidecar union
ALONE when healthy, and backfills with OpenSky/grid only if it falls below the
~8000 floor. No network.
"""

from __future__ import annotations

import pytest

from app.config import get_settings
from app.routes import adsb


@pytest.fixture(autouse=True)
def _clear_settings() -> None:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _fake_ac(n: int) -> list[dict]:
    # Unique hex per aircraft so _aircraft_geojson yields n distinct features.
    return [{"hex": f"{i:06x}", "lat": 10.0, "lon": 20.0, "seen_pos": 0.5} for i in range(n)]


def test_feed_urls_filters_to_localhost_when_sidecar_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "ADSB_FEED_URLS",
        "https://globe.theairtraffic.com/data/aircraft.json,http://127.0.0.1:8090/aircraft.json",
    )
    monkeypatch.setenv("ADSB_SIDECAR_ONLY", "1")
    get_settings.cache_clear()
    assert adsb._feed_urls() == ["http://127.0.0.1:8090/aircraft.json"]

    monkeypatch.setenv("ADSB_SIDECAR_ONLY", "0")
    get_settings.cache_clear()
    assert len(adsb._feed_urls()) == 2  # both mirrors when off


def test_feed_urls_keeps_list_when_sidecar_only_but_no_localhost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Safety: a deploy with the flag on but no sidecar configured must NOT zero
    # the feed — it keeps the remote mirrors rather than serving nothing.
    monkeypatch.setenv("ADSB_FEED_URLS", "https://globe.theairtraffic.com/data/aircraft.json")
    monkeypatch.setenv("ADSB_SIDECAR_ONLY", "1")
    get_settings.cache_clear()
    assert adsb._feed_urls() == ["https://globe.theairtraffic.com/data/aircraft.json"]


@pytest.mark.asyncio
async def test_fanout_healthy_sidecar_serves_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADSB_SIDECAR_ONLY", "1")
    get_settings.cache_clear()

    called = {"opensky": False}

    async def fake_feeds() -> list[dict]:
        return _fake_ac(8001)  # at/above the floor

    async def fake_opensky() -> dict:
        called["opensky"] = True
        return {"type": "FeatureCollection", "features": []}

    monkeypatch.setattr(adsb, "_readsb_feeds", fake_feeds)
    monkeypatch.setattr(adsb, "_opensky_cached", fake_opensky)

    fc = await adsb._do_global_fanout()
    assert len(fc["features"]) == 8001
    assert called["opensky"] is False  # sidecar alone — no backfill tier touched


@pytest.mark.asyncio
async def test_fanout_thin_sidecar_backfills(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADSB_SIDECAR_ONLY", "1")
    get_settings.cache_clear()

    called = {"opensky": False}

    async def fake_feeds() -> list[dict]:
        return _fake_ac(50)  # below the floor → must backfill

    async def fake_opensky() -> dict:
        called["opensky"] = True
        return {"type": "FeatureCollection", "features": []}

    async def empty_list() -> list[dict]:
        return []

    monkeypatch.setattr(adsb, "_readsb_feeds", fake_feeds)
    monkeypatch.setattr(adsb, "_opensky_cached", fake_opensky)
    monkeypatch.setattr(adsb, "_firehose_throttled", empty_list)
    monkeypatch.setattr(adsb, "_grid_throttled", empty_list)

    await adsb._do_global_fanout()
    assert called["opensky"] is True  # thin sidecar → full union backfilled
