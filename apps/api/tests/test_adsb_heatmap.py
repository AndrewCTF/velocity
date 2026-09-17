"""tar1090 globe_history heatmap: proxy, cache, decode, coverage.

The globe's replay owner scrubs any half hour back to 2024 from these
keyless chunks; these tests prove the packed-decode contract, the
closed-only disk cache, the host failover + disabled-host filter, the
atime budget, and the route wiring - with every byte synthetic and every
file under tmp_path, so nothing ever touches the operator's data/.
"""

from __future__ import annotations

import asyncio
import gzip
import os
import struct
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import adsb_heatmap
from app.config import Settings, get_settings

_SEP_HEX = 0xE7F7C9D
_ENTRY = struct.Struct("<iiihh")
# 2024-06-01T12:00:00Z in ms - chunk 24 of that day (12:00-12:30 UTC).
_TS0 = 1_717_243_200_000


def _entry(hex_u32: int, lat_i: int, lon_i: int, alt_i: int, gs_i: int) -> bytes:
    # Unsigned i32 halves: the on-wire bytes are the same as the decoder's
    # signed view, and separator timestamps spill past INT32_MAX.
    return struct.pack("<IIIhh", hex_u32, lat_i, lon_i, alt_i, gs_i)


def _separator(ts_ms: int) -> bytes:
    """Slice separator: the ms timestamp splits across the lat field (hi 32
    bits) and the lon field (lo 32), with the interval in ms as alt."""
    return _entry(_SEP_HEX, (ts_ms >> 32) & 0xFFFFFFFF, ts_ms & 0xFFFFFFFF, 30_000, 0)


def _callsign(hex_u32: int, squawk: int, callsign: str) -> bytes:
    """A callsign/squawk row: lat >= 1<<30 flags the row, its low 16 bits
    are the squawk; the 8 raw bytes of lon+alt+gs ARE the padded callsign."""
    raw = callsign.ljust(8)[:8].encode("ascii")
    return _entry(
        hex_u32,
        (1 << 30) | squawk,
        int.from_bytes(raw[:4], "little"),
        int.from_bytes(raw[4:6], "little"),
        int.from_bytes(raw[6:8], "little"),
    )


def _fix(hex_u32: int, lon_deg: float, lat_deg: float, alt_i: int, gs_i: int) -> bytes:
    return _entry(hex_u32, int(round(lat_deg * 1e6)), int(round(lon_deg * 1e6)), alt_i, gs_i)


def _synthetic_chunk() -> bytes:
    h = 0x3C6444
    return b"".join(
        [
            _separator(_TS0),
            _callsign(h, 1000, "DLH123"),
            _fix(h, 8.5, 52.0, 1_400, 450),  # 35 000 ft, 45.0 kt; first fix, track None
            _fix((1 << 24) | 0x123456, 10.0, 50.0, -123, 300),  # '~' non-ICAO, ground
            _fix((5 << 27) | 0x444, 11.0, 51.0, -124, -1),  # mlat addrtype, alt None, gs None
            _separator(_TS0 + 30_000),
            _fix(h, 9.5, 52.0, 1_450, 455),  # eastward move -> derived track ~90
        ]
    )


def _url(host: str, day: date, index: int) -> str:
    return f"https://{host}/globe_history/{day:%Y/%m/%d}/heatmap/{index:02d}.bin.ttf"


class _FakeResp:
    def __init__(self, status: int, content: bytes) -> None:
        self.status_code = status
        self.content = content


class _FakeClient:
    """Host-ordered router: whatever is not routed answers 404."""

    def __init__(self) -> None:
        self.routes: dict[str, tuple[int, bytes]] = {}
        self.calls: list[str] = []

    async def get(self, url: str, **kwargs: Any) -> _FakeResp:
        self.calls.append(url)
        status, body = self.routes.get(url, (404, b""))
        return _FakeResp(status, body)


def _fake_fetch(result: tuple[bytes, str] | None):
    async def _fetch(day: date, index: int) -> tuple[bytes, str] | None:
        return result

    return _fetch


@pytest.fixture(autouse=True)
def _reset_settings_cache() -> Iterator[None]:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _patch_data_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Settings:
    """Point the heatmap store at tmp_path and pin the host list, so no test
    touches ./data or inherits a deployment .env host tweak."""
    settings = get_settings().model_copy(
        update={
            "history_db_path": str(tmp_path / "history.db"),
            "heatmap_hosts": "globe.adsb.fi,adsb.lol",
        }
    )
    monkeypatch.setattr(adsb_heatmap, "get_settings", lambda: settings)
    return settings


# ── decode contract ──────────────────────────────────────────────────────────


