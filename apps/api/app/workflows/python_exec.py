"""Subprocess driver for the Workflows ``op.python`` block.

Spawns ``py_runner.py`` (the static, never-imported entry point next to this
file), writes ONE JSON request document to its stdin, and reads ONE JSON
response document back from stdout. ``py_runner.py`` self-limits CPU (30s) and
address space (1 GiB) via ``resource.setrlimit``; THIS module is the parent
half of the contract — it enforces the WALL timeout (the child's CPU rlimit
doesn't bound e.g. a blocking network call or a busy-wait that yields the
GIL), kills the child's process group on timeout, and caps how much stdout it
will ever buffer (5 MB) so a runaway print loop can't balloon the API
process's memory.

Mirrors the ``start_new_session`` + direct-pid-kill precedent in
``app/adsb_sidecar.py``/``app/ais_sidecar.py`` (that code's docstring notes
``os.killpg`` is silently a no-op against a setsid'd leader from the parent in
this environment) — we try ``killpg`` first (the textbook-correct call) and
always fall back to a direct ``os.kill`` so a stuck child is never left
running either way.

On top of that, the child runs inside a ``bwrap`` jail when bubblewrap is
available: no network, no home, no repo, a read-only system and a private
``/tmp``. The rlimits above bound ACCIDENTS; the jail bounds what a block can
reach on purpose. Without it, ``open(".../apps/api/.env").read()`` inside a
block hands back every API key on the box and a socket sends them anywhere, and
the workflow store is writable by anyone the API lets through. See
``sandbox_tier()`` for what is actually in force — the tier is reported, never
assumed.
"""

from __future__ import annotations

import asyncio
import functools
import json
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

_RUNNER = Path(__file__).resolve().parent / "py_runner.py"

DEFAULT_TIMEOUT_S = 30.0
MAX_TIMEOUT_S = 60.0
_MAX_STDOUT_BYTES = 5 * 1024 * 1024
_READ_CHUNK = 65_536

# The child gets a minimal environment, not this process's. Inheriting it means
# inheriting whatever the operator exported — API keys, tokens, proxy
# credentials — into code the jail otherwise keeps away from the filesystem.
_CHILD_ENV = {
    "PATH": "/usr/bin:/bin",
    "HOME": "/tmp",
    "TMPDIR": "/tmp",
    "LC_ALL": "C.UTF-8",
    "PYTHONDONTWRITEBYTECODE": "1",
}


def _net_allowed() -> bool:
    """``WORKFLOWS_PYTHON_NET=1`` puts the network back inside the jail.

    Off by default. A block that needs to reach out has ``op.http``, which
    already carries the SSRF guard, the per-run dispatch budget and the
    preview dry-run — none of which a raw socket in here would honour.
    """
    return os.getenv("WORKFLOWS_PYTHON_NET", "").strip().lower() in ("1", "true", "yes", "on")


