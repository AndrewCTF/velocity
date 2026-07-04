"""Lifespan-managed headless-browser VesselFinder sidecar (the AIS twin of
:mod:`app.adsb_sidecar`).

No keyless GLOBAL AIS REST feed is reachable from a datacenter IP — the keyless
backend sources are Northern-Europe regional (~4.5k). VesselFinder aggregates
terrestrial + satellite AIS worldwide but gates its tile API behind Cloudflare +
a packed-binary wire format. A real headless Chromium clears Cloudflare, drives
the page's own authorized ``fetch('/api/pub/mp2?bbox=...')`` across a world grid,
decodes the records in-page, and serves the union as ``vessels.json`` on
localhost. ``app.ais_keyless`` polls it and republishes each fix into the unified
vessel store + ``/ws/ais`` (~21k vessels worldwide, measured 2026-06-29).

Lifecycle: ``start()`` spawns the node process and returns — it does NOT block on
the first world-grid scrape (~15-30s), because the poller tolerates a cold/empty
sidecar (it just publishes 0 until vessels land). ``stop()`` tears it down. Both
are best-effort — a missing node/chrome or a failed Cloudflare clear logs a
warning and the backend still serves (just without global vessels). Never raises
into lifespan.

Playwright is reused from the ADS-B feeder's ``node_modules`` via ``NODE_PATH``
(same lib, same system Chrome via ``CHROME_PATH``) so there is no second install
and no second bundled-Chromium download.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import signal
import subprocess
from pathlib import Path

import httpx

log = logging.getLogger("ais_sidecar")

# tools/ais-vesselfinder-feeder sits at the repo root (this file is apps/api/app/).
_REPO_ROOT = Path(__file__).resolve().parents[3]
_SIDECAR_DIR = _REPO_ROOT / "tools" / "ais-vesselfinder-feeder"
_INDEX = _SIDECAR_DIR / "index.js"
# Reuse the ADS-B feeder's installed playwright (no second npm install / Chromium).
_NODE_MODULES = _REPO_ROOT / "tools" / "adsb-globe-feeder" / "node_modules"

_PORT = int(os.environ.get("AIS_SIDECAR_PORT", "8091"))
_BASE = f"http://127.0.0.1:{_PORT}"
_HEALTH = f"{_BASE}/health"

# World-grid refresh cadence. Vessels move slowly (AIS reports every few min),
# so 30 s is plenty fresh and gentle on VesselFinder's rate limit.
_READ_MS = os.environ.get("AIS_SIDECAR_READ_MS", "30000")

_proc: asyncio.subprocess.Process | None = None
# pid of a sidecar we REUSED (not spawned) — tracked so stop() can still tear it
# down across a backend restart (saves a ~15s browser respawn).
_reuse_pid: int | None = None


def _port_holder_pid() -> int | None:
    """pid holding our port (best-effort, via ss). None if free."""
    try:
        out = subprocess.run(
            ["ss", "-ltnp"], capture_output=True, text=True, timeout=3
        ).stdout
    except Exception:  # noqa: BLE001 — ss missing / permission
        return None
    for line in out.splitlines():
        if f":{_PORT} " in line or line.rstrip().endswith(f":{_PORT}"):
            m = re.search(r"pid=(\d+)", line)
            if m:
                return int(m.group(1))
    return None


async def _already_healthy() -> bool:
    """Another sidecar (prior boot, manual run) already serving? Reuse it.

    Healthy means the HTTP server is up — NOT that vessels have landed yet (the
    first world-grid scrape takes ~15-30s and the poller tolerates an empty
    union), so we accept any 200 /health, not total>0.
    """
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(_HEALTH)
            return r.status_code == 200
    except Exception:  # noqa: BLE001 — nothing on the port
        return False


async def start() -> None:
    """Spawn the sidecar (if not already up) and return. Best-effort, idempotent.

    Does NOT block on the first scrape — the backend's keyless AIS poller
    publishes 0 vessels until the world grid lands, then they flow in.
    """
    global _proc, _reuse_pid
    if not _INDEX.exists():
        log.warning("ais sidecar index not found at %s — skipping", _INDEX)
        return
    if await _already_healthy():
        _reuse_pid = _port_holder_pid()
        log.info("ais sidecar already up on %s — reusing pid %s", _BASE, _reuse_pid)
        return

    env = {
        **os.environ,
        "PORT": str(_PORT),
        "READ_MS": str(_READ_MS),
        # Reuse the ADS-B feeder's playwright install (require('playwright')
        # resolves via NODE_PATH); no bundled Chromium — index.js honours
        # CHROME_PATH for the no-sandbox system Chrome.
        "NODE_PATH": os.environ.get("NODE_PATH", str(_NODE_MODULES)),
        "CHROME_PATH": os.environ.get("CHROME_PATH", "/usr/bin/google-chrome-stable"),
    }
    log_path = "/tmp/ais-sidecar.log"
    try:
        log_file = open(log_path, "ab", buffering=0)  # noqa: SIM115 — append child log
        log.info("ais sidecar stdout/stderr -> %s", log_path)
    except Exception:  # noqa: BLE001 — log file optional
        log_file = None  # type: ignore[assignment]

    try:
        _proc = await asyncio.create_subprocess_exec(
            "node", str(_INDEX),
            cwd=str(_SIDECAR_DIR),
            env=env,
            stdout=log_file,
            stderr=log_file,
            # New process group so stop() can kill the whole browser tree.
            start_new_session=True,
        )
    except FileNotFoundError:
        log.warning("node not found on PATH — ais sidecar disabled")
        return

    # Confirm it didn't instantly die (bad node, missing playwright), then return
    # without waiting for the first scrape.
    await asyncio.sleep(1.0)
    if _proc.returncode is not None:
        log.warning("ais sidecar exited early (code %s) — see %s", _proc.returncode, log_path)
        _proc = None
        return
    log.info("ais sidecar spawned on %s (warming world grid in background)", _BASE)


async def stop() -> None:
    """Terminate the sidecar (no-op if not ours / already gone).

    Like the ADS-B sidecar, node runs in its own session (start_new_session), so
    os.killpg is a silent no-op against the setsid'd leader — kill by DIRECT pid.
    Killing node frees the port; its Chromium grandchildren exit when their CDP
    pipe to node closes.
    """
    global _proc, _reuse_pid
    proc, _proc = _proc, None
    reuse_pid, _reuse_pid = _reuse_pid, None

    pids = []
    if proc is not None and proc.returncode is None:
        pids.append(proc.pid)
    if reuse_pid:
        pids.append(reuse_pid)
    if not pids:
        return
    log.info("stopping ais sidecar pids=%s", pids)

    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if proc is not None:
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001 — escalate
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
