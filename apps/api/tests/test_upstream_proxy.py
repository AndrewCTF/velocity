"""Rotating upstream proxy pool (app.upstream_proxy).

The invariants worth guarding: OFF by default, rotation actually rotates, a
failing proxy is skipped rather than retried into the ground, the pool fails
CLOSED unless the operator opts into a direct fallback, loopback never rides
the pool, and credentials never reach stats or logs.
"""

from __future__ import annotations

import httpx
import pytest

from app import upstream, upstream_proxy


def _factory(record: list[str | None]):
    """transport_factory stand-in that records what it was asked to build."""

    def make(proxy: str | None) -> httpx.AsyncBaseTransport:
        record.append(proxy)
        return httpx.MockTransport(lambda req: httpx.Response(200, text=str(proxy)))

    return make


class _Boom(httpx.AsyncBaseTransport):
    """Always fails, so a pool member can be driven into cooldown."""

    def __init__(self) -> None:
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        raise httpx.ConnectError("nope", request=request)


class _Ok(httpx.AsyncBaseTransport):
    def __init__(self, tag: str) -> None:
        self.tag = tag
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        return httpx.Response(200, text=self.tag)


def _pool(entries, *, direct=None, cooldown_s=300.0, max_tries=3):
    return upstream_proxy.RotatingProxyTransport(
        [upstream_proxy._Entry(tag, tr) for tag, tr in entries],
        direct=direct,
        cooldown_s=cooldown_s,
        max_tries=max_tries,
    )


def test_parse_pool_drops_blanks_and_dupes_keeping_order() -> None:
    raw = " http://a:1 , ,http://b:2, http://a:1 ,"
    assert upstream_proxy.parse_pool(raw) == ["http://a:1", "http://b:2"]


def test_build_returns_none_when_unconfigured() -> None:
    """Empty config must leave the client exactly as it was — the default."""
    record: list[str | None] = []
    assert (
        upstream_proxy.build(
            "", _factory(record), cooldown_s=1.0, max_tries=3, fallback_direct=False
        )
        is None
    )
    assert record == []


def test_build_makes_one_transport_per_proxy() -> None:
    record: list[str | None] = []
    pool = upstream_proxy.build(
        "http://a:1,http://b:2",
        _factory(record),
        cooldown_s=1.0,
        max_tries=3,
        fallback_direct=False,
    )
    assert pool is not None
    assert record == ["http://a:1", "http://b:2"]


def test_build_only_makes_a_direct_transport_when_fallback_enabled() -> None:
    record: list[str | None] = []
    upstream_proxy.build(
        "http://a:1", _factory(record), cooldown_s=1.0, max_tries=3, fallback_direct=True
    )
    assert None in record, "fallback_direct=True must build an unproxied transport"

    record.clear()
    upstream_proxy.build(
        "http://a:1",
        _factory(record),
        cooldown_s=1.0,
        max_tries=3,
        fallback_direct=False,
    )
    assert None not in record, "default must not build a direct escape hatch"


@pytest.mark.asyncio
async def test_requests_rotate_across_the_pool() -> None:
    a, b = _Ok("a"), _Ok("b")
    pool = _pool([("http://a:1", a), ("http://b:2", b)])
    req = httpx.Request("GET", "https://example.com")

    for _ in range(4):
        await pool.handle_async_request(req)

    assert a.calls == 2 and b.calls == 2, "round-robin should split evenly"


@pytest.mark.asyncio
async def test_failing_proxy_fails_over_then_is_skipped_while_cooling() -> None:
    bad, good = _Boom(), _Ok("good")
    pool = _pool([("http://bad:1", bad), ("http://good:2", good)], cooldown_s=300.0)
    req = httpx.Request("GET", "https://example.com")

    r = await pool.handle_async_request(req)
    assert r.text == "good", "a dead proxy must fail over, not surface the error"

    before = bad.calls
    for _ in range(6):
        await pool.handle_async_request(req)
    assert bad.calls == before, "a cooling-down proxy must not be retried"
    assert good.calls >= 6


@pytest.mark.asyncio
async def test_cooldown_expiry_puts_a_proxy_back_in_rotation() -> None:
    bad, good = _Boom(), _Ok("good")
    pool = _pool([("http://bad:1", bad), ("http://good:2", good)], cooldown_s=0.0)
    req = httpx.Request("GET", "https://example.com")

    for _ in range(3):
        await pool.handle_async_request(req)
    assert bad.calls > 1, "a zero cooldown should let the proxy be tried again"


@pytest.mark.asyncio
async def test_pool_fails_closed_when_everything_is_down() -> None:
    """The IP-leak guard: no direct fallback unless explicitly configured."""
    pool = _pool([("http://a:1", _Boom()), ("http://b:2", _Boom())], direct=None)
    req = httpx.Request("GET", "https://example.com")

    with pytest.raises(httpx.ConnectError):
        await pool.handle_async_request(req)


@pytest.mark.asyncio
async def test_direct_fallback_used_only_when_supplied() -> None:
    direct = _Ok("direct")
    pool = _pool([("http://a:1", _Boom())], direct=direct)
    req = httpx.Request("GET", "https://example.com")

    r = await pool.handle_async_request(req)
    assert r.text == "direct"
    assert direct.calls == 1


