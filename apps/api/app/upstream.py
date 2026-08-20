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
# host -> health row. Written only from the single uvicorn loop (get_client()
# is never called from a thread; the sync ADS-B path at routes/adsb.py has its
# own client and its own threading.Lock), so no lock is needed here.
_SOURCES: OrderedDict[str, dict[str, Any]] = OrderedDict()


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
    if pool is not None:
        return pool
    # WARP_ALL routes everything through the tunnel. An explicit UPSTREAM_PROXIES
    # pool outranks it: that one is egress the operator chose and pays for.
    if settings.warp_enabled and settings.warp_all:
        from app import warp  # noqa: PLC0415

        return _warp_transport(warp.socks_url(), settings.warp_kill_switch)
    return _transport()


def _warp_transport(
    socks: str, kill_switch: bool
) -> httpx.AsyncBaseTransport:
    """WARP-routed transport, optionally with a direct fallback.

    With the kill switch OFF a dead tunnel falls back to a direct connection:
    the goal here is reaching an upstream that dislikes our address, so serving
    it from our own address is degraded, not a leak. With it ON there is no
    fallback and the request fails — the `upstream_proxy` reasoning, applied to
    an operator who does mean "not from this address".
    """
    direct = None if kill_switch else _transport()
    return _WarpTransport(_transport(socks), direct=direct, socks=socks)


class _WarpTransport(httpx.AsyncBaseTransport):
    """One WARP hop with an optional direct fallback. Deliberately not the
    rotating pool: there is exactly one free-tier exit, so rotation and
    per-entry cooldown would model capacity that does not exist."""

    def __init__(
        self,
        tunnel: httpx.AsyncBaseTransport,
        *,
        direct: httpx.AsyncBaseTransport | None,
        socks: str,
    ) -> None:
        self._tunnel = tunnel
        self._direct = direct
        self._socks = socks

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return await self._tunnel.handle_async_request(request)
        except Exception as exc:  # noqa: BLE001 — tunnel down / SOCKS refused
            if self._direct is None:
                raise
            import logging  # noqa: PLC0415

            logging.getLogger("warp").warning(
                "WARP %s unusable for %s (%s) — falling back to a direct connection",
                self._socks,
                request.url.host,
                type(exc).__name__,
            )
            return await self._direct.handle_async_request(request)

    async def aclose(self) -> None:
        await self._tunnel.aclose()
        if self._direct is not None:
            await self._direct.aclose()


# ── per-source health registry ───────────────────────────────────────────────
#
# Before this existed the API recorded `last_success` for exactly zero of its
# ~100 upstreams and `last_error` for two, while /api/status asserted health for
# nine feeds — two of them hardcoded `True` and four inferred from a key being
# CONFIGURED rather than from a fetch that worked. A sweep of 207 GET routes
# (docs/audits/2026-08-20-api-sweep.md) found 17 answering HTTP 200 with an
# empty body, and nothing in the process could say which of those had a dead
# upstream behind them and which were simply empty stores on a fresh boot.
#
# This records the difference, in the ONE place every upstream call already
# passes through.
#
# Capture point is AsyncClient.send(), not an httpx event hook. A response hook
# fires only after _send_single_request returns, so ConnectError / ReadTimeout /
# ConnectTimeout never reach it — a registry built on hooks would read green
# precisely when an upstream is unreachable, which is the overclaim this exists
# to kill. (response.elapsed also raises inside a hook, and an exception thrown
# in one aborts the request for all 113 call sites.)
#
# Grain, stated because it is not obvious: send() records one row per LOGICAL
# request. Redirect hops, the transport's retries=1 and _WarpTransport's
# tunnel→direct fallback all collapse into a single row, so a WARP fallback
# reads here as a clean success. For stream=True the latency is headers-only,
# because the caller reads the body after send() returns.

_MAX_SOURCE_HOSTS = 512


def _source_row(host: str) -> dict[str, Any]:
    row = _SOURCES.get(host)
    if row is None:
        row = {
            "host": host,
            "ok": 0,
            "fail": 0,
            "last_success": None,
            "last_error": None,
            "last_error_at": None,
            "last_status": None,
            "latency_ms": None,
        }
        _SOURCES[host] = row
        # Host keys are attacker-influenceable through any route that fetches a
        # user-supplied URL, so the dict is bounded like the TTL cache below.
        while len(_SOURCES) > _MAX_SOURCE_HOSTS:
            _SOURCES.popitem(last=False)
    _SOURCES.move_to_end(host)
    return row


def record_success(host: str, latency_ms: float, status: int) -> None:
    row = _source_row(host)
    row["ok"] += 1
    row["last_success"] = time.time()
    row["last_status"] = status
    row["latency_ms"] = round(latency_ms, 1)


