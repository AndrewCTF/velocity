"""ADS-B degradation ladder: firehoses 429 → OpenSky authed fallback."""

from __future__ import annotations

import asyncio
import time

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

    async def no_feeds() -> list[dict]:
        return []

    monkeypatch.setattr(adsb, "_opensky_cached", fake_opensky)
    monkeypatch.setattr(adsb, "_firehose_throttled", no_firehose)
    monkeypatch.setattr(adsb, "_readsb_feeds", no_feeds)
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

    async def no_feeds() -> list[dict]:
        return []

    monkeypatch.setattr(adsb, "_opensky_cached", fake_opensky)
    monkeypatch.setattr(adsb, "_firehose_throttled", no_firehose)
    monkeypatch.setattr(adsb, "_readsb_feeds", no_feeds)
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


# ── OpenSky daily circuit breaker ───────────────────────────────────────────
def test_opensky_breaker_trips_until_next_utc_midnight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A failed pull must DISABLE OpenSky until the next 0000 UTC reset — not
    # retry with a short backoff. The daily credit budget can't recover before
    # midnight UTC, so hammering it just burns timeouts / leaks authed credits.
    saved = (adsb._OPENSKY_DISABLED_UNTIL, adsb._OPENSKY_FC, adsb._OPENSKY_AT)
    try:
        adsb._OPENSKY_DISABLED_UNTIL = 0.0

        async def boom() -> dict:
            raise httpx.HTTPStatusError(
                "429",
                request=httpx.Request("GET", "https://opensky-network.org/api/states/all"),
                response=httpx.Response(429),
            )

        monkeypatch.setattr(adsb, "_try_opensky_global", boom)
        asyncio.run(adsb._opensky_refresh_once())
        now = time.time()
        assert adsb._OPENSKY_DISABLED_UNTIL > now  # breaker open
        # ≤ ~24h out: it points at the NEXT 0000 UTC, never further.
        assert adsb._OPENSKY_DISABLED_UNTIL <= now + 86400 + 1
        assert adsb._OPENSKY_DISABLED_UNTIL == adsb._next_utc_midnight_epoch()
    finally:
        (adsb._OPENSKY_DISABLED_UNTIL, adsb._OPENSKY_FC, adsb._OPENSKY_AT) = saved


def test_opensky_cached_skips_pull_while_breaker_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # While the breaker is open, the hot read serves the cached FC and kicks NO
    # pull — even though the interval says a refresh is "due".
    saved = (
        adsb._OPENSKY_DISABLED_UNTIL,
        adsb._OPENSKY_AT,
        adsb._OPENSKY_REFRESH_TASK,
        adsb._OPENSKY_FC,
    )
    try:
        called = {"n": 0}

        async def boom() -> dict:
            called["n"] += 1
            raise RuntimeError("must not pull while breaker open")

        monkeypatch.setattr(adsb, "_try_opensky_global", boom)
        adsb._OPENSKY_DISABLED_UNTIL = time.time() + 3600  # open for 1h
        adsb._OPENSKY_AT = 0.0  # would otherwise be "due"
        adsb._OPENSKY_REFRESH_TASK = None
        adsb._OPENSKY_FC = {
            "type": "FeatureCollection",
            "features": [{"id": "aircraft:cached"}],
        }

        async def run() -> dict | None:
            out = await adsb._opensky_cached()
            await asyncio.sleep(0)  # let any (erroneously) scheduled task run
            return out

        out = asyncio.run(run())
        assert out is adsb._OPENSKY_FC  # served cached
        assert called["n"] == 0  # no pull kicked
        assert adsb._OPENSKY_REFRESH_TASK is None
    finally:
        (
            adsb._OPENSKY_DISABLED_UNTIL,
            adsb._OPENSKY_AT,
            adsb._OPENSKY_REFRESH_TASK,
            adsb._OPENSKY_FC,
        ) = saved


def test_opensky_cached_kicks_pull_in_background_without_blocking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The fan-out must NEVER wait on OpenSky's 5-6MB /states/all download.
    # `_opensky_cached` returns the cached FC immediately while the pull is still
    # in flight, then the background task swaps in the fresh FC.
    saved = (
        adsb._OPENSKY_DISABLED_UNTIL,
        adsb._OPENSKY_AT,
        adsb._OPENSKY_REFRESH_TASK,
        adsb._OPENSKY_FC,
    )
    try:
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow() -> dict:
            started.set()
            await release.wait()  # block "the pull"
            return {"type": "FeatureCollection", "features": [{"id": "aircraft:new"}]}

        monkeypatch.setattr(adsb, "_try_opensky_global", slow)
        adsb._OPENSKY_DISABLED_UNTIL = 0.0
        adsb._OPENSKY_AT = 0.0  # due
        adsb._OPENSKY_REFRESH_TASK = None
        adsb._OPENSKY_FC = {
            "type": "FeatureCollection",
            "features": [{"id": "aircraft:old"}],
        }

        async def run() -> set[str]:
            out = await adsb._opensky_cached()  # must NOT block on slow()
            await started.wait()  # background pull did start
            assert adsb._OPENSKY_REFRESH_TASK is not None
            assert not adsb._OPENSKY_REFRESH_TASK.done()  # still blocked → non-blocking
            ids = {f["id"] for f in out["features"]}  # type: ignore[union-attr]
            release.set()
            await adsb._OPENSKY_REFRESH_TASK  # finish so no pending-task warning
            return ids

        ids = asyncio.run(run())
        assert ids == {"aircraft:old"}  # returned CACHED, not the pull result
        # background task swapped in the fresh pull
        assert {f["id"] for f in adsb._OPENSKY_FC["features"]} == {"aircraft:new"}
    finally:
        (
            adsb._OPENSKY_DISABLED_UNTIL,
            adsb._OPENSKY_AT,
            adsb._OPENSKY_REFRESH_TASK,
            adsb._OPENSKY_FC,
        ) = saved


def test_firehose_throttled_kicks_pull_in_background_without_blocking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Same guarantee for the firehose: a working 5-6MB mirror must not stall the
    # fan-out. The read returns instantly (cached / None) and the pull runs in
    # the background.
    saved = (adsb._FIREHOSE_NEXT_TRY, adsb._FIREHOSE_RAW, adsb._FIREHOSE_REFRESH_TASK)
    try:
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_fh() -> list[dict]:
            started.set()
            await release.wait()
            return [{"hex": "feed01", "lat": 1.0, "lon": 2.0}]

        monkeypatch.setattr(adsb, "_try_firehose", slow_fh)
        adsb._FIREHOSE_NEXT_TRY = 0.0
        adsb._FIREHOSE_RAW = []
        adsb._FIREHOSE_REFRESH_TASK = None

        async def run() -> list[dict] | None:
            out = await adsb._firehose_throttled()  # must NOT block
            await started.wait()
            assert adsb._FIREHOSE_REFRESH_TASK is not None
            assert not adsb._FIREHOSE_REFRESH_TASK.done()
            release.set()
            await adsb._FIREHOSE_REFRESH_TASK
            return out

        out = asyncio.run(run())
        assert out is None  # nothing cached yet → instant None, not a block
        assert adsb._FIREHOSE_RAW == [{"hex": "feed01", "lat": 1.0, "lon": 2.0}]
    finally:
        (adsb._FIREHOSE_NEXT_TRY, adsb._FIREHOSE_RAW, adsb._FIREHOSE_REFRESH_TASK) = saved
