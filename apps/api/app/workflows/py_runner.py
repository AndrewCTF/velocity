"""Subprocess entry point for the Workflows `op.python` block.

Reads ONE JSON document on stdin: {"code": str, "rows": [...], "memory": {...}}.
Executes the operator's code in a fresh module namespace under resource limits,
calls its `run(rows, memory)` function, and prints ONE JSON document on stdout:
{"ok": bool, "rows": [...], "memory": {...}, "error": str}.

This is BYO-compute for a single-operator local tool: the limits (CPU, address
space, open files, wall clock enforced by the parent) bound accidents — runaway
loops, memory balloons — not a hostile tenant. Run only on the operator's own
machine with the operator's own code.

Invoked as: python py_runner.py   (never imported by the API process)
"""

from __future__ import annotations

import io
import json
import sys
import traceback

_CPU_SECONDS = 30
_ADDRESS_SPACE_BYTES = 1 << 30  # 1 GiB
_MAX_OPEN_FILES = 64
_MAX_OUTPUT_ROWS = 50_000


def _apply_limits() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (_CPU_SECONDS, _CPU_SECONDS))
        resource.setrlimit(
            resource.RLIMIT_AS, (_ADDRESS_SPACE_BYTES, _ADDRESS_SPACE_BYTES)
        )
        resource.setrlimit(resource.RLIMIT_NOFILE, (_MAX_OPEN_FILES, _MAX_OPEN_FILES))
    except Exception:
        # Non-POSIX or restricted env: wall timeout in the parent still applies.
        pass


def _fail(error: str) -> None:
    sys.__stdout__.write(json.dumps({"ok": False, "rows": [], "memory": {}, "error": error}))
    sys.__stdout__.flush()
    raise SystemExit(0)


def main() -> None:
    _apply_limits()
    try:
        req = json.loads(sys.stdin.read())
        code = str(req.get("code") or "")
        rows = req.get("rows") or []
        memory = req.get("memory") or {}
    except Exception as exc:  # noqa: BLE001
        _fail(f"bad request: {exc}")
        return

    # User prints go to stderr-captured buffer, not our stdout protocol line.
    captured = io.StringIO()
    sys.stdout = captured

    namespace: dict = {"__name__": "__workflow_block__"}
    try:
        exec(compile(code, "<workflow-python-block>", "exec"), namespace)  # noqa: S102
    except MemoryError:
        _fail("memory limit exceeded (1 GiB)")
        return
    except BaseException:  # noqa: BLE001 - includes SystemExit from user code
        _fail(traceback.format_exc(limit=8))
        return

    fn = namespace.get("run")
    if not callable(fn):
        _fail("script must define run(rows, memory)")
        return

    try:
        result = fn(rows, memory)
    except MemoryError:
        _fail("memory limit exceeded (1 GiB)")
        return
    except BaseException:  # noqa: BLE001 - includes SystemExit from user code
        _fail(traceback.format_exc(limit=8))
        return

    out_rows: list = []
    out_memory = memory
    if isinstance(result, dict) and "rows" in result:
        out_rows = result.get("rows") or []
        out_memory = result.get("memory", memory)
    elif isinstance(result, list):
        out_rows = result
    elif result is not None:
        _fail("run() must return list[dict] or {'rows': [...], 'memory': {...}}")
        return

    if not isinstance(out_rows, list):
        _fail("rows must be a list")
        return
    if len(out_rows) > _MAX_OUTPUT_ROWS:
        out_rows = out_rows[:_MAX_OUTPUT_ROWS]
    clean = [r if isinstance(r, dict) else {"value": r} for r in out_rows]
    if not isinstance(out_memory, dict):
        out_memory = {}

    try:
        doc = json.dumps(
            {"ok": True, "rows": clean, "memory": out_memory, "error": ""},
            ensure_ascii=False,
            default=str,
        )
    except (TypeError, ValueError) as exc:
        _fail(f"result not JSON-serializable: {exc}")
        return
    sys.__stdout__.write(doc)
    sys.__stdout__.flush()


if __name__ == "__main__":
    main()
