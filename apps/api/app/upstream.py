"""Shared httpx client + tiny in-process TTL cache.

Per plan §cross-cutting: each route should have a TTL aligned to upstream
cadence so we don't hammer free APIs. Redis is the right home long-term;
for Phase 1 a per-process dict is fine — single-analyst, one container.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

import httpx

_CLIENT: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=5.0),
            headers={"User-Agent": "osint-console/0.1"},
            # local_address pins outbound sockets to IPv4. Several upstreams
            # (CloudFront-backed weathercam.digitraffic.fi, cwwp2.dot.ca.gov)
            # publish AAAA records; on hosts with broken IPv6 egress httpx
            # exhausts the v6 attempts and reports "All connection attempts
            # failed" while curl quietly falls back. One retry absorbs
            # transient resets on long-lived pooled connections.
            transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=1),
        )
    return _CLIENT


T = TypeVar("T")

# Bounded LRU cap — large enough to cover all live route keys + per-bbox/per-id
# variants for typical sessions, small enough that an attacker churning keys
# can't blow out memory. ~2048 entries × (str key + value tuple) is trivial.
_MAX_CACHE_ENTRIES = 2048


class TtlCache:
    """Async-safe bounded LRU TTL cache.

    `_data` and `_locks` are kept in insertion-order; on hit we move-to-end,
    and when we exceed `_MAX_CACHE_ENTRIES` we evict from the front. This
    prevents unbounded growth from churning keys (e.g. distinct bbox params
    per request) while preserving the existing async double-checked-lock
    semantics for the loader.
    """

    def __init__(self, max_entries: int = _MAX_CACHE_ENTRIES) -> None:
        self._data: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._locks: OrderedDict[str, asyncio.Lock] = OrderedDict()
        self._max_entries = max_entries

    def _evict_if_needed(self) -> None:
        # Evict oldest data entries past the cap.
        while len(self._data) > self._max_entries:
            self._data.popitem(last=False)
        # Locks track the same key space; cap them in lockstep so a key that
        # only ever takes the lock without succeeding can't leak either.
        while len(self._locks) > self._max_entries:
            self._locks.popitem(last=False)

    async def get_or_fetch(
        self, key: str, ttl_sec: float, loader: Callable[[], Awaitable[T]]
    ) -> T:
        now = time.monotonic()
        entry = self._data.get(key)
        if entry and entry[0] > now:
            # LRU touch on hit.
            self._data.move_to_end(key)
            return entry[1]  # type: ignore[no-any-return]

        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        self._locks.move_to_end(key)

        async with lock:
            # Re-evaluate "now" AFTER acquiring the lock. The outer `now` is
            # stale: if the prior loader ran for, say, 20s while we waited on
            # the lock, the entry it stored may have already expired by the
            # time we wake up. Using a fresh timestamp here means a waiter
            # never returns a value that was already past its TTL.
            now2 = time.monotonic()
            entry = self._data.get(key)
            if entry and entry[0] > now2:
                self._data.move_to_end(key)
                return entry[1]  # type: ignore[no-any-return]
            value = await loader()
            self._data[key] = (time.monotonic() + ttl_sec, value)
            self._data.move_to_end(key)
            self._evict_if_needed()
            return value

    def invalidate(self, key: str) -> None:
        self._data.pop(key, None)

    def shorten(self, key: str, max_ttl_sec: float) -> None:
        """Cap an existing entry's remaining TTL at `max_ttl_sec` from now.

        Used by callers that cache a value with a long TTL but want certain
        results (e.g. an empty cell) to expire sooner — without poking the
        private `_data` dict from outside."""
        entry = self._data.get(key)
        if entry is None:
            return
        cap = time.monotonic() + max_ttl_sec
        if entry[0] > cap:
            self._data[key] = (cap, entry[1])


cache = TtlCache()
