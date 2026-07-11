"""app.llamacpp_sidecar — router-mode argv construction, is_enabled() gating,
health probing, and hot-model wiring. Hermetic: subprocess/network are
monkeypatched throughout; no real llama-server is ever spawned.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app import llamacpp_sidecar as sc
from app.localllm import manager, state


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path):
    manager.override_models_dir(str(tmp_path / "models"))
    manager._JOBS.clear()
    state.set_engine(None)
    _reset_sidecar_state()
    yield
    manager.override_models_dir(None)
    manager._JOBS.clear()
    state.set_engine(None)
    _reset_sidecar_state()


def _reset_sidecar_state() -> None:
    if sc._hot_poll_task is not None:
        sc._hot_poll_task.cancel()
    sc._proc = None
    sc._api_key = None
    sc._hot_poll_task = None
    sc._known_hot = set()


def _install(repo_id: str = "unsloth/Qwen3.5-9B-GGUF", quant: str = "UD-Q4_K_XL") -> str:
    key = manager.key_for(repo_id, quant)
    root = manager.models_root()
    target = root / key
    target.mkdir(parents=True, exist_ok=True)
    (target / "model.gguf").write_bytes(b"fake-weights")
    manager._write_metadata(target, key, repo_id, quant, size_bytes=12)
    return key


class _FakeProc:
    def __init__(self) -> None:
        self.pid = 4242
        self.returncode: int | None = None

    async def wait(self) -> int:
        return 0


# ── is_enabled() ─────────────────────────────────────────────────────────────


def test_is_enabled_false_with_no_binary_and_no_models() -> None:
    assert sc.is_enabled() is False


def test_is_enabled_false_when_engine_explicitly_ollama(monkeypatch: pytest.MonkeyPatch) -> None:
    state.set_engine("ollama")
    monkeypatch.setattr(sc.binary, "find_binary", lambda *a, **k: Path("/usr/bin/llama-server"))
    _install()
    assert sc.is_enabled() is False


def test_is_enabled_false_when_engine_explicitly_vllm(monkeypatch: pytest.MonkeyPatch) -> None:
    state.set_engine("vllm")
    monkeypatch.setattr(sc.binary, "find_binary", lambda *a, **k: Path("/usr/bin/llama-server"))
    _install()
    assert sc.is_enabled() is False


def test_is_enabled_false_without_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sc.binary, "find_binary", lambda *a, **k: None)
    _install()
    assert sc.is_enabled() is False


def test_is_enabled_false_without_installed_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sc.binary, "find_binary", lambda *a, **k: Path("/usr/bin/llama-server"))
    assert sc.is_enabled() is False


def test_is_enabled_true_engine_auto_with_binary_and_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sc.binary, "find_binary", lambda *a, **k: Path("/usr/bin/llama-server"))
    _install()
    assert sc.is_enabled() is True


def test_is_enabled_true_engine_explicitly_llamacpp(monkeypatch: pytest.MonkeyPatch) -> None:
    state.set_engine("llamacpp")
    monkeypatch.setattr(sc.binary, "find_binary", lambda *a, **k: Path("/usr/bin/llama-server"))
    _install()
    assert sc.is_enabled() is True


# ── start(): router-mode argv, api key, env scrub ────────────────────────────


@pytest.mark.asyncio
async def test_start_no_op_when_not_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    called = {"n": 0}

    async def fake_exec(*a, **k):  # noqa: ANN002, ANN003
        called["n"] += 1
        return _FakeProc()

    monkeypatch.setattr(sc.asyncio, "create_subprocess_exec", fake_exec)
    await sc.start()
    assert called["n"] == 0
    assert sc.api_key() is None


@pytest.mark.asyncio
async def test_start_builds_router_mode_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sc.binary, "find_binary", lambda *a, **k: Path("/usr/bin/llama-server"))
    _install()

    health_calls = {"n": 0}

    async def fake_already_healthy() -> bool:
        health_calls["n"] += 1
        # First call (pre-spawn reuse check) → not up; subsequent (post-spawn
        # poll) → healthy immediately.
        return health_calls["n"] > 1

    monkeypatch.setattr(sc, "_already_healthy", fake_already_healthy)

    captured: dict = {}

    async def fake_exec(*argv, **kwargs):  # noqa: ANN002, ANN003
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return _FakeProc()

    monkeypatch.setattr(sc.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setenv("LD_PRELOAD", "libjemalloc.so.2")
    monkeypatch.setenv("MALLOC_CONF", "background_thread:true")

    await sc.start()

    argv = captured["argv"]
    assert str(argv[0]) == "/usr/bin/llama-server"
    assert "--models-dir" in argv
    assert "--models-max" in argv
    assert argv[argv.index("--host") + 1] == "127.0.0.1"
    assert "--rpc" not in argv
    assert "--flash-attn" in argv
    assert argv[argv.index("--flash-attn") + 1] == "auto"

    assert "--api-key" in argv
    key_value = argv[argv.index("--api-key") + 1]
    assert key_value == sc.api_key()
    assert sc.api_key() is not None
    assert len(sc.api_key()) > 20  # secrets.token_urlsafe(32) is long

    env = captured["kwargs"]["env"]
    assert "LD_PRELOAD" not in env
    assert "MALLOC_CONF" not in env
    assert captured["kwargs"]["start_new_session"] is True

    if sc._hot_poll_task is not None:
        sc._hot_poll_task.cancel()


@pytest.mark.asyncio
async def test_start_reuses_own_already_running_instance(monkeypatch: pytest.MonkeyPatch) -> None:
    """A healthy instance found on the port that THIS process already spawned
    (idempotent re-entry) is reused as-is — no kill, no respawn, key
    untouched."""
    monkeypatch.setattr(sc.binary, "find_binary", lambda *a, **k: Path("/usr/bin/llama-server"))
    _install()

    sc._proc = _FakeProc()  # our own tracked process, still alive
    sc._api_key = "our-existing-boot-key"

    async def always_healthy() -> bool:
        return True

    monkeypatch.setattr(sc, "_already_healthy", always_healthy)

    killed = {"n": 0}

    def fake_kill(pid, sig):  # noqa: ANN001
        killed["n"] += 1

    monkeypatch.setattr(sc.os, "kill", fake_kill)

    called = {"n": 0}

    async def fake_exec(*a, **k):  # noqa: ANN002, ANN003
        called["n"] += 1
        return _FakeProc()

    monkeypatch.setattr(sc.asyncio, "create_subprocess_exec", fake_exec)

    await sc.start()
    assert called["n"] == 0  # reused, never respawned
    assert killed["n"] == 0  # our own instance is never killed
    assert sc.api_key() == "our-existing-boot-key"  # key untouched


@pytest.mark.asyncio
async def test_start_kills_foreign_instance_and_respawns_with_own_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A healthy instance on the port that THIS process did NOT spawn (no
    tracked ``_proc``, e.g. a stale process from a prior crashed boot) is
    never trusted or silently reused — it's killed by port-holder pid and
    replaced with a fresh instance bound to our own per-boot key, so
    ``_llamacpp_chat`` can actually authenticate against it."""
    monkeypatch.setattr(sc.binary, "find_binary", lambda *a, **k: Path("/usr/bin/llama-server"))
    _install()
    assert sc._proc is None  # nothing tracked — any healthy instance is foreign

    health_calls = {"n": 0}

    async def fake_already_healthy() -> bool:
        health_calls["n"] += 1
        # 1: pre-spawn check finds the foreign instance healthy.
        # 2: inside the kill helper, right after SIGTERM — it's dead.
        # 3+: post-spawn boot-poll of OUR new instance — healthy.
        if health_calls["n"] == 1:
            return True
        if health_calls["n"] == 2:
            return False
        return True

    monkeypatch.setattr(sc, "_already_healthy", fake_already_healthy)
    monkeypatch.setattr(sc, "_port_holder_pid", lambda port: 9999)

    killed: list[tuple[int, int]] = []

    def fake_kill(pid, sig):  # noqa: ANN001
        killed.append((pid, sig))

    monkeypatch.setattr(sc.os, "kill", fake_kill)

    captured: dict = {}

    async def fake_exec(*argv, **kwargs):  # noqa: ANN002, ANN003
        captured["argv"] = argv
        return _FakeProc()

    monkeypatch.setattr(sc.asyncio, "create_subprocess_exec", fake_exec)

    await sc.start()

    assert killed == [(9999, sc.signal.SIGTERM)]  # foreign pid killed, no SIGKILL needed
    assert "argv" in captured  # a fresh instance WAS spawned
    assert sc.api_key() is not None  # our own freshly-minted key, not a foreign unknown one

    if sc._hot_poll_task is not None:
        sc._hot_poll_task.cancel()


