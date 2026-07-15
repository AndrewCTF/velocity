"""Lifespan-managed headless-browser AIS sidecars (the AIS twins of
:mod:`app.adsb_sidecar`).

No keyless GLOBAL AIS REST feed is reachable from a datacenter IP — the keyless
backend REST sources are Northern-Europe regional (~4.5k). The vessel-tracking
sites aggregate terrestrial + satellite AIS worldwide but gate their tile APIs
behind Cloudflare (and, for VesselFinder, a packed-binary wire format). A real
headless Chromium clears the gate, drives the page's own tile endpoint across a
world grid, decodes in-page, and serves the union as ``vessels.json`` on
localhost. ``app.ais_keyless`` polls it and republishes each fix into the unified
vessel store + snapshot layer.

Three feeders are registered (only the ENABLED one runs — running two global
scrapers double-renders ships whose ids live in different namespaces):
  * **MyShipTracking** (port 8093) — the ENABLED PRIMARY. MMSI-keyed (dedups
    against every AIS feed), name/sog/cog, NOT Cloudflare-gated; ~22k vessels.
  * **MarineTraffic** (port 8092) — OFF by default. Richer fields
    (name/speed/course/heading/type/flag) but SHIP_ID-keyed (no dedup) and its
    Cloudflare gate throttles a datacenter IP.
  * **VesselFinder** (port 8091) — OFF by default (MMSI-keyed but sparser than
    MyShipTracking).

Each feeder only spawns when its ``ais_*_sidecar_enabled`` setting is true, so a
disabled poller never pays for an idle headless tab. Playwright is reused from
the ADS-B feeder's ``node_modules`` via ``NODE_PATH`` (same lib, same system
Chrome via ``CHROME_PATH``) — no second install, no second bundled Chromium.

Lifecycle: ``start()`` spawns each enabled feeder and returns — it does NOT block
on the first world-grid scrape (~15-30s); the poller tolerates a cold/empty
sidecar. ``stop()`` tears them down. Both are best-effort — a missing node/chrome
or a failed Cloudflare clear logs a warning and the backend still serves. Never
raises into lifespan.
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

from .config import get_settings

log = logging.getLogger("ais_sidecar")

# tools/ sits at the repo root (this file is apps/api/app/).
# In the Docker image this file only has 2 ancestors, so parents[3] would
# IndexError; fall back to the shallowest parent (the feeder scripts are
# absent in the container anyway — each feeder's start() no-ops when its
# index.js is missing).
_PARENTS = Path(__file__).resolve().parents
_REPO_ROOT = _PARENTS[3] if len(_PARENTS) > 3 else _PARENTS[-1]
_TOOLS = _REPO_ROOT / "tools"
# Reuse the ADS-B feeder's installed playwright (no second npm install / Chromium).
_NODE_MODULES = _TOOLS / "adsb-globe-feeder" / "node_modules"


class _Sidecar:
    """One headless-browser vessel feeder process (node ``index.js``)."""

    def __init__(
        self, name: str, dirname: str, port: int, is_enabled, extra_env=None, max_age_s=None
    ):
        self.name = name
        self.dir = _TOOLS / dirname
        self.index = self.dir / "index.js"
        self.port = port
        self.base = f"http://127.0.0.1:{port}"
        self.health = f"{self.base}/health"
        self.is_enabled = is_enabled  # () -> bool
        self.max_age_s = max_age_s  # () -> float | None; oldest union we'll adopt
        self.extra_env = extra_env or {}
        self._proc: asyncio.subprocess.Process | None = None
        # pid of a sidecar we REUSED (not spawned) — tracked so stop() can still
        # tear it down across a backend restart (saves a ~15s browser respawn).
        self._reuse_pid: int | None = None

    def _port_holder_pid(self) -> int | None:
        """pid holding our port (best-effort, via ss). None if free."""
        try:
            out = subprocess.run(
                ["ss", "-ltnp"], capture_output=True, text=True, timeout=3
            ).stdout
        except Exception:  # noqa: BLE001 — ss missing / permission
            return None
        for line in out.splitlines():
            if f":{self.port} " in line or line.rstrip().endswith(f":{self.port}"):
                m = re.search(r"pid=(\d+)", line)
                if m:
                    return int(m.group(1))
        return None

    async def _already_healthy(self) -> bool:
        """Another sidecar (prior boot, manual run) already serving? Reuse it.

        Healthy means the HTTP server is up AND its union is not ancient — NOT
        that vessels have landed yet (the first world-grid scrape takes ~15-30s,
        reports ``age_s: null``, and the poller tolerates an empty union).

        The age check is why this isn't just ``status_code == 200``: when the
        site blocks a feeder's browser it keeps answering /health 200 and keeps
        serving its last scrape forever (2026-07-15: a 27-minute-old union, still
        200). Adopting that re-inherits a frozen tier that no backend restart can
        clear, because every restart reuses it again. Too old → respawn instead.
        """
        try:
            async with httpx.AsyncClient(timeout=2.0) as c:
                r = await c.get(self.health)
                if r.status_code != 200:
                    return False
                cap = self.max_age_s() if self.max_age_s else None
                if cap is None:
                    return True
                age = (r.json() or {}).get("age_s")
                if isinstance(age, (int, float)) and age > cap:
                    log.warning(
                        "ais sidecar %s on %s is serving a %ds-old union (cap %gs) — "
                        "replacing it instead of reusing",
                        self.name, self.base, int(age), cap,
                    )
                    return False
                return True
        except Exception:  # noqa: BLE001 — nothing on the port / unparseable health
            return False

    async def _kill_pid(self, pid: int) -> None:
        """SIGTERM, then SIGKILL if it is still holding the port.

        A feeder wedged on a dead browser does NOT die on SIGTERM (measured
        2026-07-15: still LISTENing on :8093 12s after `kill`, gone 2s after
        `kill -9`), and a survivor blocks the replacement's bind.
        """
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        for _ in range(6):
            await asyncio.sleep(0.5)
            if self._port_holder_pid() != pid:
                return
        log.warning("ais sidecar %s pid %s ignored SIGTERM — SIGKILL", self.name, pid)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    async def start(self) -> None:
        if not self.index.exists():
            log.warning("ais sidecar %s index not found at %s — skipping", self.name, self.index)
            return
        if await self._already_healthy():
            self._reuse_pid = self._port_holder_pid()
            log.info(
                "ais sidecar %s already up on %s — reusing pid %s",
                self.name, self.base, self._reuse_pid,
            )
            return
        # Unhealthy but possibly still LISTENing (a wedged feeder we just refused
        # in _already_healthy). It would EADDRINUSE the replacement, so evict it
        # first — otherwise the frozen one outlives every restart.
        holder = self._port_holder_pid()
        if holder is not None:
            log.warning(
                "ais sidecar %s: evicting unhealthy pid %s holding %s",
                self.name, holder, self.base,
            )
            await self._kill_pid(holder)

        env = {
            **os.environ,
            "PORT": str(self.port),
            # Reuse the ADS-B feeder's playwright install (require('playwright')
            # resolves via NODE_PATH); no bundled Chromium — index.js honours
            # CHROME_PATH for the no-sandbox system Chrome.
            "NODE_PATH": os.environ.get("NODE_PATH", str(_NODE_MODULES)),
            "CHROME_PATH": os.environ.get("CHROME_PATH", "/usr/bin/google-chrome-stable"),
            **self.extra_env,
        }
        # Chrome's zygote fork dies (error_code=1002 → 0 vessels) if it inherits
        # run-api.sh's jemalloc LD_PRELOAD / MALLOC_CONF(background_thread:true).
        # Scrub both from the child env — same fix as adsb_sidecar.
        env.pop("LD_PRELOAD", None)
        env.pop("MALLOC_CONF", None)

        log_path = f"/tmp/ais-sidecar-{self.name}.log"
        try:
            log_file = open(log_path, "ab", buffering=0)  # noqa: SIM115,ASYNC230 — one-shot append of child log at startup
            log.info("ais sidecar %s stdout/stderr -> %s", self.name, log_path)
        except Exception:  # noqa: BLE001 — log file optional
            log_file = None  # type: ignore[assignment]

        try:
            self._proc = await asyncio.create_subprocess_exec(
                "node", str(self.index),
                cwd=str(self.dir),
                env=env,
                stdout=log_file,
                stderr=log_file,
                start_new_session=True,  # own process group so stop() kills the browser tree
            )
        except FileNotFoundError:
            log.warning("node not found on PATH — ais sidecar %s disabled", self.name)
            return

        # Confirm it didn't instantly die (bad node, missing playwright), then
        # return without waiting for the first scrape.
        await asyncio.sleep(1.0)
        if self._proc.returncode is not None:
            log.warning(
                "ais sidecar %s exited early (code %s) — see %s",
                self.name, self._proc.returncode, log_path,
            )
            self._proc = None
            return
        log.info(
            "ais sidecar %s spawned on %s (warming world grid in background)",
            self.name, self.base,
        )

    async def stop(self) -> None:
        """Terminate the sidecar (no-op if not ours / already gone).

        node runs in its own session (start_new_session), so os.killpg is a silent
        no-op against the setsid'd leader — kill by DIRECT pid. Killing node frees
        the port; its Chromium grandchildren exit when their CDP pipe closes.
        """
        proc, self._proc = self._proc, None
        reuse_pid, self._reuse_pid = self._reuse_pid, None

        pids = []
        if proc is not None and proc.returncode is None:
            pids.append(proc.pid)
        if reuse_pid:
            pids.append(reuse_pid)
        if not pids:
            return
        log.info("stopping ais sidecar %s pids=%s", self.name, pids)

        # _kill_pid escalates per pid. The escalation used to hang off
        # `if proc is not None`, so a REUSED sidecar (proc is None) only ever got
        # SIGTERM — and a wedged feeder ignores it, keeping the port and getting
        # re-adopted on the next boot. Every pid gets the same treatment now.
        await asyncio.gather(*(self._kill_pid(pid) for pid in pids))
        if proc is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.wait(), timeout=5.0)


_SIDECARS: list[_Sidecar] = [
    _Sidecar(
        "myshiptracking",
        "ais-myshiptracking-feeder",
        int(os.environ.get("AIS_MYSHIPTRACKING_SIDECAR_PORT", "8093")),
        lambda: get_settings().ais_myshiptracking_sidecar_enabled,
        extra_env={"READ_MS": os.environ.get("AIS_MYSHIPTRACKING_SIDECAR_READ_MS", "30000")},
        # Same cap the poller uses to refuse a stale union — a feeder whose union
        # the poller won't publish is not one worth adopting.
        max_age_s=lambda: get_settings().ais_myshiptracking_sidecar_max_age_s,
    ),
    _Sidecar(
        "marinetraffic",
        "ais-marinetraffic-feeder",
        int(os.environ.get("AIS_MARINETRAFFIC_SIDECAR_PORT", "8092")),
        lambda: get_settings().ais_marinetraffic_sidecar_enabled,
        extra_env={"READ_MS": os.environ.get("AIS_MARINETRAFFIC_SIDECAR_READ_MS", "60000")},
    ),
    _Sidecar(
        "vesselfinder",
        "ais-vesselfinder-feeder",
        int(os.environ.get("AIS_SIDECAR_PORT", "8091")),
        lambda: get_settings().ais_vesselfinder_sidecar_enabled,
        extra_env={"READ_MS": os.environ.get("AIS_SIDECAR_READ_MS", "30000")},
    ),
]


async def start() -> None:
    """Spawn each ENABLED feeder and return. Best-effort, idempotent."""
    for sc in _SIDECARS:
        if sc.is_enabled():
            await sc.start()


async def supervise(interval_s: float = 60.0) -> None:
    """Re-``start()`` any enabled feeder that has stopped serving. Runs forever.

    ``start()`` only ever ran once, at lifespan boot, so a feeder that died after
    boot stayed dead until the next backend restart — the poller just backed off
    against a closed port forever and the tier went silently empty. It has bitten
    twice: the ADS-B twin on :8090, and on 2026-07-15 the MyShipTracking feeder,
    when a restart's start() ADOPTED the outgoing backend's sidecar (still
    listening, health 200) moments before that backend's stop() killed it.

    _already_healthy is the whole test, so this also recovers a feeder that is up
    but wedged on a stale union — start() evicts the port holder and respawns.
    A warming feeder (age_s null) reads healthy and is left alone, so this never
    fights the first world sweep.
    """
    while True:
        await asyncio.sleep(interval_s)
        for sc in _SIDECARS:
            if not sc.is_enabled():
                continue
            try:
                if await sc._already_healthy():
                    continue
                log.warning("ais sidecar %s not serving on %s — restarting", sc.name, sc.base)
                await sc.start()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — supervision must never die
                log.warning("ais sidecar %s supervise error: %s", sc.name, e)


async def stop() -> None:
    """Terminate every tracked feeder; safe when none are running."""
    for sc in _SIDECARS:
        await sc.stop()
