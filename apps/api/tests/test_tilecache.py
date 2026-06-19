"""TileCache unit tests — hit/miss, coalescing, stale-on-failure."""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.tilecache import TileCache


def test_miss_fetches_once_then_disk_hit(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)
    calls = 0

    async def loader() -> bytes | None:
        nonlocal calls
        calls += 1
        return b"PNG"

    async def run() -> None:
        assert await tc.get("carto", 3, 1, 2, "png", 60, loader) == b"PNG"
        assert await tc.get("carto", 3, 1, 2, "png", 60, loader) == b"PNG"

    asyncio.run(run())
    assert calls == 1
    assert (tmp_path / "carto" / "3" / "1" / "2.png").read_bytes() == b"PNG"


def test_concurrent_requests_coalesce(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)
    calls = 0

    async def loader() -> bytes | None:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return b"X"

    async def run() -> list[bytes | None]:
        return list(
            await asyncio.gather(
                *(tc.get("s", 1, 0, 0, "png", 60, loader) for _ in range(10))
            )
        )

    results = asyncio.run(run())
    assert all(r == b"X" for r in results)
    assert calls == 1


def test_stale_served_on_upstream_failure(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)

    async def good() -> bytes | None:
        return b"OLD"

    async def bad() -> bytes | None:
        return None

    async def run() -> bytes | None:
        await tc.get("s", 1, 0, 0, "png", 60, good)
        # ttl 0 → entry counts as expired → loader runs → fails → stale served
        return await tc.get("s", 1, 0, 0, "png", 0, bad)

    assert asyncio.run(run()) == b"OLD"


def test_failure_without_stale_returns_none(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)

    async def bad() -> bytes | None:
        return None

    assert asyncio.run(tc.get("s", 1, 0, 0, "png", 60, bad)) is None


def test_lru_evicts_oldest_to_low_water(tmp_path: Path) -> None:
    """Over the cap, _evict_sync deletes oldest-mtime tiles to the low-water
    (90% of cap), keeping the freshest."""
    import os

    tc = TileCache(tmp_path, max_bytes=1000)
    d = tmp_path / "s" / "1" / "0"
    d.mkdir(parents=True)
    for i in range(10):  # 10 x 200 B = 2000 B, mtimes increasing
        p = d / f"{i}.png"
        p.write_bytes(b"x" * 200)
        os.utime(p, (1000 + i, 1000 + i))

    tc._evict_sync()

    survivors = sorted(int(p.stem) for p in d.glob("*.png"))
    total = sum((d / f"{i}.png").stat().st_size for i in survivors)
    assert total <= int(1000 * 0.9), "must evict down to the low-water"
    assert 9 in survivors, "freshest tile kept"
    assert 0 not in survivors, "oldest tile evicted"


def test_no_eviction_when_cap_disabled(tmp_path: Path) -> None:
    """max_bytes=0 means unbounded — _evict_sync must never delete."""
    tc = TileCache(tmp_path, max_bytes=0)
    d = tmp_path / "s" / "1" / "0"
    d.mkdir(parents=True)
    (d / "0.png").write_bytes(b"x" * 5000)
    tc._evict_sync()
    assert (d / "0.png").exists()