@functools.lru_cache(maxsize=1)
def _bwrap_path() -> str | None:
    """Path to a bubblewrap that actually WORKS here, or None.

    Probed by running it, not by finding it on PATH: bwrap installs cleanly on
    kernels with unprivileged user namespaces disabled, where every invocation
    fails at exec time. Discovering that on the operator's first workflow run,
    as an opaque block failure, is the wrong place to find out.
    """
    exe = shutil.which("bwrap")
    if not exe:
        return None
    try:
        # Probe with the REAL bind list. A cut-down probe lies: without
        # /lib64 the dynamic loader is missing and even /usr/bin/true fails,
        # so a "simpler" probe reports no bubblewrap on a box that has one.
        r = subprocess.run(  # noqa: S603
            [*_JAIL_BINDS(exe), "/usr/bin/true"],
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return exe if r.returncode == 0 else None


def sandbox_tier() -> str:
    """What is actually in force, for the block help text and the guards."""
    if not _bwrap_path():
        return "rlimits-only"
    return "bwrap" if _net_allowed() else "bwrap-nonet"


def _JAIL_BINDS(exe: str) -> list[str]:  # noqa: N802 - reads as a constant at call sites
    """The jail's argv up to (not including) the command. Shared by the probe
    and the real spawn so the two can never drift — a probe that tests a
    different sandbox than the one that runs proves nothing about it."""
    argv = [
        exe,
        "--die-with-parent",     # bwrap goes when the API does; no orphaned jails
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-pid",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind-try", "/lib", "/lib",
        "--ro-bind-try", "/lib64", "/lib64",
        "--ro-bind-try", "/bin", "/bin",
        "--ro-bind-try", "/sbin", "/sbin",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--chdir", "/tmp",
    ]
    if _net_allowed():
        # Resolution and trust roots, or an allowed network is unusable.
        argv += ["--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
                 "--ro-bind-try", "/etc/ssl", "/etc/ssl",
                 "--ro-bind-try", "/etc/hosts", "/etc/hosts"]
    else:
        argv.insert(1, "--unshare-net")
    return argv


def _child_argv() -> list[str]:
    """argv for the runner, jailed when bubblewrap is available.

    The bind list is surgical on purpose. ``sys.prefix`` (the venv) and the
    runner file both live INSIDE the repo, and the repo also holds
    ``apps/api/.env``. Binding a convenient parent — ``apps/api``, or the repo
    root — would carry every credential on the box into the jail and undo the
    whole thing. Bind the venv and the one file, never their parents.
    """
    exe = _bwrap_path()
    if not exe:
        return [sys.executable, str(_RUNNER)]
    return [
        *_JAIL_BINDS(exe),
        "--ro-bind", sys.prefix, sys.prefix,      # the venv: interpreter + site-packages
        "--ro-bind", str(_RUNNER), str(_RUNNER),  # the runner, and nothing else from the repo
        "--",
        sys.executable,
        str(_RUNNER),
    ]


class PythonExecError(Exception):
    """User-facing failure of an ``op.python`` block run."""


def _kill(proc: asyncio.subprocess.Process) -> None:
    for fn in (
        lambda: os.killpg(proc.pid, signal.SIGKILL),
        lambda: os.kill(proc.pid, signal.SIGKILL),
    ):
        try:
            fn()
        except (ProcessLookupError, PermissionError, OSError):
            pass


async def _read_capped(stream: asyncio.StreamReader, cap: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await stream.read(_READ_CHUNK)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > cap:
            break
    return b"".join(chunks)


async def run_python_block(
    code: str,
    rows: list[dict[str, Any]],
    memory: dict[str, Any],
    *,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run ``code`` (must define ``run(rows, memory)``) in the sandboxed
    subprocess. Returns ``(rows_out, memory_out)``. Raises
    ``PythonExecError`` on timeout, a crash, or a malformed/oversized reply —
    NEVER lets an exception here look like anything but a normal Python
    exception to the caller (the engine turns it into a failed run, not a
    500)."""
    timeout = min(max(1.0, float(timeout_s)), MAX_TIMEOUT_S)
    try:
        req = json.dumps({"code": code, "rows": rows, "memory": memory}, default=str).encode()
    except (TypeError, ValueError) as exc:
        raise PythonExecError(f"request not JSON-serializable: {exc}") from exc

    proc = await asyncio.create_subprocess_exec(
        *_child_argv(),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,  # own process group, so a timeout can kill the whole tree
        env=_CHILD_ENV,
    )

    async def _talk() -> bytes:
        assert proc.stdin is not None
        assert proc.stdout is not None
        proc.stdin.write(req)
        try:
            proc.stdin.write_eof()
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        out = await _read_capped(proc.stdout, _MAX_STDOUT_BYTES)
        if len(out) > _MAX_STDOUT_BYTES:
            # Cap breached: stop reading and kill NOW. Otherwise the child keeps
            # writing into a full pipe, `proc.wait()` blocks until the wall
            # timeout, and the caller sees a spurious "timed out" instead of the
            # real "output exceeded cap" — which is what the check below reports.
            _kill(proc)
        await proc.wait()
        return out

    try:
        out = await asyncio.wait_for(_talk(), timeout=timeout)
    except TimeoutError:
        _kill(proc)
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except TimeoutError:
            pass
        raise PythonExecError(f"python block timed out after {timeout:g}s") from None
    except OSError as exc:
        raise PythonExecError(f"failed to run python block: {exc}") from exc

    if len(out) > _MAX_STDOUT_BYTES:
        _kill(proc)
        raise PythonExecError("python block output exceeded the 5MB cap")
    if not out.strip():
        raise PythonExecError("python block produced no output (crashed before printing?)")
    try:
        doc = json.loads(out.decode(errors="replace"))
    except json.JSONDecodeError as exc:
        raise PythonExecError(f"python block produced invalid JSON output: {exc}") from exc
    if not isinstance(doc, dict) or not doc.get("ok"):
        detail = (doc or {}).get("error") if isinstance(doc, dict) else None
        raise PythonExecError(detail or "python block failed")

    out_rows = doc.get("rows")
    out_memory = doc.get("memory")
    if not isinstance(out_rows, list):
        raise PythonExecError("python block did not return a rows list")
    if not isinstance(out_memory, dict):
        out_memory = memory
    return out_rows, out_memory
