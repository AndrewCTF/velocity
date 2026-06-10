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


def test_fanout_falls_back_to_opensky(monkeypatch: pytest.MonkeyPatch) -> None:
    fc = {
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

    async def no_firehose() -> None:
        return None

    async def fake_opensky() -> dict:
        return fc

    monkeypatch.setattr(adsb, "_try_firehose", no_firehose)
    monkeypatch.setattr(adsb, "_try_opensky_global", fake_opensky)
    assert asyncio.run(adsb._do_global_fanout()) == fc


def test_opensky_skipped_without_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import Settings

    monkeypatch.setattr(
        adsb,
        "get_settings",
        lambda: Settings(opensky_client_id="", opensky_client_secret=""),
    )
    assert asyncio.run(adsb._try_opensky_global()) is None
