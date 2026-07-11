"""External actuation for the Workflows "control" blocks.

The control-category blocks (``control.webhook``, ``control.drone``,
``control.device``) and ``op.http`` reach OUT of the platform to an
operator-run endpoint — a REST API, a webhook receiver, or a drone / robot /
device control server. This module holds the plumbing they share so no block
opens a socket itself:

  * an IPv4-pinned ``httpx`` client (same reason as ``upstream.get_client`` —
    hosts with broken IPv6 egress otherwise hang on AAAA records);
  * the normalized JSON command **envelope** every control server receives;
  * the safety guards — dry-run on preview, a per-run dispatch budget, an
    optional host allowlist, an env-sourced bearer token, an env kill-switch;
  * ``send`` — the single network call the tests monkeypatch.

Safety posture (mirrors ``op.python``'s BYO-compute note): this is a
single-operator local tool, not a hostile-tenant sandbox. The guards exist to
stop a *preview* from launching a drone and to stop a runaway ``per_row`` loop
from firing hundreds of commands — not to sandbox a malicious spec author. A
real drone uplink is the operator pointing a block at THEIR OWN control server.

Wire contract (what your control server must accept) is documented in
``docs/workflows-control-blocks.md``; every envelope is a single JSON object
POSTed with ``content-type: application/json``.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.workflows.store import WorkflowError

Row = dict[str, Any]

# Safe (read-only) HTTP methods — allowed to actually execute during a PREVIEW.
# Anything else (POST/PUT/PATCH/DELETE) is dry-run on preview so authoring a
# workflow can never mutate an external system or move a vehicle.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

_CLIENT: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    """Lazily-built shared async client, IPv4-pinned like ``upstream``.

    A dedicated client (not ``upstream.get_client``) so control traffic carries
    its own User-Agent and never contends with the feed-poller connection pool.
    """
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = httpx.AsyncClient(
            headers={"User-Agent": "osint-console-workflows/0.1"},
            transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=0),
            follow_redirects=True,
        )
    return _CLIENT


# ── env-driven policy ────────────────────────────────────────────────────────


def control_enabled() -> bool:
    """Master kill-switch. Default ON. Set ``WORKFLOWS_CONTROL_ENABLED=0`` to
    force every control block into dry-run (envelopes are still built and
    returned, no network call is made) — a safe way to author/rehearse a
    control workflow on a box that must never actuate."""
    return os.getenv("WORKFLOWS_CONTROL_ENABLED", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def _allow_hosts() -> set[str] | None:
    """Optional outbound allowlist. ``WORKFLOWS_HTTP_ALLOW_HOSTS`` =
    comma-separated hostnames. Unset → any host allowed (BYO posture). Set →
    only those hosts (exact, case-insensitive) may be reached; everything else
    raises 403. Localhost is NEVER implicitly blocked — the operator's control
    server is often on the same box."""
    raw = os.getenv("WORKFLOWS_HTTP_ALLOW_HOSTS", "").strip()
    if not raw:
        return None
    return {h.strip().lower() for h in raw.split(",") if h.strip()}


def check_url(url: str) -> None:
    """Validate scheme (http/https only) and enforce the optional host
    allowlist. Raises ``WorkflowError`` naming the problem; never returns a
    value. Called on every request path, dry-run included, so a misconfigured
    URL surfaces in preview instead of at first live fire."""
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https"):
        raise WorkflowError(422, f"url must be http(s), got {parts.scheme or 'no'} scheme: {url!r}")
    if not parts.hostname:
        raise WorkflowError(422, f"url has no host: {url!r}")
    allow = _allow_hosts()
    if allow is not None and parts.hostname.lower() not in allow:
        raise WorkflowError(
            403,
            f"host {parts.hostname!r} is not in WORKFLOWS_HTTP_ALLOW_HOSTS "
            f"({', '.join(sorted(allow))})",
        )


def auth_headers(auth_env: str) -> dict[str, str]:
    """Read a bearer token from the named env var → ``Authorization`` header.
    The token is NEVER stored in the workflow spec — only the env var's NAME
    is. Empty / unset name → no header (public endpoint)."""
    name = (auth_env or "").strip()
    if not name:
        return {}
    token = os.getenv(name, "").strip()
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


# ── the one network call (monkeypatched in tests) ────────────────────────────


@dataclass
class HttpResult:
    status: int | None
    ok: bool
    json: Any
    text: str
    error: str | None

    def summary(self) -> dict[str, Any]:
        """Compact result for annotating a row / returning from a block."""
        d: dict[str, Any] = {"status": self.status, "ok": self.ok}
        if self.error is not None:
            d["error"] = self.error
        elif self.json is not None:
            d["response"] = self.json
        elif self.text:
            d["response"] = self.text[:2000]
        return d


async def send(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    json_body: Any = None,
    timeout_s: float = 15.0,
) -> HttpResult:
    """Perform ONE request and normalize the outcome. Never raises — a
    transport/timeout error becomes ``HttpResult(error=...)`` so a single bad
    endpoint fails just its row, not the whole run. This is the seam tests
    replace to assert envelopes without real network."""
    try:
        resp = await _client().request(
            method.upper(),
            url,
            headers=headers,
            json=json_body if json_body is not None else None,
            timeout=timeout_s,
        )
    except httpx.HTTPError as exc:
        return HttpResult(status=None, ok=False, json=None, text="", error=str(exc))
    parsed: Any = None
    ctype = resp.headers.get("content-type", "")
    if "json" in ctype.lower():
        try:
            parsed = resp.json()
        except (ValueError, httpx.DecodingError):
            parsed = None
    return HttpResult(
        status=resp.status_code,
        ok=resp.is_success,
        json=parsed,
        text=resp.text,
        error=None,
    )


# ── guarded entry points used by the blocks ──────────────────────────────────


async def request(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    json_body: Any,
    budget: list[int],
    preview: bool,
    timeout_s: float,
) -> dict[str, Any]:
    """``op.http`` path. Validates the URL, dry-runs UNSAFE methods on preview
    (a GET preview still executes — it is read-only), spends one unit of the
    shared per-run budget, then sends. Returns a normalized dict the block
    parses into rows."""
    method = method.upper()
    check_url(url)
    if (preview and method not in SAFE_METHODS) or (
        method not in SAFE_METHODS and not control_enabled()
    ):
        return {
            "dry_run": True,
            "reason": "preview" if preview else "control-disabled",
            "method": method,
            "url": url,
            "request": json_body,
        }
    if budget[0] <= 0:
        return {
            "dry_run": True,
            "reason": "dispatch budget exhausted",
            "method": method,
            "url": url,
        }
    budget[0] -= 1
    res = await send(method, url, headers=headers, json_body=json_body, timeout_s=timeout_s)
    return {
        "dry_run": False,
        "status": res.status,
        "ok": res.ok,
        "json": res.json,
        "text": res.text,
        "error": res.error,
    }


async def dispatch(
    url: str,
    envelope: dict[str, Any],
    *,
    budget: list[int],
    preview: bool,
    auth_env: str = "",
    timeout_s: float = 10.0,
) -> dict[str, Any]:
    """Command path for the actuator blocks. ALWAYS a POST of ``envelope``.
    Dry-run on preview OR when the kill-switch is off — the envelope is still
    returned so the editor shows exactly what WOULD be sent. Spends one unit of
    the shared per-run budget."""
    check_url(url)
    if preview or not control_enabled():
        return {
            "dispatched": False,
            "dry_run": True,
            "reason": "preview" if preview else "control-disabled",
            "request": envelope,
        }
    if budget[0] <= 0:
        return {
            "dispatched": False,
            "dry_run": True,
            "reason": "dispatch budget exhausted",
            "request": envelope,
        }
    budget[0] -= 1
    headers = {"content-type": "application/json", **auth_headers(auth_env)}
    res = await send("POST", url, headers=headers, json_body=envelope, timeout_s=timeout_s)
    out: dict[str, Any] = {"dispatched": res.error is None, "dry_run": False, "request": envelope}
    out.update(res.summary())
    return out


# ── envelope builders ────────────────────────────────────────────────────────

DRONE_COMMANDS = ("goto", "takeoff", "land", "rtl", "orbit", "arm", "disarm", "follow", "pause")


def drone_envelope(
    command: str,
    *,
    vehicle: str,
    lat: float | None,
    lon: float | None,
    alt_m: float | None,
    speed_ms: float | None,
    radius_m: float | None,
    source: str,
) -> dict[str, Any]:
    """Normalized drone/UAV command. Only the fields relevant to ``command``
    carry meaning (``goto``/``orbit``/``follow`` use lat/lon; ``takeoff`` uses
    alt; ``rtl``/``land``/``arm``/``disarm``/``pause`` need only ``vehicle``),
    but the shape is stable so a control server can switch on ``command``."""
    params: dict[str, Any] = {}
    if speed_ms is not None:
        params["speed_ms"] = speed_ms
    if radius_m is not None:
        params["radius_m"] = radius_m
    env: dict[str, Any] = {
        "type": "drone.command",
        "command": command,
        "vehicle": vehicle,
        "ts": time.time(),
        "source": source,
    }
    if lat is not None and lon is not None:
        env["waypoint"] = {"lat": lat, "lon": lon}
        if alt_m is not None:
            env["waypoint"]["alt_m"] = alt_m
    elif alt_m is not None:
        env["alt_m"] = alt_m
    if params:
        env["params"] = params
    return env


def device_envelope(
    *,
    device: str,
    command: str,
    payload: dict[str, Any],
    source: str,
) -> dict[str, Any]:
    """Generic controllable-item command — any actuator behind the operator's
    control server (camera PTZ, relay, gimbal, rover, siren…)."""
    return {
        "type": "device.command",
        "device": device,
        "command": command,
        "payload": payload,
        "ts": time.time(),
        "source": source,
    }
