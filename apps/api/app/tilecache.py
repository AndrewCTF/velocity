"""Disk-backed tile cache with per-key coalescing and stale-on-failure.

Tiles are near-immutable (basemap restyles monthly at most, satellite
mosaics yearly, terrain never), so a long-TTL disk cache means each tile is
fetched from upstream at most once per TTL window — regardless of how many
browser sessions request it. Upstream sees O(unique tiles), not
O(users x tiles). This is the rate-limit fix.

File IO is synchronous on purpose: tiles are ~10-100 KB local-disk reads on
a single-analyst deployment; a thread hop per tile would cost more than the
read. Writes are atomic (tmp + os.replace) so a crashed write never leaves
a truncated tile to be served later.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from pathlib import Path

log = logging.getLogger(__name__)

# Bounded per-key lock table — same eviction idea as upstream.TtlCache.
_MAX_LOCKS = 4096

# Re-scan the tree for eviction at most this often — a full walk is O(files),
# cheap on a single-analyst cache but not something to do on every tile write.
_EVICT_MIN_INTERVAL_S = 30.0
# Evict down to this fraction of the cap so we don't re-walk on every write once
# we're hovering at the limit.
_EVICT_LOW_WATER = 0.9


class TileCache:
    def __init__(self, root: str | Path, max_bytes: int = 0) -> None:
        self.root = Path(root)
        self.max_bytes = max_bytes  # 0 → unbounded (no eviction)
        self._locks: OrderedDict[str, asyncio.Lock] = OrderedDict()
        self._evict_lock = asyncio.Lock()
        self._last_evict = 0.0

    def _path(self, source: str, z: int, x: int, y: int, ext: str) -> Path:
        return self.root / source / str(z) / str(x) / f"{y}.{ext}"

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        self._locks.move_to_end(key)
        while len(self._locks) > _MAX_LOCKS:
            self._locks.popitem(last=False)
        return lock

    @staticmethod
    def _fresh(path: Path, ttl_sec: float) -> bool:
        try:
            return (time.time() - path.stat().st_mtime) < ttl_sec
        except OSError:
            return False

    async def get(
        self,
        source: str,
        z: int,
        x: int,
        y: int,
        ext: str,
        ttl_sec: float,
        loader: Callable[[], Awaitable[bytes | None]],
    ) -> bytes | None:
        """Return tile bytes, or None when upstream failed and no copy exists.

        Fresh disk hit short-circuits without locking. On miss, a per-key
        lock coalesces concurrent fetches into one upstream call. When the
        loader fails (returns None), any stale copy — regardless of age —
        is served instead, so a dead upstream degrades to "frozen tiles",
        never to "blank map".
        """
        path = self._path(source, z, x, y, ext)
        if self._fresh(path, ttl_sec):
            try:
                return path.read_bytes()
            except OSError:
                pass
        async with self._lock_for(f"{source}/{z}/{x}/{y}"):
            # Double-check: another waiter may have written it while we queued.
            if self._fresh(path, ttl_sec):
                try:
                    return path.read_bytes()
                except OSError:
                    pass
            data = await loader()
            if data:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(path.suffix + ".tmp")
                tmp.write_bytes(data)
                os.replace(tmp, path)
                await self._maybe_evict()
                return data
            try:
                return path.read_bytes()
            except OSError:
                return None

    async def _maybe_evict(self) -> None:
        """LRU-evict oldest tiles when the cache exceeds max_bytes.

        Throttled to one walk per _EVICT_MIN_INTERVAL_S and serialised by a
        lock, so a write burst triggers at most one background sweep. The walk
        runs in a thread (run_in_executor) so it never blocks the event loop.
        mtime is the LRU key: a tile's mtime is its last upstream fetch, and a
        fresh cache hit just reads (no mtime bump), so the oldest mtime is the
        least-recently-refreshed tile.
        """
        if self.max_bytes <= 0:
            return
        now = time.time()
        if now - self._last_evict < _EVICT_MIN_INTERVAL_S:
            return
        if self._evict_lock.locked():
            return
        async with self._evict_lock:
            self._last_evict = time.time()
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self._evict_sync)

    def _evict_sync(self) -> None:
        """Walk the cache, and if over cap delete oldest tiles to the low-water."""
        if self.max_bytes <= 0:
            return
        try:
            files: list[tuple[float, int, str]] = []
            total = 0
            for dirpath, _dirs, names in os.walk(self.root):
                for name in names:
                    fp = os.path.join(dirpath, name)
                    try:
                        st = os.stat(fp)
                    except OSError:
                        continue
                    files.append((st.st_mtime, st.st_size, fp))
                    total += st.st_size
            if total <= self.max_bytes:
                return
            target = int(self.max_bytes * _EVICT_LOW_WATER)
            files.sort()  # oldest mtime first
            freed = 0
            removed = 0
            for _mtime, size, fp in files:
                if total - freed <= target:
                    break
                try:
                    os.remove(fp)
                    freed += size
                    removed += 1
                except OSError:
                    continue
            log.info(
                "tilecache: evicted %d tiles (%d bytes) — %d→%d of cap %d",
                removed,
                freed,
                total,
                total - freed,
                self.max_bytes,
            )
        except Exception:  # noqa: BLE001
            log.exception("tilecache: eviction error")