@pytest.mark.asyncio
async def test_max_tries_bounds_the_failover_walk() -> None:
    booms = [_Boom() for _ in range(5)]
    pool = _pool(
        [(f"http://p{i}:1", b) for i, b in enumerate(booms)], direct=None, max_tries=2
    )
    req = httpx.Request("GET", "https://example.com")

    with pytest.raises(httpx.ConnectError):
        await pool.handle_async_request(req)
    assert sum(b.calls for b in booms) == 2, "must stop after max_tries proxies"


@pytest.mark.asyncio
async def test_stats_redact_credentials() -> None:
    pool = _pool([("http://user:hunter2@host:8080", _Ok("a"))])
    stats = pool.stats()

    assert len(stats) == 1
    rendered = str(stats[0])
    assert "hunter2" not in rendered, "proxy password must never reach stats"
    assert "user" not in rendered
    assert "host:8080" in rendered


def test_redact_never_raises_on_junk() -> None:
    assert isinstance(upstream_proxy._redact("::::not a url::::"), str)


def test_loopback_patterns_cover_the_sidecar_hosts() -> None:
    """The :8090 / :8093 sidecars are same-host and must bypass any pool."""
    joined = " ".join(upstream_proxy.LOOPBACK_PATTERNS)
    assert "127.0.0.1" in joined
    assert "localhost" in joined


def test_client_pins_loopback_direct_when_a_pool_is_active(monkeypatch) -> None:
    from app.config import get_settings

    settings = get_settings()

    monkeypatch.setattr(settings, "upstream_proxies", "http://proxy.invalid:8080")
    monkeypatch.setattr(upstream, "_CLIENT", None)
    try:
        client = upstream.get_client()
        assert isinstance(client._transport, upstream_proxy.RotatingProxyTransport)
        # _mounts is keyed by httpx's private URLPattern; compare on its text.
        mounted = {str(k.pattern): v for k, v in client._mounts.items()}
        for pattern in upstream_proxy.LOOPBACK_PATTERNS:
            assert pattern in mounted, f"{pattern} must be mounted"
            assert not isinstance(
                mounted[pattern], upstream_proxy.RotatingProxyTransport
            ), f"{pattern} must bypass the pool"
    finally:
        upstream._CLIENT = None


def test_pool_outranks_the_environment_proxy(monkeypatch) -> None:
    """Regression: an env scheme mount used to shadow the pool entirely.

    httpx consults `mounts` before the default transport, so with HTTPS_PROXY
    set the "https://" entry answered every request and the configured pool
    never saw one — measured live: four 200s with 0 successes recorded. The
    explicit UPSTREAM_PROXIES must win; NO_PROXY exclusions must still apply.
    """
    from app.config import get_settings

    settings = get_settings()

    # httpx reads the lowercase names first, so set both or the ambient
    # lowercase values (which this sandbox sets) silently win.
    for name in ("HTTPS_PROXY", "https_proxy"):
        monkeypatch.setenv(name, "http://env-proxy.invalid:3128")
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.setenv(name, "skip-me.invalid")
    monkeypatch.setattr(settings, "upstream_proxies", "http://pool.invalid:8080")
    monkeypatch.setattr(upstream, "_CLIENT", None)
    try:
        client = upstream.get_client()
        mounted = {str(k.pattern): v for k, v in client._mounts.items()}

        assert "https://" not in mounted, (
            "the env scheme mount must not shadow the pool"
        )
        assert isinstance(client._transport, upstream_proxy.RotatingProxyTransport)
        # NO_PROXY is an exclusion, not a route — the pool must honour it.
        assert any("skip-me.invalid" in p for p in mounted), (
            "NO_PROXY exclusions must survive"
        )
    finally:
        upstream._CLIENT = None


def test_env_proxy_still_mounted_when_no_pool(monkeypatch) -> None:
    """Without a pool the env proxy must still route — the celestrak fix."""
    from app.config import get_settings

    settings = get_settings()

    for name in ("HTTPS_PROXY", "https_proxy"):
        monkeypatch.setenv(name, "http://env-proxy.invalid:3128")
    monkeypatch.setattr(settings, "upstream_proxies", "")
    monkeypatch.setattr(upstream, "_CLIENT", None)
    try:
        client = upstream.get_client()
        mounted = {str(k.pattern): v for k, v in client._mounts.items()}
        assert "https://" in mounted, "env proxy must route when no pool is set"
    finally:
        upstream._CLIENT = None


def test_client_is_unchanged_when_no_pool_configured(monkeypatch) -> None:
    from app.config import get_settings

    settings = get_settings()

    monkeypatch.setattr(settings, "upstream_proxies", "")
    monkeypatch.setattr(upstream, "_CLIENT", None)
    try:
        client = upstream.get_client()
        assert not isinstance(
            client._transport, upstream_proxy.RotatingProxyTransport
        ), "an empty pool must not wrap the transport"
        assert upstream.proxy_stats() is None
    finally:
        upstream._CLIENT = None
