"""Lifespan-managed llama.cpp ROUTER-MODE sidecar — the primary OpenAI-compatible
serving engine for ``app.localllm``'s installed Unsloth GGUFs (design doc
"Sidecar module"; research-serving-security.md's llama.cpp section).

llama-server in router mode (no ``-m``, ``--models-dir <root> --models-max N``)
auto-loads whichever installed ``.gguf`` the OpenAI ``model`` field names on
first use and LRU-evicts past ``--models-max``; ``app.llm``'s ``_llamacpp_chat``
rung is the only in-process caller of its ``/v1/chat/completions``. Binds
``127.0.0.1`` only, with a per-boot ``secrets.token_urlsafe(32)`` bearer key
held ONLY in this module's memory and never returned in any route response —
same isolation reasoning as the headless-browser feeders
(``app.adsb_sidecar`` / ``app.ais_sidecar``): a hung or compromised child
process must never expose a credential, and a fresh key every boot means a
leaked prior-run key is dead on restart.

``/health`` needs no key — llama-server's own server README documents it as
the one route exempt from ``--api-key`` — so ``_already_healthy`` probes it
bare, same as the AIS/ADS-B sidecars probe their feeders. ``--rpc`` is NEVER
passed (CVE-2026-34159, RPC RCE): router mode over ``--models-dir`` needs no
worker/backend delegation, so there is no reason to ever enable it here.

Lifecycle: ``start()`` spawns llama-server, or reuses it if THIS process
already has one running healthy (idempotent re-entry). A healthy instance on
the port that this process did NOT spawn — a stale process from a prior
crashed boot, or anything else squatting there — is never trusted: its
``--api-key`` is unknown to us, so ``app.llm``'s ``_llamacpp_chat`` rung could
never authenticate against it. Such a foreign instance is killed by
port-holder pid (``_port_holder_pid``, SIGTERM then SIGKILL) and replaced with
a fresh instance bound to our own per-boot key. Once up, ``start()`` ``POST``s
``/models/load`` for every key in the manager's ``hot`` set so they're
resident right after boot instead of cold-loaded on first chat miss. A
background poll (chosen over threading a call-out through
``routes/ai_models.py``'s hot-toggle route, out of scope for this wave) picks
up a hot-set change made at runtime via ``POST /api/ai/models/hot`` within a
few seconds; ``ensure_hot(key)`` is the underlying hook both the boot warm and
the poll loop call. ``stop()`` tears the process down (graceful SIGTERM, then
SIGKILL). Both are best-effort — a missing/unbuildable binary or zero
installed models just skips the sidecar; the backend still serves via the
Ollama rung. Never raises into lifespan.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import signal
import subprocess
from urllib.parse import urlparse

import httpx

from .config import get_settings
from .localllm import binary, manager
from .localllm import state as engine_state

log = logging.getLogger("llamacpp_sidecar")

_HEALTH_TIMEOUT_S = 2.0
_LOAD_TIMEOUT_S = 300.0  # first load of a large MoE can be slow (disk read + mmap)
_BOOT_TIMEOUT_S = 60.0
_HOT_POLL_INTERVAL_S = 5.0

_proc: asyncio.subprocess.Process | None = None
# Per-boot bearer key for llama-server's router mode. Set in start(); the
# browser never sees it — app.llm's _llamacpp_chat rung reads it via api_key().
_api_key: str | None = None
_hot_poll_task: asyncio.Task[None] | None = None
_known_hot: set[str] = set()


def api_key() -> str | None:
    """The per-boot bearer key, or ``None`` before ``start()`` / after ``stop()``."""
    return _api_key


def _host() -> str:
    return get_settings().llamacpp_host.rstrip("/")


def _port() -> int:
    p = urlparse(get_settings().llamacpp_host).port
    return p or 8094


def is_enabled() -> bool:
    """True when the resolved engine wants llama.cpp, a usable ``llama-server``
    binary resolves (operator override, PATH, or a prior managed install), AND
    at least one model is installed. All three are required — a bare binary
    with nothing to serve, or an installed model with no binary, is not
    "enabled". Cheap and side-effect-free beyond ``models_root()``'s
    idempotent ``mkdir``."""
    engine = engine_state.get_engine()
    if engine not in ("auto", "llamacpp"):
        return False
    settings = get_settings()
    root = manager.models_root(settings)
    if binary.find_binary(settings, root) is None:
        return False
    return bool(manager.list_installed())


async def _already_healthy() -> bool:
    """llama-server's ``/health`` is exempt from ``--api-key`` by design — no
    Authorization header needed. Unlike the AIS/ADS-B sidecars (which have no
    credential to lose), a healthy instance found here is only ever reused if
    it's ours; see ``start()``."""
    try:
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT_S) as c:
            r = await c.get(_host() + "/health")
            return r.status_code == 200
    except Exception:  # noqa: BLE001 — nothing on the port
        return False


