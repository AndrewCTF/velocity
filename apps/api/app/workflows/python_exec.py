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

BYO-compute for a single-operator local tool, not a hostile-tenant sandbox —
see ``py_runner.py``'s docstring.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from pathlib import Path
from typing import Any

_RUNNER = Path(__file__).resolve().parent / "py_runner.py"

DEFAULT_TIMEOUT_S = 30.0
MAX_TIMEOUT_S = 60.0
_MAX_STDOUT_BYTES = 5 * 1024 * 1024
_READ_CHUNK = 65_536


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
        sys.executable,
        str(_RUNNER),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,  # own process group, so a timeout can kill the whole tree
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