def test_decode_chunk_shape_and_derived_track() -> None:
    decoded = adsb_heatmap.decode_chunk(_synthetic_chunk())
    assert decoded["interval_ms"] == 30_000
    s1, s2 = decoded["slices"]
    assert s1["t"] == _TS0 / 1000.0
    assert s2["t"] == (_TS0 + 30_000) / 1000.0

    p1 = s1["positions"][0]
    assert p1["hex"] == "3c6444"
    assert p1["addrtype"] == "adsb_icao"
    assert (p1["lat"], p1["lon"]) == (52.0, 8.5)
    assert p1["alt"] == 35_000  # 1400 * 25 feet
    assert p1["gs"] == 45.0  # 450 / 10 knots
    assert p1["track"] is None  # first fix of the chunk

    assert s1["callsigns"]["3c6444"] == {"callsign": "DLH123", "squawk": "1000"}

    p2 = s2["positions"][0]
    assert (p2["lat"], p2["lon"]) == (52.0, 9.5)
    assert 85.0 < p2["track"] < 95.0  # eastward move derives ~090

    by_hex = {p["hex"]: p for p in s1["positions"]}
    assert by_hex["~123456"]["alt"] == "ground"  # -123 sentinel
    mlat = by_hex["000444"]
    assert mlat["addrtype"] == "mlat"  # bits 27-31 = 5
    assert mlat["alt"] is None  # -124 sentinel
    assert mlat["gs"] is None  # -1 sentinel


def test_tracks_from_chunk_shape_bbox_and_callsign() -> None:
    decoded = adsb_heatmap.decode_chunk(_synthetic_chunk())
    t = adsb_heatmap.tracks_from_chunk(decoded)
    assert t["source"] == "upstream"
    by_id = {tr["id"]: tr for tr in t["tracks"]}
    assert set(by_id) == {"aircraft:3c6444", "aircraft:~123456", "aircraft:000444"}
    ac = by_id["aircraft:3c6444"]
    assert ac["kind"] == "aircraft"
    assert ac["callsign"] == "DLH123"
    [p1, p2] = ac["points"]
    assert p1 == [8.5, 52.0, _TS0 / 1000.0, None]
    assert p2[:2] == [9.5, 52.0]
    assert p2[2] == (_TS0 + 30_000) / 1000.0
    assert p2[3] == pytest.approx(90, abs=5)

    # A bbox keeps a track if ANY point is inside: 3c6444's first fix and
    # ~123456's only fix are in, 000444's lone fix is not.
    kept = adsb_heatmap.tracks_from_chunk(decoded, bbox=(8.0, 49.5, 10.5, 52.5))
    assert [tr["id"] for tr in kept["tracks"]] == ["aircraft:3c6444", "aircraft:~123456"]
    assert adsb_heatmap.tracks_from_chunk(decoded, bbox=(0.0, 0.0, 1.0, 1.0))["tracks"] == []


def test_chunk_index_and_key() -> None:
    assert adsb_heatmap.chunk_index(datetime(2024, 6, 1, 12, 34, tzinfo=UTC)) == 25
    assert adsb_heatmap.chunk_index(datetime(2024, 6, 1, 0, 0, tzinfo=UTC)) == 0
    assert adsb_heatmap.chunk_index(datetime(2024, 6, 1, 23, 59, tzinfo=UTC)) == 47
    # A non-UTC wall clock normalises to UTC first: 14:34+02:00 is 12:34Z.
    assert (
        adsb_heatmap.chunk_index(datetime(2024, 6, 1, 14, 34, tzinfo=timezone(timedelta(hours=2))))
        == 25
    )
    assert adsb_heatmap.chunk_key(date(2024, 6, 1), 24) == "2024/06/01/24"


# ── fetch + disk cache ───────────────────────────────────────────────────────


def test_fetch_chunk_failover_and_closed_only_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_data_dir(monkeypatch, tmp_path)
    fake = _FakeClient()
    monkeypatch.setattr(adsb_heatmap, "get_client", lambda: fake)
    blob = _synthetic_chunk()
    day, index = date(2024, 6, 1), 24  # closed months ago

    fake.routes = {
        _url("globe.adsb.fi", day, index): (404, b""),
        _url("adsb.lol", day, index): (200, blob),
    }
    out = asyncio.run(adsb_heatmap.fetch_chunk(day, index))
    assert out is not None
    body, host = out
    assert host == "adsb.lol"  # 404 fell through to the next host
    assert body == blob

    cached = adsb_heatmap.cache_path(day, index)
    assert cached.exists()
    assert cached.name == "24.bin.ttf.gz"
    with gzip.open(cached, "rb") as fh:
        assert fh.read() == blob

    # The second call is served from disk: no further upstream traffic.
    out2 = asyncio.run(adsb_heatmap.fetch_chunk(day, index))
    assert out2 == (blob, "cache")
    assert len(fake.calls) == 2  # the two host attempts of the first call only

    # The OPEN half hour is served but never written to the cache.
    now = datetime.now(UTC)
    day_c, index_c = now.date(), 2 * now.hour + now.minute // 30
    fake.routes[_url("globe.adsb.fi", day_c, index_c)] = (200, blob)
    out3 = asyncio.run(adsb_heatmap.fetch_chunk(day_c, index_c))
    assert out3[0] == blob
    assert not adsb_heatmap.cache_path(day_c, index_c).exists()


