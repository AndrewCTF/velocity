"""Lifespan-managed vLLM sidecar — OPT-IN engine for a safetensors model fully
resident in VRAM (design doc "vLLM"; research-serving-security.md's vLLM
section: vLLM's GGUF support is experimental and REJECTS Unsloth's UD-*
dynamic quant prefixes — GH ggml-org/llama.cpp#39469-equivalent upstream issue
— so every Unsloth GGUF tier this platform curates stays on llama.cpp; vLLM
only ever serves a safetensors checkpoint). Kept intentionally minimal: this
wave's model manager (``app.localllm.manager``) only ever downloads/registers
``.gguf`` files, so this sidecar has nothing to serve until an operator drops
a safetensors model directory in by hand under the active "main" model's key
— there is no download/catalog path for it here.

OFF by default (``settings.vllm_enabled``). Refuses to start — logs a warning
and ``is_enabled()`` returns False — unless the INSTALLED (not necessarily
imported; checked via ``importlib.metadata`` so a heavy/CUDA-initializing
``import vllm`` is never paid just to probe) vllm version is >= 0.18
(CVE-2026-27893, ``trust_remote_code`` bypass). ``--trust-remote-code=false``
is passed explicitly regardless, and no multimodal/video flags are ever added.

Binds ``127.0.0.1`` only with a per-boot bearer key, held only in this
module's memory — same isolation reasoning as ``app.llamacpp_sidecar``.
``start()``/``stop()`` mirror the other sidecars: best-effort, idempotent,
never raise into lifespan.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import logging
import os
import re
import secrets
import signal
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .config import get_settings
from .localllm import manager

log = logging.getLogger("vllm_sidecar")

_HEALTH_TIMEOUT_S = 2.0
_BOOT_TIMEOUT_S = 120.0  # vLLM's CUDA graph capture + warmup is slower to come up than llama.cpp
_MIN_VERSION = (0, 18)

_proc: asyncio.subprocess.Process | None = None
_reuse_pid: int | None = None
_api_key: str | None = None
# The manager key vLLM is serving (its --served-model-name), set in start().
_served_model_key: str | None = None


def api_key() -> str | None:
    return _api_key


def served_model_name() -> str | None:
    """The manager key vLLM is currently serving as its OpenAI ``model`` id,
    or ``None`` if the sidecar isn't up."""
    return _served_model_key


def _host() -> str:
    return get_settings().vllm_host.rstrip("/")


def _port() -> int:
    p = urlparse(get_settings().vllm_host).port
    return p or 8095


def _installed_version() -> str | None:
    try:
        return importlib.metadata.version("vllm")
    except importlib.metadata.PackageNotFoundError:
        return None


def _version_ok(version: str | None) -> bool:
    if not version:
        return False
    parts = re.findall(r"\d+", version)
    if len(parts) < 2:
        return False
    return (int(parts[0]), int(parts[1])) >= _MIN_VERSION


def _active_safetensors_dir(settings) -> tuple[str, Path] | None:  # noqa: ANN001
    """The active "main" model's key + directory, IF that directory holds at
    least one ``.safetensors`` file. GGUF/UD quants (the only thing the
    manager itself downloads) are never routed here."""
    active = manager.get_active().get("main")
    if not active:
        return None
    root = manager.models_root(settings)
    d = root / active
    if not d.is_dir():
        return None
    if any(p.is_file() and p.suffix == ".safetensors" for p in d.iterdir()):
        return active, d
    return None


def is_enabled() -> bool:
    """True only when vLLM is explicitly turned on, an installed vLLM version
    >= 0.18 is resolvable (CVE-2026-27893), AND the active main model is a
    safetensors directory (never a GGUF — vLLM rejects Unsloth's UD-* quants)."""
    settings = get_settings()
    if not settings.vllm_enabled:
        return False
    version = _installed_version()
    if not _version_ok(version):
        if version:
            log.warning(
                "vllm %s < 0.18 (CVE-2026-27893, trust_remote_code bypass) — "
                "refusing to start the vllm sidecar", version,
            )
        else:
            log.warning("vllm is not installed — vllm_enabled has no effect")
        return False
    return _active_safetensors_dir(settings) is not None


async def _already_healthy() -> bool:
    try:
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT_S) as c:
            r = await c.get(_host() + "/health")
            return r.status_code == 200
    except Exception:  # noqa: BLE001 — nothing on the port
        return False


async def start() -> None:
    """Spawn (or reuse) ``vllm serve`` for the active safetensors main model.
    Best-effort, idempotent; no-ops when ``is_enabled()`` is False."""
    global _proc, _reuse_pid, _api_key, _served_model_key
    if not is_enabled():
        return
    settings = get_settings()
    resolved = _active_safetensors_dir(settings)
    if resolved is None:  # re-check — is_enabled() may have raced an active-model change
        return
    key, model_dir = resolved

    if await _already_healthy():
        log.warning(
            "vllm already up on %s — reusing, but its api key is unknown to "
            "this process (restart the backend cleanly to re-establish auth)",
            _host(),
        )
        return

    _api_key = secrets.token_urlsafe(32)
    _served_model_key = key
    argv = [
        "vllm", "serve", str(model_dir),
        "--api-key", _api_key,
        "--host", "127.0.0.1",
        "--port", str(_port()),
        "--served-model-name", key,
        "--trust-remote-code=false",
    ]

    env = dict(os.environ)
    env.pop("LD_PRELOAD", None)
    env.pop("MALLOC_CONF", None)

    log_path = "/tmp/vllm-sidecar.log"
    try:
        log_file = open(log_path, "ab", buffering=0)  # noqa: SIM115,ASYNC230 — one-shot append of the child log at startup
    except Exception:  # noqa: BLE001 — log file optional
        log_file = None  # type: ignore[assignment]

    try:
        _proc = await asyncio.create_subprocess_exec(
            *argv,
            env=env,
            stdout=log_file,
            stderr=log_file,
            start_new_session=True,
        )
    except FileNotFoundError:
        log.warning("vllm binary not found on PATH — vllm sidecar disabled")
        _proc = None
        _api_key = None
        _served_model_key = None
        return

    deadline = asyncio.get_event_loop().time() + _BOOT_TIMEOUT_S
    while asyncio.get_event_loop().time() < deadline:
        if _proc.returncode is not None:
            log.warning("vllm exited early (code %s) — see %s", _proc.returncode, log_path)
            _proc = None
            _api_key = None
            _served_model_key = None
            return
        if await _already_healthy():
            log.info("vllm healthy on %s (serving %s)", _host(), key)
            return
        await asyncio.sleep(2.0)
    log.warning("vllm did not report healthy within %.0fs — see %s", _BOOT_TIMEOUT_S, log_path)


async def stop() -> None:
    global _proc, _reuse_pid, _api_key, _served_model_key
    proc, _proc = _proc, None
    reuse_pid, _reuse_pid = _reuse_pid, None
    _api_key = None
    _served_model_key = None

    pids = []
    if proc is not None and proc.returncode is None:
        pids.append(proc.pid)
    if reuse_pid:
        pids.append(reuse_pid)
    if not pids:
        return
    log.info("stopping vllm pids=%s", pids)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if proc is not None:
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except (TimeoutError, Exception):  # noqa: BLE001 — escalate
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