def record_failure(host: str, reason: str, status: int | None = None) -> None:
    """Record an upstream failure. Public because the wire is not the whole truth.

    airplanes.live throttles with HTTP 200 + text/plain, which every
    client-level capture point on earth records as a success. routes/_feedgeo.py
    is the layer that knows a 200 was not an answer, so it calls this directly.
    """
    row = _source_row(host)
    row["fail"] += 1
    row["last_error"] = reason[:200]
    row["last_error_at"] = time.time()
    if status is not None:
        row["last_status"] = status


def source_health() -> list[dict[str, Any]]:
    """Every upstream host seen this process, newest activity first."""
    now = time.time()
    out: list[dict[str, Any]] = []
    for row in _SOURCES.values():
        r = dict(row)
        r["success_age_s"] = (
            round(now - row["last_success"], 1) if row["last_success"] else None
        )
        r["error_age_s"] = (
            round(now - row["last_error_at"], 1) if row["last_error_at"] else None
        )
        # Green needs a success MORE RECENT than the last failure. "Never
        # attempted" is a third state and must never render as green — that
        # conflation is the whole defect /api/status carried.
        if row["last_success"] is None and row["last_error"] is None:
            r["state"] = "unknown"
        elif row["last_error_at"] and (
            row["last_success"] is None or row["last_error_at"] > row["last_success"]
        ):
            r["state"] = "failing"
        else:
            r["state"] = "ok"
        out.append(r)
    return sorted(out, reverse=True, key=lambda r: max(
        r["last_success"] or 0.0, r["last_error_at"] or 0.0))


class _InstrumentedClient(httpx.AsyncClient):
    """The shared client, plus one row per request in the health registry.

    All bookkeeping is inside try/except: a bug in this file must never be able
    to abort an upstream call, and this client carries the 1 Hz ADS-B path.
    """

    async def send(self, request: httpx.Request, **kwargs: Any) -> httpx.Response:
        host = request.url.host
        t0 = time.perf_counter()
        try:
            response = await super().send(request, **kwargs)
        except Exception as exc:
            try:
                record_failure(host, f"{type(exc).__name__}: {exc}")
            except Exception:  # noqa: BLE001 — diagnostics never break a fetch
                pass
            raise
        try:
            ms = (time.perf_counter() - t0) * 1000.0
            if response.status_code >= 400:
                record_failure(host, f"HTTP {response.status_code}", response.status_code)
            else:
                record_success(host, ms, response.status_code)
        except Exception:  # noqa: BLE001 — diagnostics never break a fetch
            pass
        return response


def get_client() -> httpx.AsyncClient:
    global _CLIENT
    if _CLIENT is None:
        from app import upstream_proxy  # noqa: PLC0415
        from app.config import get_settings  # noqa: PLC0415

        settings = get_settings()
        default = _default_transport()
        env = _env_proxy_map()
        pooled = isinstance(default, upstream_proxy.RotatingProxyTransport)
        warp_all = settings.warp_enabled and settings.warp_all
        mounts: dict[str, httpx.AsyncBaseTransport | None] = {}
        for pattern, url in env.items():
            # With a pool or WARP_ALL active, our explicit configuration outranks
            # the ambient environment proxy: keeping the env's scheme mount (e.g.
            # "https://") would shadow the default transport and the pool would
            # never see a single request. Its NO_PROXY exclusions still apply —
            # those are "do not proxy this host", which the pool must honour too.
            if (pooled or warp_all) and url is not None:
                continue
            mounts[pattern] = _transport(url)
        # Per-host WARP mounts. These are what the tier normally uses: only the
        # hosts measurably fixed by a different address pay the tunnel, so the
        # 1 s ADS-B cycle and its 10 s fan-out budget stay on the direct path.
        warped: list[str] = []
        if settings.warp_enabled and not warp_all:
            from app import warp  # noqa: PLC0415

            socks = warp.socks_url()
            for host in warp.hosts():
                warped.append(host)
                mounts[f"all://{host}"] = _warp_transport(
                    socks, settings.warp_kill_switch
                )
        if pooled or warp_all or warped:
            # Same-host sidecars (:8090 ADS-B, :8093 AIS) must not ride an
            # external hop: it cannot reach them and would publish their traffic.
            # The env map already pins loopback when NO_PROXY is set; add it
            # explicitly for the case where only UPSTREAM_PROXIES / WARP is set.
            for pattern in upstream_proxy.LOOPBACK_PATTERNS:
                mounts.setdefault(pattern, _transport())
        # _InstrumentedClient, not httpx.AsyncClient: the subclass records
        # per-host health. transport/mounts are passed through UNCHANGED —
        # proxy_stats() below reaches into _CLIENT._transport and isinstance-
        # checks RotatingProxyTransport, so wrapping the transport instead of
        # the client would silently blank /api/status's proxy panel.
        _CLIENT = _InstrumentedClient(
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
