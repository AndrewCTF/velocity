"""Unit tests for the keyless readsb aircraft.json feed ingester — no network.

Proves round-robin (one feed per cycle), cross-feed dedup, and stale-slice
eviction without hitting any aggregator.
"""

from __future__ import annotations

import time

import pytest

from app.routes import adsb


@pytest.fixture(autouse=True)
def _reset_feed_state(monkeypatch: pytest.MonkeyPatch) -> None:
    adsb._FEED_SLICES.clear()
    adsb._FEED_NEXT_PULL.clear()
    monkeypatch.setenv("ADSB_FEED_URLS", "https://feed-a/aircraft.json,https://feed-b/aircraft.json")
    monkeypatch.setenv("ADSB_FEED_INTERVAL_S", "0")  # every mirror is due every call
    from app.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _stub_feeds(monkeypatch: pytest.MonkeyPatch, mapping: dict[str, list[dict]]) -> None:
    async def fake(_client, url):  # noqa: ANN001
        return mapping.get(url, [])

    monkeypatch.setattr(adsb, "_fetch_one_feed", fake)


@pytest.mark.asyncio
async def test_pulls_all_due_feeds_concurrently(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_feeds(
        monkeypatch,
        {
            "https://feed-a/aircraft.json": [{"hex": "a1", "lat": 1, "lon": 1}],
            "https://feed-b/aircraft.json": [{"hex": "b1", "lat": 2, "lon": 2}],
        },
    )
    # interval 0 → both mirrors are due → both pulled in one cycle (fresh).
    u = await adsb._readsb_feeds()
    assert len(adsb._FEED_SLICES) == 2
    assert {a["hex"] for a in u} == {"a1", "b1"}


@pytest.mark.asyncio
async def test_dedup_across_feeds_by_hex(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_feeds(
        monkeypatch,
        {
            "https://feed-a/aircraft.json": [{"hex": "DUP", "lat": 1, "lon": 1}],
            # same icao24, different case → must collapse to one
            "https://feed-b/aircraft.json": [{"hex": "dup", "lat": 2, "lon": 2}],
        },
    )
    await adsb._readsb_feeds()
    u = await adsb._readsb_feeds()
    assert len([a for a in u if a["hex"].lower() == "dup"]) == 1


@pytest.mark.asyncio
async def test_skips_positionless_aircraft(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_feeds(
        monkeypatch,
        {"https://feed-a/aircraft.json": [{"hex": "x", "lat": 1, "lon": 1}, {"hex": "y"}]},
    )
    u = await adsb._readsb_feeds()
    assert {a["hex"] for a in u} == {"x"}  # 'y' has no lat/lon → dropped


@pytest.mark.asyncio
async def test_stale_slice_evicted(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_feeds(monkeypatch, {"https://feed-a/aircraft.json": [{"hex": "old", "lat": 1, "lon": 1}]})
    await adsb._readsb_feeds()
    # Force the slice to be older than the eviction window.
    url = "https://feed-a/aircraft.json"
    _, ac = adsb._FEED_SLICES[url]
    adsb._FEED_SLICES[url] = (time.monotonic() - 10_000.0, ac)
    # Re-pull returns nothing (feed went dark) so the stale slice isn't
    # refreshed and gets evicted past the age window.
    monkeypatch.setattr(adsb, "_fetch_one_feed", _noop)
    u = await adsb._readsb_feeds()
    assert u == []
    assert url not in adsb._FEED_SLICES


async def _noop(_client, _url):  # noqa: ANN001
    return []


@pytest.mark.asyncio
async def test_no_feeds_configured_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADSB_FEED_URLS", "")
    from app.config import get_settings

    get_settings.cache_clear()
    assert await adsb._readsb_feeds() == []
