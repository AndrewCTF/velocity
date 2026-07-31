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


def _transport(proxy: str | None = None) -> httpx.AsyncHTTPTransport:
    """One transport shape, optionally routed through `proxy`.

    local_address pins outbound sockets to IPv4. Several upstreams
    (CloudFront-backed weathercam.digitraffic.fi, cwwp2.dot.ca.gov) publish
    AAAA records; on hosts with broken IPv6 egress httpx exhausts the v6
    attempts and reports "All connection attempts failed" while curl quietly
    falls back. One retry absorbs transient resets on long-lived pooled
    connections.
    """
    return httpx.AsyncHTTPTransport(
        local_address="0.0.0.0",
        retries=1,
        proxy=httpx.Proxy(proxy) if proxy else None,
    )


def _env_proxy_map() -> dict[str, str | None]:
    """The raw HTTPS_PROXY / NO_PROXY map httpx would have built.

    httpx only consults the proxy environment when `transport` is left unset
    (`allow_env_proxies = trust_env and transport is None`), and we must pass a
    transport for the IPv4 pin above. That combination silently drops proxy
    support, so behind an egress proxy every upstream reachable ONLY through it
    dies as a ReadTimeout — measured on celestrak.org, which took the satellite
    layer to zero while the direct-routable feeds looked fine.

    A `None` value is a NO_PROXY host (loopback, so the localhost sidecars keep
    bypassing the proxy). Returns empty when nothing is configured, which is the
    unproxied default and leaves behaviour exactly as it was.
    """
    try:
        from httpx._utils import get_environment_proxies  # noqa: PLC0415
    except ImportError:  # pragma: no cover — private helper moved
        return {}
    return dict(get_environment_proxies())


def _default_transport() -> httpx.AsyncBaseTransport:
    """The pool when UPSTREAM_PROXIES is set, otherwise the plain transport."""
    from app import upstream_proxy  # noqa: PLC0415 — avoids a config import cycle
    from app.config import get_settings  # noqa: PLC0415

    settings = get_settings()
    pool = upstream_proxy.build(
        settings.upstream_proxies,
        _transport,
        cooldown_s=settings.upstream_proxy_cooldown_s,
        max_tries=settings.upstream_proxy_max_tries,
        fallback_direct=settings.upstream_proxy_fallback_direct,
    )
    return pool or _transport()


def get_client() -> httpx.AsyncClient:
    global _CLIENT
    if _CLIENT is None:
        from app import upstream_proxy  # noqa: PLC0415

        default = _default_transport()
        env = _env_proxy_map()
        pooled = isinstance(default, upstream_proxy.RotatingProxyTransport)
        mounts: dict[str, httpx.AsyncBaseTransport | None] = {}
        for pattern, url in env.items():
            # With a pool active, an explicit UPSTREAM_PROXIES outranks the
            # ambient environment proxy: keeping the env's scheme mount (e.g.
            # "https://") would shadow the default transport and the pool would
            # never see a single request. Its NO_PROXY exclusions still apply —
            # those are "do not proxy this host", which the pool must honour too.
            if pooled and url is not None:
                continue
            mounts[pattern] = _transport(url)
        if pooled:
            # Same-host sidecars (:8090 ADS-B, :8093 AIS) must not ride the pool:
            # an external hop cannot reach them and would publish their traffic.
            # The env map already pins loopback when NO_PROXY is set; add it
            # explicitly for the case where only UPSTREAM_PROXIES is configured.
            for pattern in upstream_proxy.LOOPBACK_PATTERNS:
                mounts.setdefault(pattern, _transport())
        _CLIENT = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=5.0),
            headers={"User-Agent": "osint-console/0.1"},
            transport=default,
            mounts=mounts,
        )
    return _CLIENT


def proxy_stats() -> list[dict[str, object]] | None:
    """Per-proxy health when a pool is active, else None. Credentials redacted."""
    from app import upstream_proxy  # noqa: PLC0415

    if _CLIENT is None:
        return None
    transport = _CLIENT._transport  # noqa: SLF001 — httpx exposes no public getter
    if isinstance(transport, upstream_proxy.RotatingProxyTransport):
        return transport.stats()
    return None


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
