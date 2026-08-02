"""Generic real-browser fetch tier (app.browser_fetch).

The invariants worth guarding: OFF by default, `fetch()` is best-effort and
returns None rather than raising into a caller's feed path, the SSRF boundary is
checked BEFORE the sidecar (which will fetch whatever it is told), and the
sidecar inherits the WARP egress only when the httpx side is on it too — a
clearance cookie is bound to the address that earned it.
"""

from __future__ import annotations

import base64

import httpx
import pytest

from app import browser_fetch


def _settings(monkeypatch, **over):
    from app.config import get_settings

    s = get_settings()
    for k, v in over.items():
        monkeypatch.setattr(s, k, v)
    return s


def test_off_by_default() -> None:
    from app.config import Settings

    fresh = Settings()
    assert fresh.browser_fetch_enabled is False
    assert fresh.browser_fetch_port == 8095


@pytest.mark.asyncio
async def test_fetch_returns_none_when_the_tier_is_off(monkeypatch) -> None:
    _settings(monkeypatch, browser_fetch_enabled=False)
    assert await browser_fetch.fetch("https://example.invalid/x") is None


@pytest.mark.asyncio
async def test_fetch_refuses_a_non_public_target(monkeypatch) -> None:
    """The sidecar fetches arbitrary URLs on request; the SSRF check is ours."""
    _settings(monkeypatch, browser_fetch_enabled=True)
    asked: list[str] = []

    async def _never(*a, **k):  # pragma: no cover — must not be reached
        asked.append("sidecar")
        raise AssertionError("sidecar was asked for a private address")

    monkeypatch.setattr(httpx.AsyncClient, "get", _never)
    assert await browser_fetch.fetch("http://127.0.0.1:8090/data") is None
    assert await browser_fetch.fetch("file:///etc/passwd") is None
    assert asked == []


@pytest.mark.asyncio
async def test_fetch_decodes_the_sidecar_payload(monkeypatch) -> None:
    _settings(monkeypatch, browser_fetch_enabled=True)
    monkeypatch.setattr(browser_fetch, "_is_public_url", None, raising=False)

    async def _public(url: str) -> bool:
        return True

    monkeypatch.setattr("app.news.images._is_public_url", _public)

    async def _get(self, url, **kw):
        assert kw["params"]["capture"] == "re-api"
        return httpx.Response(
            200,
            json={
                "status": 200,
                "body_b64": base64.b64encode(b"payload").decode(),
                "captured": True,
            },
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx.AsyncClient, "get", _get)
    r = await browser_fetch.fetch("https://example.invalid/", capture="re-api")
    assert r is not None
    assert r.status_code == 200
    assert r.content == b"payload"


@pytest.mark.asyncio
async def test_fetch_returns_none_when_the_sidecar_errors(monkeypatch) -> None:
    _settings(monkeypatch, browser_fetch_enabled=True)

    async def _public(url: str) -> bool:
        return True

    monkeypatch.setattr("app.news.images._is_public_url", _public)

    async def _get(self, url, **kw):
        return httpx.Response(
            502, json={"error": "no response matched"}, request=httpx.Request("GET", url)
        )

    monkeypatch.setattr(httpx.AsyncClient, "get", _get)
    assert await browser_fetch.fetch("https://example.invalid/") is None


@pytest.mark.asyncio
async def test_start_gives_the_browser_the_same_egress_as_the_poller(monkeypatch) -> None:
    """WARP_PROXY reaches the child only when warp_sidecars is on; a browser on a
    different exit than the httpx side invalidates the clearance cookie."""
    _settings(
        monkeypatch,
        browser_fetch_enabled=True,
        warp_enabled=True,
        warp_sidecars=True,
        warp_proxy_port=40000,
    )
    captured: dict[str, dict] = {}

    async def _not_serving() -> bool:
        return False

    async def _spawn(*args, **kw):
        captured["env"] = kw["env"]
        raise FileNotFoundError("no node in the test env")

    monkeypatch.setattr(browser_fetch, "_serving", _not_serving)
    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    await browser_fetch.start()
    assert captured["env"]["WARP_PROXY"] == "socks5://127.0.0.1:40000"
    # jemalloc must never reach the Chrome tree (zygote dies at spawn).
    assert "LD_PRELOAD" not in captured["env"]
    assert "MALLOC_CONF" not in captured["env"]


@pytest.mark.asyncio
async def test_start_is_a_noop_when_disabled(monkeypatch) -> None:
    _settings(monkeypatch, browser_fetch_enabled=False)

    async def _spawn(*args, **kw):  # pragma: no cover — must not be reached
        raise AssertionError("spawned a disabled tier")

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    await browser_fetch.start()


@pytest.mark.asyncio
async def test_headful_runs_under_a_virtual_display(monkeypatch) -> None:
    """Headless Chrome is itself a detection signal.

    Measured 2026-08-01 on globe.adsb.fi: httpx 403 + "Just a moment", headless
    Chrome never cleared it in 25 s, headful under xvfb-run got 200 and the real
    page from the same address. So `browser_headful` must actually reach the
    child — and must degrade to headless rather than failing to start when
    xvfb-run is absent.
    """
    _settings(monkeypatch, browser_fetch_enabled=True, browser_headful=True)
    seen: dict[str, object] = {}

    async def _not_serving() -> bool:
        return False

    async def _spawn(*args, **kw):
        seen["argv"] = list(args)
        seen["env"] = kw["env"]
        raise FileNotFoundError("no node in the test env")

    monkeypatch.setattr(browser_fetch, "_serving", _not_serving)
    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)

    monkeypatch.setattr(browser_fetch.shutil, "which", lambda _n: "/usr/bin/xvfb-run")
    await browser_fetch.start()
    assert seen["argv"][0] == "xvfb-run"
    assert seen["env"]["BROWSER_HEADFUL"] == "1"

    seen.clear()
    monkeypatch.setattr(browser_fetch.shutil, "which", lambda _n: None)
    await browser_fetch.start()
    assert seen["argv"][0] == "node", "must fall back to headless, not refuse to start"
    assert "BROWSER_HEADFUL" not in seen["env"]
