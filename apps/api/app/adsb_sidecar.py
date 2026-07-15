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
in sidecar data. ``supervise()`` runs for the life of the process and re-starts
the sidecar if it stops SERVING — start() alone runs once, so a sidecar that
died afterwards used to stay dead until the next backend restart, with the feed
tier silently empty. ``stop()`` tears it down. All best-effort — a missing
node/chrome or a failed Cloudflare clear logs a warning and the backend still
serves (just without the sidecar's extra coverage). Never raises into lifespan.

Two health questions, deliberately NOT the same predicate — conflating them is
how a supervisor here turns into a respawn storm on the platform's most critical
feed:
  * ``_serving()``   — is anything answering the port? True from the sidecar's
    first millisecond (index.js binds before browser init). LIVENESS.
  * ``_already_healthy()`` — is it answering WITH aircraft? False for a
    perfectly good sidecar still clearing Cloudflare. Gates reuse + the boot wait.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import signal
import subprocess
from pathlib import Path

import httpx

log = logging.getLogger("adsb_sidecar")

# tools/adsb-globe-feeder sits at the repo root (this file is apps/api/app/).
# In the Docker image this file only has 2 ancestors, so parents[3] would
# IndexError; fall back to the shallowest parent (the sidecar node script is
# absent in the container anyway — start() below is best-effort and no-ops
# without node/chrome).
_PARENTS = Path(__file__).resolve().parents
_REPO_ROOT = _PARENTS[3] if len(_PARENTS) > 3 else _PARENTS[-1]
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


async def _port_holder_pid_async() -> int | None:
    """:func:`_port_holder_pid` off the event loop.

    It shells out to `ss` (~30 ms here, up to its 3 s timeout if the box is
    struggling). That was harmless while it only ran at boot, but supervise() can
    now reach it at RUNTIME via _kill_pid, and this loop drives the 1 s snapshot
    cycle — a synchronous 6×3 s worst case there would wedge every route.
    """
    return await asyncio.to_thread(_port_holder_pid)


def _port_holder_pid() -> int | None:
    """pid holding our port (best-effort, via ss). None if free. BLOCKING —
    call via :func:`_port_holder_pid_async` from the event loop."""
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


async def _serving() -> bool:
    """Is a sidecar ANSWERING on our port? Says nothing about aircraft.

    Deliberately distinct from :func:`_already_healthy`. index.js binds the HTTP
    port BEFORE any browser init (see its main() — a slow Cloudflare clear used
    to hang :8090 for >70s), so "serving" is true from the sidecar's first
    millisecond and cleanly separates LIVENESS from WARM-UP. That separation is
    the whole reason supervise() can exist here: `total > 0` would read false for
    a perfectly good sidecar still clearing Cloudflare, and restarting on it
    would respawn-storm the platform's most critical feed.
    """
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            return (await c.get(_HEALTH)).status_code == 200
    except Exception:  # noqa: BLE001 — nothing on the port
        return False


async def _already_healthy() -> bool:
    """Another sidecar (prior boot, manual run) already serving AIRCRAFT? Reuse it.

    Stricter than _serving(): this gates reuse and the boot wait, where an empty
    sidecar is worth waiting on rather than adopting.
    """
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(_HEALTH)
            return r.status_code == 200 and (r.json().get("total") or 0) > 0
    except Exception:  # noqa: BLE001 — nothing on the port
        return False


async def _kill_pid(pid: int) -> None:
    """SIGTERM, then SIGKILL if it is still holding the port.

    A sidecar wedged on a dead browser does not necessarily die on SIGTERM (the
    AIS twin was measured still LISTENing 12s after `kill`, gone 2s after
    `kill -9` — 2026-07-15), and a survivor EADDRINUSEs the replacement.
    """
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(6):
        await asyncio.sleep(0.5)
        if await _port_holder_pid_async() != pid:
            return
    log.warning("sidecar pid %s ignored SIGTERM — SIGKILL", pid)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


async def _wait_for_aircraft(proc: asyncio.subprocess.Process | None) -> None:
    """Block (capped) until the sidecar reports aircraft, so the snapshot's first
    warm cycle already folds in sidecar data. ``proc`` is our spawned child, if
    any — an early exit aborts the wait."""
    global _proc
    deadline = asyncio.get_event_loop().time() + _BOOT_TIMEOUT_S
    while asyncio.get_event_loop().time() < deadline:
        if proc is not None and proc.returncode is not None:
            log.warning(
                "sidecar exited early (code %s) — see /tmp/adsb-sidecar.log", proc.returncode
            )
            _proc = None
            return
        if await _already_healthy():
            log.info("sidecar healthy on %s", _BASE)
            return
        await asyncio.sleep(2.0)
    log.warning(
        "sidecar did not report aircraft within %.0fs — serving best-effort", _BOOT_TIMEOUT_S
    )


async def start() -> None:
    """Spawn the sidecar (if not already up) and wait for first aircraft.

    Best-effort: logs + returns on any failure. Idempotent.
    """
    global _proc, _reuse_pid
    if not _INDEX.exists():
        log.warning("sidecar index not found at %s — skipping", _INDEX)
        return
    if await _already_healthy():
        # Reuse the running sidecar (saves a ~15s browser respawn) but remember
        # its pid so stop() can still tear the (non-child) process down.
        _reuse_pid = await _port_holder_pid_async()
        log.info("sidecar already healthy on %s — reusing pid %s", _BASE, _reuse_pid)
        return

    # Not healthy, but something may still hold the port. Which case decides
    # whether we adopt or evict, and getting it wrong is expensive both ways:
    #   - SERVING but no aircraft yet = a sidecar still clearing Cloudflare
    #     (index.js binds the port before the browser). Spawning a second node
    #     would only EADDRINUSE and die, leaving us with neither. Adopt it and
    #     wait — this is the fast-restart case, where the previous backend's
    #     sidecar is mid-warm.
    #   - NOT serving but holding the port = wedged or foreign. It would
    #     EADDRINUSE our replacement, so it has to go.
    holder = await _port_holder_pid_async()
    if holder is not None:
        if await _serving():
            _reuse_pid = holder
            log.info("sidecar on %s is up but has no aircraft yet — adopting pid %s", _BASE, holder)
            await _wait_for_aircraft(None)
            return
        log.warning("evicting pid %s holding %s without serving", holder, _BASE)
        await _kill_pid(holder)

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
        log_file = open(log_path, "ab", buffering=0)  # noqa: SIM115,ASYNC230 — one-shot append of the child log at startup; blocking open is fine
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
    await _wait_for_aircraft(_proc)


async def supervise(interval_s: float = 60.0) -> None:
    """Re-``start()`` the sidecar if it stops SERVING. Runs forever.

    ``start()`` only ever ran once, at lifespan boot, so a sidecar that died
    afterwards stayed dead until the next backend restart — the feed tier went
    silently empty and the snapshot quietly fell back to the OpenSky floor. The
    AIS twin proved this is not theoretical (2026-07-15: a restart's start()
    adopted the outgoing backend's sidecar moments before its stop() killed it).

    LIVENESS is the only trigger. NOT `total > 0`: index.js serves before the
    browser is up, so a warming sidecar answers with zero aircraft and restarting
    on that would storm the ≥8000-aircraft feed. A sidecar that is up but dry is
    also NOT ours to fix — its read loop re-inits a dead page every READ_MS and
    relaunches a crashed browser on its own; respawning the process would throw
    that self-heal away and cost another Cloudflare clear. If it is answering, it
    is either working or already healing itself.
    """
    while True:
        await asyncio.sleep(interval_s)
        try:
            if await _serving():
                continue
            log.warning("sidecar not serving on %s — restarting", _BASE)
            await start()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — supervision must never die
            log.warning("sidecar supervise error: %s", e)


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

    # _kill_pid escalates per pid. The escalation used to hang off
    # `if proc is not None`, so a REUSED sidecar (proc is None) only ever got
    # SIGTERM — and one wedged on a dead browser ignores it, keeping the port and
    # getting re-adopted on the next boot. Every pid gets the same treatment now.
    await asyncio.gather(*(_kill_pid(pid) for pid in pids))
    if proc is not None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), timeout=5.0)