def _port_holder_pid(port: int) -> int | None:
    """pid holding *port* (best-effort, via ``ss``). ``None`` if free."""
    try:
        out = subprocess.run(
            ["ss", "-ltnp"], capture_output=True, text=True, timeout=3
        ).stdout
    except Exception:  # noqa: BLE001 — ss missing / permission
        return None
    for line in out.splitlines():
        if f":{port} " in line or line.rstrip().endswith(f":{port}"):
            m = re.search(r"pid=(\d+)", line)
            if m:
                return int(m.group(1))
    return None


def _first_filename(meta: dict) -> str | None:
    """Router mode addresses an installed model by its on-disk ``.gguf``
    filename; ``metadata.json`` stores either a single filename or a list
    (split/sharded ggufs) — the first shard is what the router matches on."""
    filename = meta.get("filename")
    if isinstance(filename, list):
        return filename[0] if filename else None
    return filename or None


async def ensure_hot(key: str) -> None:
    """Runtime hook for a hot-set change (``POST /api/ai/models/hot``): when
    the sidecar is up, load the newly-pinned model immediately instead of
    waiting for the next poll tick, a restart, or a cold-load on first chat.
    Best-effort no-op if the sidecar isn't running or the key isn't installed
    — the OpenAI ``model`` field auto-loads on first use regardless, so a
    missed hot-load only costs one cold-start, never correctness."""
    if _api_key is None:
        return
    installed = {m["key"]: m for m in manager.list_installed()}
    meta = installed.get(key)
    filename = _first_filename(meta) if meta else None
    if not filename:
        return
    try:
        async with httpx.AsyncClient(
            timeout=_LOAD_TIMEOUT_S, headers={"Authorization": f"Bearer {_api_key}"}
        ) as c:
            await c.post(_host() + "/models/load", json={"model": filename})
    except Exception as exc:  # noqa: BLE001 — best-effort; chat still cold-loads
        log.warning("llama.cpp ensure_hot(%s) failed (will cold-load on first use): %s", key, exc)


async def _load_hot_models() -> None:
    for key in manager.get_hot():
        await ensure_hot(key)


async def _hot_poll_loop() -> None:
    """Poll the manager's persisted hot set every few seconds so a pin flipped
    via ``POST /api/ai/models/hot`` loads promptly without a sidecar restart.
    Chosen over wiring a call-out from ``routes/ai_models.py`` (excluded from
    this wave's edits) — a cheap poll of local JSON state, diffed against what
    we've already told llama-server to load."""
    global _known_hot
    try:
        while True:
            await asyncio.sleep(_HOT_POLL_INTERVAL_S)
            current = set(manager.get_hot())
            for key in current - _known_hot:
                await ensure_hot(key)
            _known_hot = current
    except asyncio.CancelledError:
        pass


async def _kill_foreign_instance(pid: int | None) -> None:
    """SIGTERM (then SIGKILL after a bounded wait) a process squatting on our
    port that THIS process did not spawn — its ``--api-key`` is unknown to us,
    so ``app.llm``'s ``_llamacpp_chat`` rung could never authenticate against
    it. No-op if the port holder couldn't be resolved (``ss`` missing/denied)
    — the subsequent spawn will simply fail to bind and ``start()``'s own
    boot-timeout loop reports that."""
    if pid is None:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = asyncio.get_event_loop().time() + 5.0
    while asyncio.get_event_loop().time() < deadline:
        if not await _already_healthy():
            return
        await asyncio.sleep(0.2)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


