"""Lifespan-managed headless-browser tar1090 sidecar.

The keyless readsb mirrors (theairtraffic, hpradar) cover ~11k aircraft, but
the Cloudflare-gated aggregators (airplanes.live, adsbexchange) — which carry
the freshest, densest coverage — 403 any server-side httpx. A real headless
Chromium clears Cloudflare and reads tar1090's own ``g.planesOrdered`` store
(~13k @ ~0.4 s), served as a plain readsb ``aircraft.json`` on localhost.
``ADSB_FEED_URLS`` points the snapshot refresher at it; localhost gets the fast
poll interval (``adsb_feed_fast_interval_s``).

Lifecycle: ``start()`` spawns the node process and blocks (capped) until
``/health`` reports aircraft, so the snapshot's first warm cycle already folds
in sidecar data. ``stop()`` tears it down. Both are best-effort — a missing
node/chrome or a failed Cloudflare clear logs a warning and the backend still
serves (just without the sidecar's extra coverage). Never raises into lifespan.
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

log = logging.getLogger("adsb_sidecar")

# tools/adsb-globe-feeder sits at the repo root (this file is apps/api/app/).
_REPO_ROOT = Path(__file__).resolve().parents[3]
_SIDECAR_DIR = _REPO_ROOT / "tools" / "adsb-globe-feeder"
_INDEX = _SIDECAR_DIR / "index.js"

_PORT = int(os.environ.get("ADSB_SIDECAR_PORT", "8090"))
_BASE = f"http://127.0.0.1:{_PORT}"
_HEALTH = f"{_BASE}/health"

# How fast the in-page tar1090 store is re-read + served. tar1090 refreshes
# g.planesOrdered ~continuously server-side, so even 4 s read lag measured
# ~0.4 s position age; 2 s keeps it tight without spinning a hot loop.
_READ_MS = os.environ.get("ADSB_SIDECAR_READ_MS", "1000")
# How long to wait for the browser to clear Cloudflare + populate the store
# before serving best-effort (airplanes typically fill within ~5-15 s).
_BOOT_TIMEOUT_S = float(os.environ.get("ADSB_SIDECAR_BOOT_TIMEOUT_S", "60"))

_proc: asyncio.subprocess.Process | None = None
# pid of a sidecar we REUSED (not spawned) — tracked so stop() can still tear it
# down. Reuse avoids a ~15s browser respawn on every backend restart, but a
# reused process isn't our child, so we remember its pid to kill the group.
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
    """Another sidecar (prior boot, manual run) already serving? Reuse it."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(_HEALTH)
            return r.status_code == 200 and (r.json().get("total") or 0) > 0
    except Exception:  # noqa: BLE001 — nothing on the port
        return False


async def start() -> None:
    """Spawn the sidecar (if not already up) and wait for first aircraft.

    Best-effort: logs + returns on any failure. Idempotent.
    """
    global _proc
    if not _INDEX.exists():
        log.warning("sidecar index not found at %s — skipping", _INDEX)
        return
    if await _already_healthy():
        # Reuse the running sidecar (saves a ~15s browser respawn) but remember
        # its pid so stop() can still tear the (non-child) process down.
        global _reuse_pid
        _reuse_pid = _port_holder_pid()
        log.info("sidecar already healthy on %s — reusing pid %s", _BASE, _reuse_pid)
        return

    env = {
        **os.environ,
        "PORT": str(_PORT),
        "READ_MS": str(_READ_MS),
        # THREE tar1090 aggregators, freshest-wins-by-hex in the sidecar
        # (index.js unioned()):
        #  - globe.airplanes.live: US-heavy (~14k)
        #  - globe.adsbexchange.com: global, heavy EU (~17k)
        #  - adsb.lol: global (~13k)
        # All 403 server-side httpx; the headless browser clears Cloudflare and
        # reads each site's g.planesOrdered. The THIRD source isn't for coverage
        # (the first two already union to ~18k) — it's for REFRESH RATE: each
        # aggregator regenerates its full globe only ~every 10 s, but at DIFFERENT
        # phases, so freshest-wins across three of them drops the effective world
        # refresh from ~10 s to ~2-3 s (measured) — the tar1090 "~1 s" effect that
        # a single Cloudflare-gated aggregator can't give a datacenter IP. A source
        # that won't clear Cloudflare just contributes 0 (serve-before-init +
        # per-source self-heal isolate it). Override via ADSB_SIDECAR_GLOBE_URLS.
        "GLOBE_URLS": os.environ.get(
            "ADSB_SIDECAR_GLOBE_URLS",
            "https://globe.airplanes.live/,https://globe.adsbexchange.com/,https://adsb.lol/",
        ),
        # Force the no-sandbox system Chrome path (no bundled Playwright Chromium
        # on this distro); index.js honours CHROME_PATH.
        "CHROME_PATH": os.environ.get(
            "CHROME_PATH", "/usr/bin/google-chrome-stable"
        ),
    }
    # The backend runs under jemalloc (scripts/run-api.sh exports LD_PRELOAD +
    # MALLOC_CONF with background_thread:true). Chrome inherits them through this
    # env and its zygote fork dies at spawn ("GPU process launch failed:
    # error_code=1002" → FATAL), leaving the sidecar serving 0 aircraft forever.
    # Bisected 2026-07-04: the LD_PRELOAD+MALLOC_CONF pair is the minimal failing
    # combination; either alone is fine. jemalloc is for the Python process only —
    # never let it leak into the node/Chrome tree.
    env.pop("LD_PRELOAD", None)
    env.pop("MALLOC_CONF", None)
    log_path = "/tmp/adsb-sidecar.log"
    try:
        log_file = open(log_path, "ab", buffering=0)  # noqa: SIM115 — append child log
        log.info("sidecar stdout/stderr -> %s", log_path)
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
        log.warning("node not found on PATH — sidecar disabled")
        return

    # Wait (capped) for the browser to clear Cloudflare + populate the store.
    deadline = asyncio.get_event_loop().time() + _BOOT_TIMEOUT_S
    while asyncio.get_event_loop().time() < deadline:
        if _proc.returncode is not None:
            log.warning("sidecar exited early (code %s) — see %s", _proc.returncode, log_path)
            _proc = None
            return
        if await _already_healthy():
            log.info("sidecar healthy on %s", _BASE)
            return
        await asyncio.sleep(2.0)
    log.warning("sidecar did not report aircraft within %.0fs — serving best-effort", _BOOT_TIMEOUT_S)


async def stop() -> None:
    """Terminate the sidecar (no-op if not ours / already gone).

    Covers both a spawned (``_proc``) and a reused (``_reuse_pid``) sidecar.
    NOTE: the node sidecar runs in its own session (start_new_session), and
    os.killpg is silently a no-op against a setsid'd leader from the parent —
    so we kill by DIRECT pid. Killing node frees the port; its Chromium
    grandchildren exit when their CDP pipe to node closes.
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
    log.info("stopping sidecar pids=%s", pids)

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
