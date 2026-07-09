"""Interval schedules — background loop that re-runs a transform's build.

Mirrors ``app/intel/watch.py``'s ``start()``/``stop()`` lifecycle: idempotent
start, a cancellable ``asyncio.Task`` looping forever, torn down cleanly on
shutdown / test isolation. Started from the app lifespan ONLY when
``OSINT_DISABLE_BACKGROUND`` is unset (see ``app/main.py``), so unit tests
never have a live poller running against a real clock.
"""

from __future__ import annotations

import asyncio
import logging
import time

from app.foundry import builds
from app.foundry.store import FoundryStore

log = logging.getLogger(__name__)

_CHECK_INTERVAL_S = 5.0

_TASK: asyncio.Task[None] | None = None
_STARTED = False


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


async def _tick() -> None:
    store = FoundryStore()
    due = await store.due_schedules()
    for sch in due:
        last_error: str | None = None
        try:
            result = await builds.run_transform_build(store, sch["transform_id"])
            if result.get("status") != "succeeded":
                last_error = result.get("error") or "build failed"
        except Exception as exc:  # noqa: BLE001 — one bad schedule must not kill the loop
            last_error = str(exc)
        if last_error is not None:
            log.warning(
                "foundry scheduler: schedule %s (transform %s) failed: %s",
                sch["id"],
                sch["transform_id"],
                last_error,
            )
        # ALWAYS advance last_run, success or failure — a broken schedule
        # must never hot-loop the 5 s poller.
        await store.set_schedule_result(sch["id"], last_run=_now_iso(), last_error=last_error)


async def _run_forever() -> None:
    while True:
        try:
            await _tick()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            log.debug("foundry scheduler: tick error: %s", exc)
        await asyncio.sleep(_CHECK_INTERVAL_S)


async def start() -> None:
    """Start the schedule-poll loop (idempotent)."""
    global _TASK, _STARTED
    if _STARTED:
        return
    _STARTED = True
    _TASK = asyncio.create_task(_run_forever())


async def stop() -> None:
    """Cancel the loop (clean shutdown / test isolation)."""
    global _TASK, _STARTED
    _STARTED = False
    if _TASK is not None:
        _TASK.cancel()
        try:
            await _TASK
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _TASK = None
