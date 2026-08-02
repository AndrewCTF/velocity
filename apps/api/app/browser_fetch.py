"""Lifespan-managed generic real-Chrome fetch tier (``tools/browser-fetch``).

THREE different things look like "Cloudflare is blocking us" and only one of
them is. All measured 2026-08-01 from this host; do not re-derive them by
guessing:

  * A WAF PATH rule. ``globe.airplanes.live/data/aircraft.json`` answers 403 to
    httpx, to curl with a full Chrome header set, through WARP, AND to real
    Chrome that had just loaded the site. Nothing opens it. The map at ``/``
    loads fine and makes its own ``/re-api/?binCraft&zstd&box=…`` request, so
    you load the page and read what IT fetched — that is what ``capture`` is for.
  * NOT BLOCKED AT ALL, just undiscovered. That same ``/re-api/`` endpoint
    answers **bare httpx with no headers whatsoever** with 200. The browser's
    value there is DISCOVERY (it tells you the endpoint and parameter shape the
    page uses); once you know it, plain httpx is the right client. Check this
    before spending a browser on a host.
  * A REAL managed challenge. ``globe.adsb.fi`` answers 403 with a "Just a
    moment..." interstitial. httpx cannot pass it, and neither can HEADLESS
    Chrome — it sat on the challenge for 25 s and never cleared. HEADFUL Chrome
    on an Xvfb display got 200 and the real page from the same address seconds
    later. Headless is itself the signal; that is what ``browser_headful`` is
    for, and it is the only lever here that beat a genuine challenge.

Best-effort throughout: :func:`fetch` returns ``None`` when the tier is off or
unhealthy so every caller keeps its existing failure path. OFF by default; this
is a third Chromium tier (see ``app/profile.py`` on what the first two cost) and
it belongs to minute-cadence callers, never the 1 s snapshot loop.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import os
import shutil
import signal
from pathlib import Path

import httpx

log = logging.getLogger("browser_fetch")

_PARENTS = Path(__file__).resolve().parents
_REPO_ROOT = _PARENTS[3] if len(_PARENTS) > 3 else _PARENTS[-1]
_SIDECAR_DIR = _REPO_ROOT / "tools" / "browser-fetch"
_INDEX = _SIDECAR_DIR / "index.js"
# Reuse the ADS-B feeder's playwright install rather than a second copy of a
# ~400 MB dependency — the AIS feeders already resolve it this way.
_NODE_MODULES = _REPO_ROOT / "tools" / "adsb-globe-feeder" / "node_modules"

_proc: asyncio.subprocess.Process | None = None


def _port() -> int:
    from app.config import get_settings  # noqa: PLC0415

    return get_settings().browser_fetch_port


def _base() -> str:
    return f"http://127.0.0.1:{_port()}"


async def _serving() -> bool:
    """Is the sidecar answering? LIVENESS — the server binds before Chrome."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            return (await c.get(f"{_base()}/health")).status_code == 200
    except Exception:  # noqa: BLE001 — nothing on the port
        return False