def test_fetch_chunk_disabled_hosts_skip_the_domain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ADSB_DISABLED_HOSTS=adsb.fi drops globe.adsb.fi (domain suffix match),
    so a chunk that ONLY the .fi mirror had must come from adsb.lol or miss."""
    settings = _patch_data_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(
        adsb_heatmap,
        "get_settings",
        lambda: settings.model_copy(update={"adsb_disabled_hosts": "adsb.fi"}),
    )
    fake = _FakeClient()
    monkeypatch.setattr(adsb_heatmap, "get_client", lambda: fake)
    blob = _synthetic_chunk()
    day, index = date(2024, 6, 1), 24
    fake.routes = {
        _url("globe.adsb.fi", day, index): (200, blob),
        _url("adsb.lol", day, index): (200, blob),
    }
    out = asyncio.run(adsb_heatmap.fetch_chunk(day, index))
    assert out is not None
    assert out[1] == "adsb.lol"
    assert not any("globe.adsb.fi" in c for c in fake.calls)  # the .fi mirror was never asked


# ── cache integrity (W2-1) ───────────────────────────────────────────────────


def test_chunk_route_404s_when_cache_is_truncated(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A gzip cut short by a kill or ENOSPC mid-write used to 500 the route
    FOREVER: EOFError is not an OSError, so the poisoned file was never
    deleted and never re-fetched. Now it is a cache miss — the file goes,
    the hosts are re-asked, and 404 is the only answer when they lack it."""
    _patch_data_dir(monkeypatch, tmp_path)
    fake = _FakeClient()
    monkeypatch.setattr(adsb_heatmap, "get_client", lambda: fake)
    day, index = date(2024, 6, 1), 24
    path = adsb_heatmap.cache_path(day, index)
    path.parent.mkdir(parents=True)
    full = gzip.compress(_synthetic_chunk())
    path.write_bytes(full[: len(full) // 2])  # truncated mid-stream

    r = client.get("/api/history/upstream/chunk", params={"day": "2024-06-01", "index": 24})
    assert r.status_code == 404, "a poisoned cache is a miss, not a 500"
    assert not path.exists(), "the poisoned file is deleted, not retried"
    assert len(fake.calls) == 2, "both hosts were re-asked for the chunk"


def test_wrong_shape_cache_file_is_refetched_from_hosts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A valid gzip that is not a chunk (no separator / bad length) is a
    cache miss too: it is deleted and the hosts asked, and the good body
    they serve replaces it in the cache."""
    _patch_data_dir(monkeypatch, tmp_path)
    fake = _FakeClient()
    monkeypatch.setattr(adsb_heatmap, "get_client", lambda: fake)
    blob = _synthetic_chunk()
    day, index = date(2024, 6, 1), 24
    path = adsb_heatmap.cache_path(day, index)
    path.parent.mkdir(parents=True)
    path.write_bytes(gzip.compress(b"x" * 32))  # a valid gzip, not a chunk

    fake.routes = {_url("adsb.lol", day, index): (200, blob)}
    out = asyncio.run(adsb_heatmap.fetch_chunk(day, index))
    assert out == (blob, "adsb.lol")
    with gzip.open(path, "rb") as fh:
        assert fh.read() == blob, "the poison is replaced by the good fetch"


def test_cache_write_failure_keeps_a_good_fetch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cache write that raises (ENOSPC, read-only dir) must not fail a
    chunk the host already served — the fetch still returns the body."""
    _patch_data_dir(monkeypatch, tmp_path)
    fake = _FakeClient()
    monkeypatch.setattr(adsb_heatmap, "get_client", lambda: fake)
    blob = _synthetic_chunk()
    day, index = date(2024, 6, 1), 24
    fake.routes = {_url("globe.adsb.fi", day, index): (200, blob)}

    def _boom(path, body):
        raise OSError("disk full")

    monkeypatch.setattr(adsb_heatmap, "_write_cache", _boom)
    out = asyncio.run(adsb_heatmap.fetch_chunk(day, index))
    assert out == (blob, "globe.adsb.fi")


# ── cache budget ─────────────────────────────────────────────────────────────


def test_enforce_cache_budget_drops_oldest_atime_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_data_dir(monkeypatch, tmp_path)
    root = tmp_path / "heatmap" / "2024" / "06" / "01"
    root.mkdir(parents=True)
    files = []
    for i in range(3):
        p = root / f"{i:02d}.bin.ttf.gz"
        p.write_bytes(gzip.compress(b"x" * 4096))
        os.utime(p, (1_000_000 + i * 1_000, 1_000_000 + i * 1_000))  # file 0 is oldest
        files.append(p)
    total = sum(p.stat().st_size for p in files)
    adsb_heatmap.enforce_cache_budget(int(total * 2 / 3) + 1)  # keeps exactly two
    assert not files[0].exists()  # least-recently-accessed goes first
    assert files[1].exists()
    assert files[2].exists()


# ── routes ───────────────────────────────────────────────────────────────────


def test_chunk_route_serves_bytes_and_headers(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    blob = _synthetic_chunk()
    monkeypatch.setattr(adsb_heatmap, "fetch_chunk", _fake_fetch((blob, "globe.adsb.fi")))
    r = client.get("/api/history/upstream/chunk", params={"day": "2024-06-01", "index": 24})
    assert r.status_code == 200
    assert r.content == blob
    assert r.headers["content-type"].startswith("application/octet-stream")
    assert r.headers["x-heatmap-host"] == "globe.adsb.fi"
    assert r.headers["x-heatmap-interval"] == "30000"
    assert r.headers["cache-control"] == "private, max-age=86400"


def test_chunk_route_bounds(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(adsb_heatmap, "fetch_chunk", _fake_fetch((b"", "x")))
    params = {"day": "2024-06-01", "index": 24}
    assert (
        client.get("/api/history/upstream/chunk", params={**params, "index": 48}).status_code == 422
    )
    assert (
        client.get("/api/history/upstream/chunk", params={**params, "index": -1}).status_code == 422
    )
    assert (
        client.get(
            "/api/history/upstream/chunk", params={**params, "day": "not-a-date"}
        ).status_code
        == 422
    )
    assert (
        client.get(
            "/api/history/upstream/chunk", params={**params, "day": "2999-01-01"}
        ).status_code
        == 422
    )


def test_chunk_route_404_when_no_host_has_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(adsb_heatmap, "fetch_chunk", _fake_fetch(None))
    r = client.get("/api/history/upstream/chunk", params={"day": "2024-06-01", "index": 24})
    assert r.status_code == 404
    assert r.json()["detail"] == "no upstream host has that chunk"


def test_tracks_route_shape_and_bbox(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    blob = _synthetic_chunk()
    monkeypatch.setattr(adsb_heatmap, "fetch_chunk", _fake_fetch((blob, "globe.adsb.fi")))
    r = client.get(
        "/api/history/upstream/tracks",
        params={
            "day": "2024-06-01",
            "index": 24,
            "min_lon": 8.0,
            "min_lat": 49.5,
            "max_lon": 10.5,
            "max_lat": 52.5,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "upstream"
    assert body["host"] == "globe.adsb.fi"
    assert body["interval_ms"] == 30_000
    assert body["slice_from"] == _TS0 / 1000.0
    # slice_to is the END of the half hour the chunk covers, not the last slice.
    assert body["slice_to"] == _TS0 / 1000.0 + 30 * 60
    assert [t["id"] for t in body["tracks"]] == ["aircraft:3c6444", "aircraft:~123456"]

    # A partial bbox is 422, not a silent half-filter.
    partial = client.get(
        "/api/history/upstream/tracks",
        params={"day": "2024-06-01", "index": 24, "min_lon": 8.0},
    )
    assert partial.status_code == 422


def test_coverage_route_rejects_bad_ranges(client: TestClient) -> None:
    backwards = client.get(
        "/api/history/upstream/coverage", params={"from": "2024-06-02", "to": "2024-06-01"}
    )
    assert backwards.status_code == 422
    # 367 inclusive days (a 366-day span) exceeds the 366-day cap.
    too_long = client.get(
        "/api/history/upstream/coverage", params={"from": "2024-01-01", "to": "2025-01-01"}
    )
    assert too_long.status_code == 422
    bad = client.get("/api/history/upstream/coverage", params={"from": "nope", "to": "2024-01-01"})
    assert bad.status_code == 422
