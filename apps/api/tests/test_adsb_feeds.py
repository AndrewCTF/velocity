"""Unit tests for the keyless readsb aircraft.json feed ingester — no network.

Proves per-feed background pulls, cross-feed dedup (freshest fix wins), and
stale-slice eviction without hitting any aggregator.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from app.routes import adsb


@pytest.fixture(autouse=True)
def _reset_feed_state(monkeypatch: pytest.MonkeyPatch) -> None:
    adsb._FEED_SLICES.clear()
    adsb._FEED_NEXT_PULL.clear()
    adsb._FEED_TASKS.clear()
    monkeypatch.setenv("ADSB_FEED_URLS", "https://feed-a/aircraft.json,https://feed-b/aircraft.json")
    monkeypatch.setenv("ADSB_FEED_INTERVAL_S", "0")  # every mirror is due every call
    from app.config import get_settings

    get_settings.cache_clear()
    yield
    for t in adsb._FEED_TASKS.values():
        t.cancel()
    adsb._FEED_TASKS.clear()
    get_settings.cache_clear()


def _stub_feeds(monkeypatch: pytest.MonkeyPatch, mapping: dict[str, list[dict]]) -> None:
    # The per-feed pull runs _fetch_one_feed_sync(url) -> (ts, aircraft) off the
    # event loop (see _pull_one_feed), so the stub must replace THAT symbol, not
    # the async _fetch_one_feed. ts is captured per-call so freshest-fix ordering
    # still works.
    def fake_sync(url: str) -> tuple[float, list[dict]]:
        return time.monotonic(), mapping.get(url, [])

    monkeypatch.setattr(adsb, "_fetch_one_feed_sync", fake_sync)


async def _drain() -> None:
    """Run the background per-feed pull tasks to completion (stubs resolve
    immediately) so `_FEED_SLICES` is populated before asserting."""
    tasks = list(adsb._FEED_TASKS.values())
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _pull_then_merge() -> list[dict]:
    """One full cycle: kick the per-feed pulls, let them finish, then read the
    merged union."""
    await adsb._readsb_feeds()  # kicks the background pull tasks
    await _drain()  # let them populate the slices
    return await adsb._readsb_feeds()  # merge the now-fresh slices


@pytest.mark.asyncio
async def test_pulls_all_due_feeds_concurrently(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_feeds(
        monkeypatch,
        {
            "https://feed-a/aircraft.json": [{"hex": "a1", "lat": 1, "lon": 1}],
            "https://feed-b/aircraft.json": [{"hex": "b1", "lat": 2, "lon": 2}],
        },
    )
    # interval 0 → both mirrors are due → both pulled (each in its own task).
    u = await _pull_then_merge()
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
    u = await _pull_then_merge()
    assert len([a for a in u if a["hex"].lower() == "dup"]) == 1


@pytest.mark.asyncio
async def test_freshest_fix_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    # Same aircraft in two feeds; the slice with the lower upstream position age
    # (seen_pos) must win so a stale feed can't override a live one.
    _stub_feeds(
        monkeypatch,
        {
            "https://feed-a/aircraft.json": [{"hex": "z", "lat": 1, "lon": 1, "seen_pos": 9.0}],
            "https://feed-b/aircraft.json": [{"hex": "z", "lat": 2, "lon": 2, "seen_pos": 0.5}],
        },
    )
    u = await _pull_then_merge()
    z = [a for a in u if a["hex"] == "z"]
    assert len(z) == 1
    assert z[0]["lat"] == 2  # feed-b (seen_pos 0.5) wins over feed-a (9.0)


@pytest.mark.asyncio
async def test_skips_positionless_aircraft(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_feeds(
        monkeypatch,
        {"https://feed-a/aircraft.json": [{"hex": "x", "lat": 1, "lon": 1}, {"hex": "y"}]},
    )
    u = await _pull_then_merge()
    assert {a["hex"] for a in u} == {"x"}  # 'y' has no lat/lon → dropped


@pytest.mark.asyncio
async def test_stale_slice_evicted(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_feeds(monkeypatch, {"https://feed-a/aircraft.json": [{"hex": "old", "lat": 1, "lon": 1}]})
    await _pull_then_merge()
    # Force the slice to be older than the eviction window.
    url = "https://feed-a/aircraft.json"
    _, ac = adsb._FEED_SLICES[url]
    adsb._FEED_SLICES[url] = (time.monotonic() - 10_000.0, ac)
    # Re-pull returns nothing (feed went dark) so the stale slice isn't
    # refreshed and gets evicted past the age window in the next merge.
    monkeypatch.setattr(adsb, "_fetch_one_feed_sync", _noop_sync)
    u = await adsb._readsb_feeds()
    await _drain()
    assert u == []
    assert url not in adsb._FEED_SLICES


def _noop_sync(_url: str) -> tuple[float, list[dict]]:
    return time.monotonic(), []


@pytest.mark.asyncio
async def test_no_feeds_configured_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADSB_FEED_URLS", "")
    from app.config import get_settings

    get_settings.cache_clear()
    assert await adsb._readsb_feeds() == []