async def start() -> None:
    """Spawn llama-server in router mode. Best-effort, idempotent; no-ops when
    ``is_enabled()`` is False (no binary / no installed model / engine pointed
    elsewhere).

    A healthy instance already on the port is reused ONLY if it is the one
    THIS process spawned (``_proc`` still alive) — a foreign process (stale
    process from a prior crashed boot, or anything else) is killed by
    port-holder pid and replaced with a fresh instance bound to our own
    per-boot key, because a foreign process's key is unknown and unauthenticated
    chats would otherwise fail.
    """
    global _proc, _api_key, _hot_poll_task, _known_hot
    if not is_enabled():
        return
    settings = get_settings()
    root = manager.models_root(settings)
    bin_path = binary.find_binary(settings, root)
    if bin_path is None:  # re-check — is_enabled() may have raced a delete
        return

    if _proc is not None and _proc.returncode is None and await _already_healthy():
        log.info("llama-server already running (pid=%s) — reusing our own instance", _proc.pid)
        return

    if await _already_healthy():
        foreign_pid = _port_holder_pid(_port())
        log.warning(
            "a foreign process (pid=%s) is already listening on %s with an "
            "unknown api key — killing it and spawning our own instance",
            foreign_pid, _host(),
        )
        await _kill_foreign_instance(foreign_pid)

    _api_key = secrets.token_urlsafe(32)
    argv = [
        str(bin_path),
        "--models-dir", str(root),
        "--models-max", str(settings.llamacpp_models_max),
        "--host", "127.0.0.1",
        "--port", str(_port()),
        "--api-key", _api_key,
        "--flash-attn", "auto",
    ]

    env = dict(os.environ)
    # Chrome's zygote-style crash under jemalloc's LD_PRELOAD/MALLOC_CONF
    # doesn't apply to llama-server, but scrub the same pair anyway — it's the
    # standing rule for every spawned sidecar child (adsb_sidecar/ais_sidecar).
    env.pop("LD_PRELOAD", None)
    env.pop("MALLOC_CONF", None)

    log_path = "/tmp/llamacpp-sidecar.log"
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
            start_new_session=True,  # own process group so stop() kills it cleanly
        )
    except FileNotFoundError:
        log.warning("llama-server binary not executable — sidecar disabled")
        _proc = None
        _api_key = None
        return

    deadline = asyncio.get_event_loop().time() + _BOOT_TIMEOUT_S
    while asyncio.get_event_loop().time() < deadline:
        if _proc.returncode is not None:
            log.warning(
                "llama-server exited early (code %s) — see %s", _proc.returncode, log_path
            )
            _proc = None
            _api_key = None
            return
        if await _already_healthy():
            log.info(
                "llama-server healthy on %s (router mode, models-max=%s)",
                _host(), settings.llamacpp_models_max,
            )
            await _load_hot_models()
            _known_hot = set(manager.get_hot())
            _hot_poll_task = asyncio.create_task(_hot_poll_loop())
            return
        await asyncio.sleep(1.0)
    log.warning(
        "llama-server did not report healthy within %.0fs — see %s", _BOOT_TIMEOUT_S, log_path
    )


async def stop() -> None:
    """Terminate llama-server (graceful SIGTERM, then SIGKILL). No-op if not
    ours / already gone."""
    global _proc, _api_key, _hot_poll_task, _known_hot
    if _hot_poll_task is not None:
        _hot_poll_task.cancel()
        _hot_poll_task = None
    _known_hot = set()

    proc, _proc = _proc, None
    _api_key = None

    pids = []
    if proc is not None and proc.returncode is None:
        pids.append(proc.pid)
    if not pids:
        return
    log.info("stopping llama-server pids=%s", pids)
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