async def start() -> None:
    """Spawn the node sidecar. Idempotent, best-effort, never raises."""
    global _proc

    from app.config import get_settings  # noqa: PLC0415

    settings = get_settings()
    if not settings.browser_fetch_enabled:
        return
    if await _serving():
        log.info("browser-fetch already serving on %s — reusing", _base())
        return
    if not _INDEX.exists():
        log.warning("browser-fetch sidecar missing at %s — tier disabled", _INDEX)
        return

    env = {
        **os.environ,
        "BROWSER_FETCH_PORT": str(_port()),
        "BROWSER_MAX_PAGES": str(settings.browser_max_pages),
        "BROWSER_IDLE_S": str(int(settings.browser_idle_s)),
        "NODE_PATH": os.environ.get("NODE_PATH", str(_NODE_MODULES)),
        "CHROME_PATH": os.environ.get("CHROME_PATH", "/usr/bin/google-chrome-stable"),
    }
    # Same egress as the httpx side or the clearance cookie is bound to an
    # address we are not using. See config.warp_sidecars.
    if settings.warp_enabled and settings.warp_sidecars:
        from app import warp  # noqa: PLC0415

        env["WARP_PROXY"] = warp.socks_url()
    # jemalloc must never reach the Chrome tree: LD_PRELOAD + MALLOC_CONF
    # together kill the zygote fork at spawn (bisected 2026-07-04, see
    # adsb_sidecar.start()).
    env.pop("LD_PRELOAD", None)
    env.pop("MALLOC_CONF", None)

    try:
        log_file = open("/tmp/browser-fetch.log", "ab", buffering=0)  # noqa: SIM115,ASYNC230 — one-shot child log at startup
    except Exception:  # noqa: BLE001 — log file optional
        log_file = None  # type: ignore[assignment]
    # Headful on a virtual display when asked. Headless Chrome is itself a
    # signal: measured 2026-08-01 on globe.adsb.fi, headless got a 403 "Just a
    # moment..." interstitial that never cleared, headful under Xvfb got 200 and
    # the real page from the same address seconds later. Falls back to headless
    # with a warning rather than failing to start.
    argv = ["node", str(_INDEX)]
    if settings.browser_headful:
        if shutil.which("xvfb-run"):
            env["BROWSER_HEADFUL"] = "1"
            argv = ["xvfb-run", "-a", "--server-args=-screen 0 1280x800x24", *argv]
        else:
            log.warning("browser_headful set but xvfb-run is missing — staying headless")

    try:
        _proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(_SIDECAR_DIR),
            env=env,
            stdout=log_file,
            stderr=log_file,
            start_new_session=True,  # own group, so stop() takes the browser tree
        )
    except FileNotFoundError:
        log.warning("node not found on PATH — browser-fetch disabled")
        return
    log.info("browser-fetch spawned (pid %s) on %s", _proc.pid, _base())


async def supervise(interval_s: float = 60.0) -> None:
    """Restart the sidecar if it stops serving. Cancel BEFORE stop()."""
    while True:
        await asyncio.sleep(interval_s)
        try:
            if not await _serving():
                log.warning("browser-fetch not serving — restarting")
                await start()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — supervision must never die
            log.warning("browser-fetch supervise error: %s", e)


async def stop() -> None:
    """Kill the sidecar's process group (no-op if not ours / already gone)."""
    global _proc

    if _proc is None:
        return
    proc, _proc = _proc, None
    with contextlib.suppress(Exception):
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(proc.wait(), timeout=8.0)
    with contextlib.suppress(Exception):
        if proc.returncode is None:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)


async def fetch(
    url: str,
    *,
    capture: str | None = None,
    wait_ms: int = 0,
    timeout_s: float = 90.0,
) -> httpx.Response | None:
    """Fetch `url` in a real browser, or None if the tier can't serve it.

    `capture` is a regex: when given, the browser navigates to `url` and returns
    the body of the first request THE PAGE made whose URL matches — the only way
    to read an endpoint behind a WAF path rule.

    Returns a real ``httpx.Response`` so callers can keep their status handling.
    """
    from app.config import get_settings  # noqa: PLC0415

    if not get_settings().browser_fetch_enabled:
        return None
    # Same SSRF boundary as every other fetcher here: the sidecar will fetch
    # whatever it is told, so the public-address check happens before we ask.
    from app.news.images import _is_public_url  # noqa: PLC0415

    if not await _is_public_url(url):
        log.warning("browser-fetch refused non-public url %s", url[:120])
        return None

    params: dict[str, str] = {"url": url}
    if capture:
        params["capture"] = capture
    if wait_ms:
        params["wait"] = str(wait_ms)
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as c:
            r = await c.get(f"{_base()}/fetch", params=params)
        payload = r.json()
    except Exception as e:  # noqa: BLE001 — tier down / bad payload
        log.warning("browser-fetch failed for %s: %s", url[:120], e)
        return None
    if r.status_code != 200 or "body_b64" not in payload:
        log.warning(
            "browser-fetch could not serve %s: %s", url[:120], str(payload)[:160]
        )
        return None
    return httpx.Response(
        status_code=int(payload.get("status", 200)),
        content=base64.b64decode(payload["body_b64"]),
        request=httpx.Request("GET", url),
    )


async def health() -> dict[str, object]:
    """/api/status payload. Cheap when the tier is off."""
    from app.config import get_settings  # noqa: PLC0415

    if not get_settings().browser_fetch_enabled:
        return {"enabled": False, "detail": "off"}
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(f"{_base()}/health")
            body = r.json() if r.status_code == 200 else {}
    except Exception as e:  # noqa: BLE001 — status must never raise
        return {"enabled": True, "serving": False, "error": type(e).__name__}
    return {"enabled": True, "serving": True, "port": _port(), **body}
