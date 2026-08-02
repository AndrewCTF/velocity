"""Cloudflare WARP egress (app.warp + its wiring in app.upstream).

The invariants worth guarding: OFF by default, the host list ships EMPTY (a host
only earns the tunnel by measurement — see tools/probe_warp.py), loopback never
rides the tunnel in either mode, the kill switch really removes the direct
fallback, an explicit proxy pool still outranks WARP, and neither ensure() nor
supervise() can raise into lifespan.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app import upstream, upstream_proxy, warp


def _settings(monkeypatch, **over):
    from app.config import get_settings

    s = get_settings()
    for k, v in over.items():
        monkeypatch.setattr(s, k, v)
    monkeypatch.setattr(upstream, "_CLIENT", None)
    return s


def test_off_by_default_and_hosts_ship_empty() -> None:
    """A tier that unblocked nothing from the measured egress must not self-enable.

    Measured 2026-08-01: through WARP, every host that 403s direct still 403s,
    and OpenSky became unreachable. Shipping a non-empty default here would move
    live feeds onto a tunnel that costs latency and buys nothing.
    """
    from app.config import Settings

    fresh = Settings()
    assert fresh.warp_enabled is False
    assert fresh.warp_hosts == ""
    assert fresh.warp_all is False
    assert fresh.warp_sidecars is False
    assert fresh.warp_kill_switch is False


def test_socks_url_tracks_the_configured_port(monkeypatch) -> None:
    _settings(monkeypatch, warp_proxy_port=41234)
    assert warp.socks_url() == "socks5://127.0.0.1:41234"


def test_hosts_are_parsed_lowercase_without_blanks(monkeypatch) -> None:
    _settings(monkeypatch, warp_hosts=" API.ADSB.LOL , ,globe.adsb.fi ")
    assert warp.hosts() == ["api.adsb.lol", "globe.adsb.fi"]


def test_configured_hosts_get_a_warp_mount_and_others_do_not(monkeypatch) -> None:
    _settings(monkeypatch, warp_enabled=True, warp_hosts="api.adsb.lol")
    try:
        client = upstream.get_client()
        mounted = {str(k.pattern): v for k, v in client._mounts.items()}
        assert "all://api.adsb.lol" in mounted
        assert isinstance(mounted["all://api.adsb.lol"], upstream._WarpTransport)
        # Everything else keeps the plain default transport.
        assert not isinstance(client._transport, upstream._WarpTransport)
    finally:
        upstream._CLIENT = None


def test_loopback_never_rides_the_tunnel(monkeypatch) -> None:
    """The :8090/:8093 sidecars are same-host. An external hop cannot reach them
    and would publish their traffic."""
    for over in ({"warp_hosts": "api.adsb.lol"}, {"warp_all": True, "warp_hosts": ""}):
        _settings(monkeypatch, warp_enabled=True, **over)
        try:
            client = upstream.get_client()
            mounted = {str(k.pattern): v for k, v in client._mounts.items()}
            for pattern in upstream_proxy.LOOPBACK_PATTERNS:
                assert pattern in mounted, f"{pattern} must be mounted ({over})"
                assert not isinstance(mounted[pattern], upstream._WarpTransport)
        finally:
            upstream._CLIENT = None


def test_explicit_proxy_pool_outranks_warp_all(monkeypatch) -> None:
    _settings(
        monkeypatch,
        warp_enabled=True,
        warp_all=True,
        upstream_proxies="http://pool.invalid:8080",
    )
    try:
        client = upstream.get_client()
        assert isinstance(client._transport, upstream_proxy.RotatingProxyTransport)
    finally:
        upstream._CLIENT = None


@pytest.mark.asyncio
async def test_dead_tunnel_falls_back_to_direct_by_default() -> None:
    calls: list[str] = []

    class _Dead(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            calls.append("tunnel")
            raise httpx.ConnectError("socks refused", request=request)

    class _Direct(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            calls.append("direct")
            return httpx.Response(200, text="ok")

    t = upstream._WarpTransport(_Dead(), direct=_Direct(), socks="socks5://x")
    r = await t.handle_async_request(httpx.Request("GET", "https://example.invalid/"))
    assert r.status_code == 200
    assert calls == ["tunnel", "direct"]


@pytest.mark.asyncio
async def test_kill_switch_removes_the_direct_fallback() -> None:
    class _Dead(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            raise httpx.ConnectError("socks refused", request=request)

    t = upstream._WarpTransport(_Dead(), direct=None, socks="socks5://x")
    with pytest.raises(httpx.ConnectError):
        await t.handle_async_request(httpx.Request("GET", "https://example.invalid/"))


def test_kill_switch_flag_controls_whether_a_direct_fallback_exists() -> None:
    assert upstream._warp_transport("socks5://127.0.0.1:1", True)._direct is None
    assert upstream._warp_transport("socks5://127.0.0.1:1", False)._direct is not None


@pytest.mark.asyncio
async def test_ensure_is_best_effort_when_the_cli_is_missing(monkeypatch) -> None:
    """A missing warp-cli must log and return False, never raise into lifespan."""
    monkeypatch.setattr(warp, "installed", lambda: False)
    assert await warp.ensure() is False


@pytest.mark.asyncio
async def test_ensure_reuses_a_tunnel_that_is_already_serving(monkeypatch) -> None:
    """Re-registering churns the device identity and drops the exit's reputation."""
    called: list[tuple[str, ...]] = []

    async def _cli(*args):
        called.append(args)
        return 0, ""

    monkeypatch.setattr(warp, "installed", lambda: True)
    monkeypatch.setattr(warp, "_serving", lambda: _true())
    monkeypatch.setattr(warp, "_cli_call", _cli)
    assert await warp.ensure() is True
    assert called == [], "an already-serving tunnel must not be reconfigured"


@pytest.mark.asyncio
async def test_supervise_reconnects_a_dropped_tunnel_and_is_cancel_safe(monkeypatch) -> None:
    seen = {"ensure": 0}

    async def _ensure():
        seen["ensure"] += 1
        return True

    monkeypatch.setattr(warp, "_SUPERVISE_INTERVAL_S", 0.01)
    monkeypatch.setattr(warp, "_serving", lambda: _false())
    monkeypatch.setattr(warp, "ensure", _ensure)

    task = asyncio.create_task(warp.supervise())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert seen["ensure"] >= 1


@pytest.mark.asyncio
async def test_stop_leaves_a_tunnel_it_did_not_start(monkeypatch) -> None:
    called: list[tuple[str, ...]] = []

    async def _cli(*args):
        called.append(args)
        return 0, ""

    monkeypatch.setattr(warp, "_cli_call", _cli)
    monkeypatch.setattr(warp, "_we_connected", False)
    await warp.stop()
    assert called == [], "an operator's own tunnel must survive our shutdown"


async def _true() -> bool:
    return True


async def _false() -> bool:
    return False
