"""Lifespan-managed Cloudflare WARP egress (keyless, no login).

`warp-cli mode proxy` makes the WARP daemon publish a SOCKS5 proxy on
127.0.0.1:{WARP_PROXY_PORT} whose exit is a Cloudflare consumer address. Only
traffic sent to that port is tunnelled — the host's routing and DNS are
untouched, no root is needed, and the consumer free tier registers anonymously
(no account, no key). `app.upstream` mounts it per host; see `warp_hosts`.

WHAT IT FIXES, AND WHAT IT DOES NOT (measured 2026-08-01, tools/probe_warp.py):
  * Fixes: datacenter-ASN reputation and per-IP budgets — the class of block
    documented in `upstream_proxy.py` (adsb.lol 451, per-IP rate limits).
  * Does NOT fix a WAF PATH rule. globe.airplanes.live/data/aircraft.json,
    globe.adsb.fi/... and globe.adsbexchange.com/... answer 403 to every egress
    AND to real Chrome — measured. No proxy opens those; the map page's own
    endpoint does, which is what the :8090 sidecar already reads.
  * Does NOT fix TLS/HTTP2 fingerprinting. httpx does not look like a browser
    from any address.
  * Won nothing from THIS host's residential egress and lost OpenSky
    ("Host unreachable" through the tunnel), so `warp_hosts` ships EMPTY.
    Re-run the probe from the datacenter deployment before wiring a host.

Lifecycle mirrors `adsb_sidecar`: `ensure()` is idempotent and best-effort (a
missing warp-cli logs the install command and the backend serves as before),
`supervise()` reconnects a tunnel that drops, `stop()` disconnects ONLY a tunnel
we brought up ourselves. Never raises into lifespan.

Two health questions, deliberately not the same predicate:
  * `_serving()`   — is the SOCKS port bound? LIVENESS. Drives supervision.
  * `_tunnelled()` — does a request through it actually exit via WARP? WARM.
    Reported in /api/status, never used to trigger a reconnect: a tunnel that is
    up but whose probe host is briefly unreachable must not cause a flap.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import subprocess

import httpx

log = logging.getLogger("warp")

_CLI = "warp-cli"
# `connect` returns before the daemon has validated the SOCKS config and bound
# the port; measured ~2-4 s on this box.
_UP_TIMEOUT_S = 30.0
_CLI_TIMEOUT_S = 20.0
_SUPERVISE_INTERVAL_S = 30.0

# True only when ensure() moved the daemon from disconnected to connected. An
# operator who had WARP up before the backend started keeps it after shutdown.
_we_connected = False
_last_error: str | None = None


def _port() -> int:
    from app.config import get_settings  # noqa: PLC0415 — avoids an import cycle

    return get_settings().warp_proxy_port


def socks_url() -> str:
    """The proxy URL httpx mounts. socks5:// already resolves at the exit."""
    return f"socks5://127.0.0.1:{_port()}"


def installed() -> bool:
    return shutil.which(_CLI) is not None


def hosts() -> list[str]:
    """Hosts routed through WARP. Empty (the default) means the tier is inert."""
    from app.config import get_settings  # noqa: PLC0415

    raw = get_settings().warp_hosts
    return [h.strip().lower() for h in raw.split(",") if h.strip()]


async def _cli_call(*args: str) -> tuple[int, str]:
    """One warp-cli call, off the event loop.

    warp-cli talks to the daemon over a socket and can block for seconds. The
    1 s snapshot cycle runs on this loop, so every call goes through a thread
    AND carries its own timeout.
    """

    def run() -> tuple[int, str]:
        try:
            p = subprocess.run(  # noqa: S603 — fixed argv, no shell
                [_CLI, "--accept-tos", *args],
                capture_output=True,
                text=True,
                timeout=_CLI_TIMEOUT_S,
            )
            return p.returncode, (p.stdout + p.stderr).strip()
        except Exception as exc:  # noqa: BLE001 — missing binary / timeout
            return 1, f"{type(exc).__name__}: {exc}"

    return await asyncio.to_thread(run)


