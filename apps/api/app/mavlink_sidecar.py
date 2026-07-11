"""Lifespan-managed MAVLink bridge sidecar.

Spawns ``python -m app.mavlink_bridge`` as a separate process (the drone control
server the Workflows ``control.drone`` block talks to). A separate process, not
an in-process router, because a MAVLink link is an optional heavy dependency and
a hung serial/UDP read must never block the API event loop — the same isolation
reason the AIS/ADS-B feeders are sidecars.

OFF by default (``mavlink_bridge_enabled``): a bridge that auto-connects to a
vehicle at boot is not something to enable implicitly. When on, it binds
``mavlink_bridge_port`` on localhost; point ``control.drone.server_url`` at it.
Best-effort and idempotent like the AIS sidecar: a reused healthy instance is
adopted; failures log and the backend still serves. Never raises into lifespan.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys

import httpx

from .config import get_settings

log = logging.getLogger("mavlink_sidecar")

# apps/api (this file is apps/api/app/mavlink_sidecar.py) — the cwd the bridge
# child runs in so `-m app.mavlink_bridge` resolves. Computed once at import.
_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class _Bridge:
    def __init__(self) -> None:
        s = get_settings()
        self.port = s.mavlink_bridge_port
        self.connect = s.mavlink_bridge_connect
        self.base = f"http://127.0.0.1:{self.port}"
        self.health = f"{self.base}/health"
        self._proc: asyncio.subprocess.Process | None = None
        self._reuse = False

    async def _already_healthy(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as c:
                return (await c.get(self.health)).status_code == 200
        except Exception:  # noqa: BLE001 — nothing on the port
            return False

    async def start(self) -> None:
        if await self._already_healthy():
            self._reuse = True
            log.info("mavlink bridge already up on %s — reusing", self.base)
            return
        env = {
            **os.environ,
            "PORT": str(self.port),
            "MAVLINK_CONNECT": self.connect,
        }
        # Same jemalloc-scrub as the browser sidecars: a forked child must not
        # inherit run-api.sh's LD_PRELOAD / MALLOC_CONF.
        env.pop("LD_PRELOAD", None)
        env.pop("MALLOC_CONF", None)
        log_path = "/tmp/mavlink-bridge.log"
        try:
            log_file = open(log_path, "ab", buffering=0)  # noqa: SIM115,ASYNC230 — one-shot child log
        except Exception:  # noqa: BLE001 — log file optional
            log_file = None  # type: ignore[assignment]
        # sys.executable = the same venv python running the API (pymavlink, if
        # installed, lives here); cwd=_APP_DIR so `-m app.mavlink_bridge` resolves.
        try:
            self._proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "app.mavlink_bridge",
                cwd=_APP_DIR, env=env, stdout=log_file, stderr=log_file,
                start_new_session=True,
            )
        except FileNotFoundError:
            log.warning("python not found — mavlink bridge disabled")
            return
        await asyncio.sleep(0.6)
        if self._proc.returncode is not None:
            log.warning("mavlink bridge exited early (code %s) — see %s",
                        self._proc.returncode, log_path)
            self._proc = None
            return
        log.info("mavlink bridge spawned on %s (connect=%r)", self.base, self.connect or "log-only")

    async def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None or proc.returncode is not None:
            return
        try:
            os.kill(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=4.0)
        except (TimeoutError, Exception):  # noqa: BLE001 — escalate
            try:
                os.kill(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


_BRIDGE: _Bridge | None = None


async def start() -> None:
    """Spawn the bridge if enabled. Best-effort; never raises."""
    global _BRIDGE
    if not get_settings().mavlink_bridge_enabled:
        return
    _BRIDGE = _Bridge()
    await _BRIDGE.start()


async def stop() -> None:
    global _BRIDGE
    if _BRIDGE is not None:
        await _BRIDGE.stop()
        _BRIDGE = None