@pytest.mark.asyncio
async def test_stop_is_a_no_op_when_never_started() -> None:
    await sc.stop()  # must not raise
    assert sc.api_key() is None


@pytest.mark.asyncio
async def test_stop_terminates_spawned_process(monkeypatch: pytest.MonkeyPatch) -> None:
    killed = {"pids": []}

    def fake_kill(pid, sig):  # noqa: ANN001
        killed["pids"].append(pid)

    monkeypatch.setattr(sc.os, "kill", fake_kill)
    sc._proc = _FakeProc()
    sc._api_key = "sekret"

    await sc.stop()

    assert killed["pids"] == [4242]
    assert sc._proc is None
    assert sc.api_key() is None


# ── ensure_hot() / hot-load wiring ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ensure_hot_no_op_when_sidecar_not_running() -> None:
    key = _install()
    # sc._api_key is None (sidecar never started) — must not attempt any HTTP call.
    await sc.ensure_hot(key)  # must not raise


@pytest.mark.asyncio
async def test_ensure_hot_posts_models_load_for_installed_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = _install()
    sc._api_key = "boot-key-123"

    posted = {}

    class _FakeAsyncClient:
        def __init__(self, *a, **k):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN204
            return self

        async def __aexit__(self, *a):  # noqa: ANN002
            return False

        async def post(self, url, json):  # noqa: ANN001
            posted["url"] = url
            posted["json"] = json

            class _R:
                status_code = 200

            return _R()

    monkeypatch.setattr(sc.httpx, "AsyncClient", _FakeAsyncClient)
    await sc.ensure_hot(key)

    assert posted["url"].endswith("/models/load")
    assert posted["json"]["model"] == "model.gguf"


@pytest.mark.asyncio
async def test_ensure_hot_unknown_key_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    sc._api_key = "boot-key-123"

    def fail_client(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("must not open an httpx client for an unknown key")

    monkeypatch.setattr(sc.httpx, "AsyncClient", fail_client)
    await sc.ensure_hot("0" * 12)  # not installed — must not raise or call out