async def _serving() -> bool:
    """Is the SOCKS port bound? LIVENESS — says nothing about the exit."""
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", _port()), timeout=2.0
        )
    except Exception:  # noqa: BLE001 — nothing on the port
        return False
    writer.close()
    with contextlib.suppress(Exception):
        await writer.wait_closed()
    return True


async def _tunnelled(timeout_s: float = 8.0) -> tuple[bool, str]:
    """Does traffic through the proxy actually exit via WARP? WARM.

    Cloudflare's own trace endpoint reports `warp=on` plus the exit address, so
    one request answers both "is the tunnel real" and "which address are we".
    """
    transport = httpx.AsyncHTTPTransport(proxy=httpx.Proxy(socks_url()))
    try:
        async with httpx.AsyncClient(transport=transport, timeout=timeout_s) as c:
            body = (await c.get("https://1.1.1.1/cdn-cgi/trace")).text
    except Exception as exc:  # noqa: BLE001 — a dead tunnel is a result
        return False, f"{type(exc).__name__}"
    fields = dict(
        line.split("=", 1) for line in body.splitlines() if "=" in line
    )
    return fields.get("warp", "off") != "off", fields.get("ip", "?")


async def ensure() -> bool:
    """Bring the tunnel up. Idempotent, best-effort, never raises."""
    global _we_connected, _last_error

    if not installed():
        _last_error = "warp-cli not installed"
        log.warning("WARP enabled but warp-cli is missing — run: sudo scripts/warp.sh install")
        return False
    if await _serving():
        log.info("WARP already serving on %s", socks_url())
        return True

    # Consumer free tier: an anonymous device registration, no account or key.
    # Only mint one when there isn't one already — re-registering churns the
    # identity and drops any reputation the exit has built.
    rc, _ = await _cli_call("registration", "show")
    if rc != 0:
        rc, out = await _cli_call("registration", "new")
        if rc != 0:
            _last_error = f"registration failed: {out[:120]}"
            log.warning("WARP %s", _last_error)
            return False
        log.info("WARP registered (free tier, anonymous)")

    for args in (("mode", "proxy"), ("proxy", "port", str(_port())), ("connect",)):
        rc, out = await _cli_call(*args)
        if rc != 0:
            _last_error = f"{' '.join(args)} failed: {out[:120]}"
            log.warning("WARP %s", _last_error)
            return False

    deadline = asyncio.get_running_loop().time() + _UP_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        if await _serving():
            _we_connected = True
            _last_error = None
            log.info("WARP connected — SOCKS5 on %s", socks_url())
            return True
        await asyncio.sleep(1.0)

    _last_error = f"port {_port()} never bound"
    log.warning("WARP %s", _last_error)
    return False


async def supervise() -> None:
    """Reconnect a tunnel that drops. Cancel BEFORE stop() or it races teardown.

    Triggers on LIVENESS only. `_tunnelled()` would flap the daemon whenever the
    probe host is briefly unreachable, and reconnecting churns the exit address.
    """
    while True:
        await asyncio.sleep(_SUPERVISE_INTERVAL_S)
        try:
            if not await _serving():
                log.warning("WARP SOCKS port went away — reconnecting")
                await ensure()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — supervision must outlive any error
            log.exception("WARP supervise cycle failed")


async def stop() -> None:
    """Disconnect only if WE connected. Best-effort."""
    global _we_connected

    if not _we_connected:
        return
    _we_connected = False
    with contextlib.suppress(Exception):
        await _cli_call("disconnect")
        log.info("WARP disconnected")


async def health() -> dict[str, object]:
    """/api/status payload. Cheap when the tier is off."""
    from app.config import get_settings  # noqa: PLC0415

    s = get_settings()
    if not s.warp_enabled:
        return {"enabled": False, "detail": "off"}
    serving = await _serving()
    ok, exit_ip = await _tunnelled() if serving else (False, "?")
    return {
        "enabled": True,
        "installed": installed(),
        "serving": serving,
        "tunnelled": ok,
        "exit_ip": exit_ip,
        "port": _port(),
        "hosts": hosts() or (["*"] if s.warp_all else []),
        "kill_switch": s.warp_kill_switch,
        "error": _last_error,
    }
