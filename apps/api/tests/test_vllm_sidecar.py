"""app.vllm_sidecar — opt-in gate (enabled + version >= 0.18 + safetensors-only
active model), argv construction, and api-key isolation. Hermetic: subprocess/
network/importlib.metadata are all monkeypatched; vLLM is never actually
imported or spawned.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app import vllm_sidecar as sc
from app.config import Settings
from app.localllm import manager


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path):
    manager.override_models_dir(str(tmp_path / "models"))
    manager._JOBS.clear()
    _reset()
    yield
    manager.override_models_dir(None)
    manager._JOBS.clear()
    _reset()


def _reset() -> None:
    sc._proc = None
    sc._reuse_pid = None
    sc._api_key = None
    sc._served_model_key = None


def _install_safetensors_main() -> str:
    """A fake safetensors "install" the manager never produced itself (the
    manager only ever downloads .gguf) — the operator-drop-in scenario."""
    key = "abc123def456"
    root = manager.models_root()
    target = root / key
    target.mkdir(parents=True, exist_ok=True)
    (target / "model.safetensors").write_bytes(b"fake-safetensors")
    (target / "metadata.json").write_text(
        f'{{"key": "{key}", "repo_id": "unsloth/x", "quant": "none", "filename": '
        '"model.safetensors", "size_bytes": 16, "tier": null}'
    )
    manager.set_active("main", key)
    return key


class _FakeProc:
    def __init__(self) -> None:
        self.pid = 5150
        self.returncode: int | None = None

    async def wait(self) -> int:
        return 0


# ── version gate (CVE-2026-27893) ────────────────────────────────────────────


def test_version_ok_accepts_18_and_above() -> None:
    assert sc._version_ok("0.18.0") is True
    assert sc._version_ok("0.19.2") is True
    assert sc._version_ok("1.0.0") is True


def test_version_ok_rejects_below_18() -> None:
    assert sc._version_ok("0.17.9") is False
    assert sc._version_ok("0.9.0") is False


def test_version_ok_rejects_unparseable_or_missing() -> None:
    assert sc._version_ok(None) is False
    assert sc._version_ok("") is False
    assert sc._version_ok("garbage") is False


# ── is_enabled() ─────────────────────────────────────────────────────────────


def test_is_enabled_false_when_setting_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sc, "get_settings", lambda: Settings(vllm_enabled=False))
    assert sc.is_enabled() is False


def test_is_enabled_false_when_version_too_old(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sc, "get_settings", lambda: Settings(vllm_enabled=True))
    monkeypatch.setattr(sc, "_installed_version", lambda: "0.17.0")
    _install_safetensors_main()
    assert sc.is_enabled() is False


def test_is_enabled_false_when_vllm_not_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sc, "get_settings", lambda: Settings(vllm_enabled=True))
    monkeypatch.setattr(sc, "_installed_version", lambda: None)
    _install_safetensors_main()
    assert sc.is_enabled() is False


def test_is_enabled_false_when_active_main_is_gguf_not_safetensors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sc, "get_settings", lambda: Settings(vllm_enabled=True))
    monkeypatch.setattr(sc, "_installed_version", lambda: "0.19.0")
    key = manager.key_for("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    root = manager.models_root()
    target = root / key
    target.mkdir(parents=True, exist_ok=True)
    (target / "model.gguf").write_bytes(b"fake")
    manager._write_metadata(target, key, "unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL", size_bytes=4)
    manager.set_active("main", key)
    assert sc.is_enabled() is False  # GGUF main model — vLLM never routes here


def test_is_enabled_true_with_version_and_safetensors_main(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sc, "get_settings", lambda: Settings(vllm_enabled=True))
    monkeypatch.setattr(sc, "_installed_version", lambda: "0.18.0")
    _install_safetensors_main()
    assert sc.is_enabled() is True


# ── start(): argv, api key, trust-remote-code, env scrub ─────────────────────


@pytest.mark.asyncio
async def test_start_no_op_when_not_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sc, "get_settings", lambda: Settings(vllm_enabled=False))
    called = {"n": 0}

    async def fake_exec(*a, **k):  # noqa: ANN002, ANN003
        called["n"] += 1
        return _FakeProc()

    monkeypatch.setattr(sc.asyncio, "create_subprocess_exec", fake_exec)
    await sc.start()
    assert called["n"] == 0
    assert sc.api_key() is None


@pytest.mark.asyncio
async def test_start_builds_argv_with_trust_remote_code_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sc, "get_settings", lambda: Settings(vllm_enabled=True))
    monkeypatch.setattr(sc, "_installed_version", lambda: "0.18.0")
    _install_safetensors_main()

    async def not_healthy() -> bool:
        return False

    monkeypatch.setattr(sc, "_already_healthy", not_healthy)

    captured: dict = {}

    async def fake_exec(*argv, **kwargs):  # noqa: ANN002, ANN003
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return _FakeProc()

    monkeypatch.setattr(sc.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setenv("LD_PRELOAD", "libjemalloc.so.2")

    # start() waits (capped) for health after spawn; force immediate timeout
    # by making the deadline already past — patch the boot timeout to ~0.
    monkeypatch.setattr(sc, "_BOOT_TIMEOUT_S", 0.0)

    await sc.start()

    argv = captured["argv"]
    assert argv[0] == "vllm"
    assert argv[1] == "serve"
    assert "--trust-remote-code=false" in argv
    assert "--api-key" in argv
    key_value = argv[argv.index("--api-key") + 1]
    assert key_value == sc.api_key()
    assert sc.api_key() is not None
    assert argv[argv.index("--host") + 1] == "127.0.0.1"
    assert "--served-model-name" in argv

    env = captured["kwargs"]["env"]
    assert "LD_PRELOAD" not in env
    assert captured["kwargs"]["start_new_session"] is True


@pytest.mark.asyncio
async def test_stop_terminates_spawned_process(monkeypatch: pytest.MonkeyPatch) -> None:
    killed = {"pids": []}

    def fake_kill(pid, sig):  # noqa: ANN001
        killed["pids"].append(pid)

    monkeypatch.setattr(sc.os, "kill", fake_kill)
    sc._proc = _FakeProc()
    sc._api_key = "sekret"
    sc._served_model_key = "abc123def456"

    await sc.stop()

    assert killed["pids"] == [5150]
    assert sc._proc is None
    assert sc.api_key() is None
    assert sc.served_model_name() is None
