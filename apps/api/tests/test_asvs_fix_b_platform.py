"""ASVS fixes outside the evidence locker:

- V4.1.3  the API no longer believes a client-settable ``X-Velocity-Tier``.
- V12.3.1 no outbound feed is fetched over plain HTTP by default.
- V2.4.1  a per-client cap on concurrent WebSockets.
- V13.2.1 the loopback browser sidecars require a per-spawn bearer token.
- V13.3.2 no sidecar child inherits the API's secrets.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import (
    adsb_sidecar,
    ais_sidecar,
    browser_fetch,
    childenv,
    mavlink_sidecar,
    sidecar_token,
    ws_limits,
)

_APP = Path(__file__).resolve().parents[1] / "app"
_REPO = Path(__file__).resolve().parents[3]
_SECRETS = {
    "API_KEY": "k" * 40,
    "SUPABASE_JWT_SECRET": "s" * 40,
    "BYOK_ENC_KEY": "b" * 40,
    "DEEPSEEK_API_KEY": "sk-deepseek",
}


@pytest.fixture(autouse=True)
def _token_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SIDECAR_TOKEN_DIR", str(tmp_path / "tokens"))
    sidecar_token._CACHE.clear()
    yield
    sidecar_token._CACHE.clear()


# ── V4.1.3 ────────────────────────────────────────────────────────────────────


def test_tier_header_is_ignored_even_from_a_trusted_peer(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """nginx (a TRUSTED_PROXIES peer) forwards client headers, and nothing sets
    this header since the gateway was deleted — so no peer may choose a tier."""
    from app import ratelimit

    monkeypatch.setattr(ratelimit, "_peer_is_trusted", lambda peer, raw: True)
    r = client.post(
        "/api/imagery/task",
        json={"provider": "umbra", "lat": 1.0, "lon": 1.0},
        headers={"X-Velocity-Tier": "paid"},
    )
    assert r.status_code == 402, r.text


# ── V12.3.1 ───────────────────────────────────────────────────────────────────

# Literals that are not fetched: XML/CRS namespace identifiers, catalog display
# links, a config comment, and the KiwiSDR mirror that is gated below.
_HTTP_LITERAL_ALLOWED = (
    "http://www.opengis.net/",
    "http://kiwisdr.com/public/",
    "http://websdr.org/",
    "http://user:pass@host",
    "http://rx.linkfanel.net/kiwisdr_com.js",
)


def test_no_plain_http_upstream_literals_in_the_app() -> None:
    found: list[str] = []
    for path in _APP.rglob("*.py"):
        for n, line in enumerate(path.read_text().splitlines(), 1):
            for m in re.finditer(r"""["']http://[A-Za-z0-9][^"'\s]*""", line):
                lit = m.group(0)[1:]
                if re.match(r"http://(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)", lit):
                    continue
                if lit.startswith(_HTTP_LITERAL_ALLOWED):
                    continue
                found.append(f"{path.relative_to(_APP)}:{n}: {lit}")
    assert found == [], found


def test_cnn_feed_is_https() -> None:
    from app.news.sources import FEEDS

    cnn = [s for s in FEEDS if s.name == "CNN World"]
    assert cnn and all(s.url.startswith("https://") for s in cnn)
    assert all(s.url.startswith("https://") for s in FEEDS)


def test_kiwisdr_plain_http_list_is_on_by_default_and_can_be_turned_off(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routes import _feedgeo as fg
    from app.routes import source_catalog as sc

    fetched: list[str] = []

    async def fake_fetch(url: str, **kw: Any) -> str:
        fetched.append(url)
        return 'var kiwisdr_com = [{"id":"a","name":"K","gps":"(1.0, 2.0)"},]'

    monkeypatch.setattr(fg, "fetch_text", fake_fetch)

    async def uncached(_key: str, _ttl: float, load: Any) -> Any:
        return await load()

    monkeypatch.setattr(fg, "cached", uncached)
    # Accepted risk R32: a public, credential-free list with no https publisher.
    monkeypatch.setenv("KIWISDR_ALLOW_HTTP", "0")
    off = asyncio.run(sc.kiwisdr_stations())
    assert off["degraded"] is True and "KIWISDR_ALLOW_HTTP" in off["note"]
    assert fetched == []
    monkeypatch.delenv("KIWISDR_ALLOW_HTTP", raising=False)
    on = asyncio.run(sc.kiwisdr_stations())
    assert fetched == [sc.KIWISDR_URL] and len(on["features"]) == 1


# ── V2.4.1: WebSocket cap ─────────────────────────────────────────────────────


def test_ws_connections_are_capped_per_client(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WS_MAX_CONN_PER_CLIENT", "2")
    ws_limits._counts.clear()
    with client.websocket_connect("/ws/alerts") as a, client.websocket_connect("/ws/alerts") as b:
        assert a is not None and b is not None
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/ws/alerts") as c:
                c.receive_text()
        assert exc.value.code == 1008
        # The cap is per client across routes, not per route.
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/cop?map=map:x") as d:
                d.receive_text()
    # Slots come back when sockets close.
    deadline = time.monotonic() + 5
    while ws_limits.open_count("testclient") and time.monotonic() < deadline:
        time.sleep(0.05)
    assert ws_limits.open_count("testclient") == 0
    with client.websocket_connect("/ws/alerts"):
        pass


def test_every_websocket_route_takes_a_slot_before_accept() -> None:
    for name in ("adsb", "ais", "alerts", "collab", "maps"):
        src = (_APP / "routes" / f"{name}.py").read_text()
        body = src.split("@router.websocket(", 1)[1]
        assert body.index("ws_limits.acquire(ws)") < body.index("await ws.accept()"), name
        assert "ws_limits.release(slot)" in body, name


# ── V13.3.2: allowlisted child env ────────────────────────────────────────────


def test_child_env_drops_secrets_and_jemalloc_keeps_basics() -> None:
    src = {**_SECRETS, "PATH": "/usr/bin", "HOME": "/h", "LC_ALL": "C.UTF-8",
           "LD_PRELOAD": "libjemalloc.so", "MALLOC_CONF": "x", "CUDA_VISIBLE_DEVICES": "0",
           "https_proxy": "http://p:1"}
    env = childenv.child_env({"PORT": "1"}, keep_prefixes=childenv.GPU_PREFIXES, source=src)
    assert env == {"PATH": "/usr/bin", "HOME": "/h", "LC_ALL": "C.UTF-8",
                   "CUDA_VISIBLE_DEVICES": "0", "https_proxy": "http://p:1", "PORT": "1"}


def _set_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    for k, v in _SECRETS.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("LD_PRELOAD", "libjemalloc.so.2")


def _assert_clean(env: dict[str, str]) -> None:
    leaked = sorted(set(_SECRETS) & set(env))
    assert leaked == [], f"secrets reached the child: {leaked}"
    assert "LD_PRELOAD" not in env
    assert env.get("PATH")


class _FakeProc:
    pid = 4242
    returncode: int | None = None

    async def wait(self) -> int:
        return 0


async def test_adsb_sidecar_child_gets_a_clean_env_and_a_persisted_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _set_secrets(monkeypatch)
    captured: dict = {}

    async def no(*a: Any, **k: Any) -> bool:
        return False

    async def fake_exec(*argv: Any, **kw: Any) -> Any:
        captured.update(kw)
        raise FileNotFoundError("node")

    monkeypatch.setattr(adsb_sidecar, "_already_healthy", no)
    monkeypatch.setattr(adsb_sidecar, "_port_holder_pid", lambda: None)
    monkeypatch.setattr(adsb_sidecar, "_serving", no)
    monkeypatch.setattr(adsb_sidecar.asyncio, "create_subprocess_exec", fake_exec)
    await adsb_sidecar.start()
    env = captured["env"]
    _assert_clean(env)
    token = env["SIDECAR_TOKEN"]
    assert len(token) > 30
    path = tmp_path / "tokens" / "adsb.token"
    assert path.read_text() == token
    assert path.stat().st_mode & 0o777 == 0o600
    # A later API process (empty cache) reads the same token back for the reused sidecar.
    sidecar_token._CACHE.clear()
    assert sidecar_token.headers("adsb") == {"Authorization": f"Bearer {token}"}


async def test_ais_and_browser_fetch_and_mavlink_children_get_clean_envs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_secrets(monkeypatch)
    envs: list[dict] = []

    async def fake_exec(*argv: Any, **kw: Any) -> Any:
        envs.append(kw["env"])
        raise FileNotFoundError("stop here")

    async def no(*a: Any, **k: Any) -> bool:
        return False

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    sc = ais_sidecar._SIDECARS[0]
    monkeypatch.setattr(sc, "_already_healthy", no)
    monkeypatch.setattr(sc, "_port_holder_pid", lambda: None)
    await sc.start()

    from app.config import get_settings

    s = get_settings()
    monkeypatch.setattr(s, "browser_fetch_enabled", True)
    monkeypatch.setattr(browser_fetch, "_serving", no)
    monkeypatch.setattr(browser_fetch.sidecar_token, "mismatch", no)
    await browser_fetch.start()

    bridge = mavlink_sidecar._Bridge()
    monkeypatch.setattr(bridge, "_already_healthy", no)
    monkeypatch.setenv("MAVLINK_BRIDGE_TOKEN", "bridge-token")
    await bridge.start()

    assert len(envs) == 3
    for env in envs:
        _assert_clean(env)
    assert "SIDECAR_TOKEN" in envs[1], "browser-fetch is spawned with its token"
    assert envs[2]["MAVLINK_BRIDGE_TOKEN"] == "bridge-token", "the bridge still gets its own token"


async def test_llm_sidecars_get_clean_envs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from app import llamacpp_sidecar, llm, vllm_sidecar
    from app.config import Settings
    from app.localllm import manager

    _set_secrets(monkeypatch)
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "0")
    manager.override_models_dir(str(tmp_path / "models"))
    envs: dict[str, dict] = {}

    async def no() -> bool:
        return False

    try:
        # vLLM
        monkeypatch.setattr(vllm_sidecar, "get_settings", lambda: Settings(vllm_enabled=True))
        monkeypatch.setattr(vllm_sidecar, "_installed_version", lambda: "0.18.0")
        monkeypatch.setattr(vllm_sidecar, "_already_healthy", no)
        monkeypatch.setattr(vllm_sidecar, "_BOOT_TIMEOUT_S", 0.0)
        target = manager.models_root() / "abc123def456"
        target.mkdir(parents=True)
        (target / "model.safetensors").write_bytes(b"x")
        (target / "metadata.json").write_text(
            '{"key": "abc123def456", "repo_id": "u/x", "quant": "none", '
            '"filename": "model.safetensors", "size_bytes": 1, "tier": null}'
        )
        manager.set_active("main", "abc123def456")

        async def vexec(*argv: Any, **kw: Any) -> Any:
            envs["vllm"] = kw["env"]
            return _FakeProc()

        monkeypatch.setattr(vllm_sidecar.asyncio, "create_subprocess_exec", vexec)
        await vllm_sidecar.start()

        # llama.cpp
        monkeypatch.setattr(
            llamacpp_sidecar.binary, "find_binary", lambda *a, **k: Path("/usr/bin/llama-server")
        )
        key = manager.key_for("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
        gg = manager.models_root() / key
        gg.mkdir(parents=True)
        (gg / "model.gguf").write_bytes(b"x")
        manager._write_metadata(gg, key, "unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL", size_bytes=1)
        llm.set_prefer_local(True)
        calls = {"n": 0}

        async def healthy_after_spawn() -> bool:
            calls["n"] += 1
            return calls["n"] > 1

        monkeypatch.setattr(llamacpp_sidecar, "_already_healthy", healthy_after_spawn)

        async def lexec(*argv: Any, **kw: Any) -> Any:
            envs["llamacpp"] = kw["env"]
            return _FakeProc()

        monkeypatch.setattr(llamacpp_sidecar.asyncio, "create_subprocess_exec", lexec)
        await llamacpp_sidecar.start()
    finally:
        if llamacpp_sidecar._hot_poll_task is not None:
            llamacpp_sidecar._hot_poll_task.cancel()
        llamacpp_sidecar._hot_poll_task = None
        llamacpp_sidecar._proc = None
        llamacpp_sidecar._api_key = None
        vllm_sidecar._proc = None
        vllm_sidecar._api_key = None
        vllm_sidecar._served_model_key = None
        llm.set_prefer_local(None)
        manager.override_models_dir(None)

    assert set(envs) == {"vllm", "llamacpp"}
    for env in envs.values():
        _assert_clean(env)
        assert env["CUDA_VISIBLE_DEVICES"] == "0"


def test_no_sidecar_spawner_spreads_os_environ() -> None:
    for name in ("adsb_sidecar", "ais_sidecar", "browser_fetch", "mavlink_sidecar",
                 "llamacpp_sidecar", "vllm_sidecar"):
        src = (_APP / f"{name}.py").read_text()
        assert "**os.environ" not in src and "dict(os.environ)" not in src, name
        assert "childenv.child_env(" in src, name


# ── V13.2.1: sidecar tokens ───────────────────────────────────────────────────


def test_adsb_poller_sends_the_token_only_to_the_sidecar_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.routes import adsb

    token = sidecar_token.mint(adsb_sidecar.TOKEN_NAME)
    seen: dict[str, dict] = {}

    class _Client:
        def get(self, url: str, timeout: Any = None, headers: Any = None) -> httpx.Response:
            seen[url] = dict(headers or {})
            return httpx.Response(304)

    monkeypatch.setattr(adsb, "_sync_feed_client", lambda: _Client())
    side = f"http://127.0.0.1:{adsb_sidecar._PORT}/aircraft.json"
    other = "http://127.0.0.1:9999/aircraft.json"
    remote = "https://globe.example.test/data/aircraft.json"
    for u in (side, other, remote):
        adsb._fetch_one_feed_sync(u)
    assert seen[side]["Authorization"] == f"Bearer {token}"
    assert "Authorization" not in seen[other]
    assert "Authorization" not in seen[remote]


async def test_browser_fetch_sends_its_token(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "browser_fetch_enabled", True)

    async def public(_u: str) -> bool:
        return True

    monkeypatch.setattr("app.news.images._is_public_url", public)
    token = sidecar_token.mint(browser_fetch.TOKEN_NAME)
    sent: dict = {}

    async def fake_get(self: Any, url: str, **kw: Any) -> httpx.Response:
        sent.update(kw)
        return httpx.Response(200, json={"status": 200, "body_b64": ""})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    assert await browser_fetch.fetch("https://example.test/") is not None
    assert sent["headers"] == {"Authorization": f"Bearer {token}"}


async def test_start_replaces_a_serving_sidecar_that_does_not_hold_our_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A sidecar from before enforcement answers /health 200 forever, so only a
    token check can tell the supervisor it is not ours to adopt."""
    killed: list[int] = []
    spawned: list[bool] = []

    async def yes(*a: Any, **k: Any) -> bool:
        return True

    async def kill(pid: int) -> None:
        killed.append(pid)

    async def fake_exec(*a: Any, **k: Any) -> Any:
        spawned.append(True)
        raise FileNotFoundError("node")

    monkeypatch.setattr(adsb_sidecar.sidecar_token, "mismatch", yes)
    monkeypatch.setattr(adsb_sidecar, "_already_healthy", yes)
    monkeypatch.setattr(adsb_sidecar, "_serving", yes)
    monkeypatch.setattr(adsb_sidecar, "_port_holder_pid", lambda: 777)
    monkeypatch.setattr(adsb_sidecar, "_kill_pid", kill)
    monkeypatch.setattr(adsb_sidecar.asyncio, "create_subprocess_exec", fake_exec)
    adsb_sidecar._reuse_pid = None
    await adsb_sidecar.start()
    assert killed == [777] and spawned == [True]
    assert adsb_sidecar._reuse_pid is None


# Real node, stub playwright whose launch never resolves: the HTTP server binds
# before browser init, so the gate is exercised without a browser.
_STUB_PLAYWRIGHT = (
    "const never = () => new Promise(() => {});\n"
    "module.exports = { chromium: { launch: never, launchPersistentContext: never } };\n"
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize(
    ("tool", "data_path"),
    [("adsb-globe-feeder", "/aircraft.json"), ("ais-myshiptracking-feeder", "/vessels.json")],
)
def test_feeder_refuses_data_without_the_spawn_token(
    tool: str, data_path: str, tmp_path: Path
) -> None:
    stub = tmp_path / "node_modules" / "playwright"
    stub.mkdir(parents=True)
    (stub / "index.js").write_text(_STUB_PLAYWRIGHT)
    port = _free_port()
    env = childenv.child_env(
        {"PORT": str(port), "SIDECAR_TOKEN": "t0k", "NODE_PATH": str(tmp_path / "node_modules")}
    )
    proc = subprocess.Popen(
        ["node", str(_REPO / "tools" / tool / "index.js")],
        cwd=str(tmp_path), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                httpx.get(f"{base}/health", timeout=1)
                break
            except httpx.TransportError:
                if time.monotonic() > deadline or proc.poll() is not None:
                    raise
                time.sleep(0.1)
        bearer = {"Authorization": "Bearer t0k"}
        assert httpx.get(f"{base}/health").status_code == 200
        assert httpx.get(f"{base}{data_path}").status_code == 401
        assert httpx.get(f"{base}{data_path}", headers={"Authorization": "Bearer no"}).status_code == 401
        assert httpx.get(f"{base}{data_path}", headers=bearer).status_code != 401
        assert httpx.get(f"{base}/health", headers={"Host": f"evil.test:{port}"}).status_code == 421
        assert httpx.get(f"{base}/auth").status_code == 401
        assert httpx.get(f"{base}/auth", headers=bearer).status_code == 204

        # And the API-side check agrees with the real sidecar.
        name = f"t-{tool}"
        sidecar_token._CACHE[name] = "t0k"
        assert asyncio.run(sidecar_token.mismatch(base, name)) is False
        sidecar_token._CACHE[name] = "other"
        assert asyncio.run(sidecar_token.mismatch(base, name)) is True
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_env_var_names_read_here_are_not_secrets() -> None:
    # Guard the allowlist itself: no base name looks like a credential.
    for name in childenv._BASE_NAMES | childenv.BROWSER_NAMES:
        assert not re.search(r"KEY|SECRET|TOKEN|PASSWORD", name), name
    assert os.path.basename(str(_APP)) == "app"
