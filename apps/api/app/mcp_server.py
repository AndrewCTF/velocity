"""OSINT GEOINT — Model Context Protocol server.

Exposes the live OSINT console as tools an AI agent can call. Every tool is a
thin async wrapper over the ``/api/intel/*`` HTTP surface (``app.routes.intel``)
so the agent shares the SAME warm in-process snapshot, AOI priority loader, and
fusion engine the globe uses — no second upstream fan-out, no rate-limit blowup.

Design principles (the MCP brief):
- **Context-safe.** Tools return distilled JSON (counts, grids, ≤50-item
  samples), never raw feature dumps. An agent can sweep the whole planet for a
  few hundred tokens.
- **Area-primary.** ``focus_area`` marks a region PRIMARY: a dedicated fresh
  fetch + ongoing priority refresh, independent of global rate limits. Other
  regions keep streaming from the global snapshot.
- **Think deeper, off-context.** ``deep_analyze`` pulls the relevant intel JSON
  and hands it to a real reasoning model — DeepSeek (``deepseek-reasoner``) when
  configured, else a local Ollama model — so heavy analysis happens off the
  agent's context and only the conclusion returns.

Run:
    python -m app.mcp_server                # stdio (Claude Code / Desktop / SDK)
    python -m app.mcp_server --http --port 8765   # streamable-HTTP
    python -m app.mcp_server --list-tools   # introspect, for CI / verification

Config (env or apps/api/.env): API_BASE, API_KEY, DEEPSEEK_API_KEY (or the
opencode DeepSeek key), OLLAMA_HOST, OLLAMA_MODEL.
"""

from __future__ import annotations

import argparse
import asyncio
import atexit
import os
import subprocess
import sys
import time
from typing import Any
from urllib.parse import quote, urlparse

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from starlette.routing import Route

from app.config import get_settings

mcp = FastMCP(
    "osint-geoint",
    instructions=(
        "Live geospatial intelligence over open ADS-B (aircraft), AIS (vessels), "
        "GPS-jamming (ADS-B NACp/NIC), Sentinel-1 SAR dark vessels, geocoded "
        "events, and a cross-domain fusion engine. Workflow: get_situation() to "
        "orient -> intel_brief() for ranked, cited cross-domain INCIDENTS (the "
        "fused picture, global or scoped) -> focus_area(lat,lon,radius_nm) to "
        "load an incident's region PRIMARY -> query_vessels / gps_jamming / "
        "query_aircraft to drill into its evidence -> deep_analyze() to have a "
        "reasoning model judge it. intel_brief is the headline tool: it chains "
        "signals into incidents so you don't correlate raw layers by hand."
    ),
)


# ── hosted mount (streamable-HTTP at /mcp of the FastAPI app) ──────────────────
# The agent-facing endpoint. Mounting the MCP into the SAME uvicorn process the
# globe runs lets every tool share the warm in-process snapshot + fusion engine
# (the tools still self-call /api/intel/* over localhost, authenticated by the
# static API_KEY). The Velocity gateway Worker proxies https://<host>/mcp here,
# forwarding the caller's Supabase token; the backend's ApiKeyMiddleware gates it
# like any other non-public route, so no MCP-specific auth is needed.


class _MCPASGIApp:
    """Raw-ASGI adapter for the streamable-HTTP session manager.

    A plain function endpoint would be wrapped by Starlette as a
    request/response handler; a class instance is left as a raw ASGI app, which
    is what the transport needs (it negotiates SSE itself).
    """

    def __init__(self, manager: StreamableHTTPSessionManager) -> None:
        self._manager = manager

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        await self._manager.handle_request(scope, receive, send)


def build_mcp_mount() -> tuple[list[Route], StreamableHTTPSessionManager]:
    """Return (routes, session_manager) to serve this server at ``/mcp``.

    A FRESH manager per call — ``StreamableHTTPSessionManager.run()`` is one-shot
    (it raises if entered twice), so every FastAPI app instance, including each
    test app, needs its own. Usage::

        routes, mgr = build_mcp_mount()
        app.router.routes.extend(routes)         # in the app factory
        async with mgr.run():  ...  yield         # in the app lifespan

    Served as exact ``Route``s (``/mcp`` and ``/mcp/``), NOT a ``Mount`` — a
    mount 307-redirects ``/mcp`` → ``/mcp/`` with a Location built from the
    request host, which through the gateway Worker would point a client at the
    bare backend origin. DNS-rebinding protection is disabled: the endpoint is
    reached server-to-server through the Worker (the Host header is the
    deployment origin, not a browser tab), and the Supabase-token check in
    ``app.auth.ApiKeyMiddleware`` is the real gate.
    """
    manager = StreamableHTTPSessionManager(
        app=mcp._mcp_server,
        json_response=False,
        stateless=False,
        security_settings=TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        ),
    )
    endpoint = _MCPASGIApp(manager)
    routes = [Route("/mcp", endpoint), Route("/mcp/", endpoint)]
    return routes, manager


# ── backend HTTP plumbing ─────────────────────────────────────────────────────


def _api_base() -> str:
    return (os.environ.get("API_BASE") or get_settings().api_base).rstrip("/")


# Cache one minted internal token per secret until ~60 s before it expires, so a
# burst of tool calls re-signs at most once a minute instead of per request.
_INTERNAL_JWT_TTL_S = 600  # 10 min token lifetime
_minted_jwt: tuple[str, float] | None = None  # (token, wall-clock expiry)


def _mint_internal_jwt(secret: str) -> str | None:
    """Mint a short-lived HS256 token the backend's ``app.auth`` accepts.

    In prod the gate is Supabase-JWT-only (no static ``API_KEY``); a server-to-
    server hop carries no browser session, so we sign our own. ``_verify_hs256``
    requires an HS256 signature over the JWT secret, ``role=="authenticated"``,
    and an unexpired ``exp`` — we also set the standard Supabase ``aud``/``sub``/
    ``iat`` so the token is well-formed. Cached until ~60 s before ``exp``.
    """
    global _minted_jwt
    now = time.time()
    if _minted_jwt is not None:
        token, expiry = _minted_jwt
        if expiry - 60 > now:
            return token
    try:
        import jwt  # noqa: PLC0415 — pyjwt, the lib app.auth's HS256 check mirrors
    except Exception:  # noqa: BLE001 — pyjwt missing → no Authorization header
        return None
    exp = int(now) + _INTERNAL_JWT_TTL_S
    claims = {
        "role": "authenticated",  # the claim app.auth._verify_hs256 demands
        "aud": "authenticated",
        "sub": "osint-mcp-internal",
        "iat": int(now),
        "exp": exp,
    }
    try:
        token = jwt.encode(claims, secret, algorithm="HS256")
    except Exception:  # noqa: BLE001 — encode failure → degrade to no auth header
        return None
    _minted_jwt = (token, float(exp))
    return token


def _headers() -> dict[str, str]:
    s = get_settings()
    key = os.environ.get("API_KEY") or s.api_key
    if key:
        return {"X-API-Key": key}
    # No static key (prod): if a Supabase JWT secret is configured, mint an
    # internal token so the self-hop to /api/intel/* authenticates. Otherwise
    # (fully open local box) send nothing, as before.
    secret = s.supabase_jwt_secret
    if secret:
        token = _mint_internal_jwt(secret)
        if token:
            return {"Authorization": f"Bearer {token}"}
    return {}


# ── backend auto-start ────────────────────────────────────────────────────────
# The MCP server is a thin client over the OSINT backend. If that backend is
# not running, every tool errors and a driving agent can spin in a retry loop.
# So on the first tool call we make sure a backend exists: reuse one already
# listening, else spawn uvicorn ourselves (localhost only) and wait — bounded —
# for it to come up. Set OSINT_MCP_NO_AUTOSTART=1 to disable.

_BACKEND_LOCK = asyncio.Lock()
_BACKEND_READY = False
_BACKEND_PROC: subprocess.Popen[bytes] | None = None
_AUTOSTART_WAIT_S = 60


def _is_localhost(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}


def _api_port() -> int:
    return urlparse(_api_base()).port or 8000


def _apps_api_dir() -> str:
    import app  # noqa: PLC0415

    return os.path.dirname(os.path.dirname(os.path.abspath(app.__file__)))


async def _backend_healthy(timeout_s: float = 2.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as c:
            r = await c.get(_api_base() + "/api/intel/sources", headers=_headers())
        return r.status_code == 200
    except Exception:
        return False


def _spawn_uvicorn(cmd: list[str]) -> subprocess.Popen[bytes]:
    """Sync spawn (Popen returns immediately; isolated from the async path)."""
    return subprocess.Popen(
        cmd,
        cwd=_apps_api_dir(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=dict(os.environ),
    )


def _terminate_backend() -> None:
    proc = _BACKEND_PROC
    if proc is not None and proc.poll() is None:
        proc.terminate()


async def _prewarm() -> None:
    """Kick the global ADS-B snapshot so the first get_situation isn't slow."""
    try:
        async with httpx.AsyncClient(timeout=120.0) as c:
            await c.get(_api_base() + "/api/adsb/global", headers=_headers())
    except Exception:
        pass


async def _ensure_backend() -> None:
    """Idempotent: guarantee a reachable backend before a tool runs."""
    global _BACKEND_READY, _BACKEND_PROC
    if _BACKEND_READY:
        return
    async with _BACKEND_LOCK:
        if _BACKEND_READY:
            return
        if await _backend_healthy():
            _BACKEND_READY = True
            return
        # Only auto-start a LOCAL backend, and only if not opted out.
        if os.environ.get("OSINT_MCP_NO_AUTOSTART") or not _is_localhost(_api_base()):
            return
        # Spawn at most ONCE per process. If a prior attempt didn't come up,
        # don't re-spawn (avoids stacking uvicorns / re-waiting every call) —
        # just let later calls re-check health in case it's still warming.
        if _BACKEND_PROC is not None:
            return
        cmd = [
            sys.executable, "-m", "uvicorn", "app.main:app",
            "--host", "127.0.0.1", "--port", str(_api_port()), "--log-level", "warning",
        ]
        try:
            _BACKEND_PROC = _spawn_uvicorn(cmd)
        except Exception:
            return  # can't spawn (e.g. uvicorn missing) — tools report cleanly
        atexit.register(_terminate_backend)
        for _ in range(_AUTOSTART_WAIT_S):
            await asyncio.sleep(1.0)
            if await _backend_healthy():
                _BACKEND_READY = True
                asyncio.create_task(_prewarm())  # warm snapshot off the hot path
                return
        # Did not come up in time; leave _BACKEND_READY False so the next tool
        # call retries once more rather than looping on a dead spawn.


async def _get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """GET an intel endpoint. Returns parsed JSON or a structured error dict —
    never raises, so a tool call always yields something the agent can read."""
    await _ensure_backend()
    url = _api_base() + path
    clean = {k: v for k, v in (params or {}).items() if v is not None}
    # Generous ceiling: the backend's FIRST global call cold-starts the ADS-B
    # snapshot (firehose fetch + backoff) and can take up to ~75s. After that
    # every call is instant. A short timeout here would mis-report a healthy
    # backend as unreachable on the agent's very first query.
    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            r = await client.get(url, params=clean, headers=_headers())
    except Exception as exc:  # noqa: BLE001 — surface, don't crash the tool
        return {
            "error": "backend_unreachable",
            "detail": str(exc),
            "url": url,
            "hint": "Backend auto-start did not come up in time. It may still be "
            "warming — retry once. Or start it manually: uv run --project "
            f"{_apps_api_dir()} uvicorn app.main:app --port {_api_port()}",
        }
    if r.status_code != 200:
        return {"error": f"backend_{r.status_code}", "detail": r.text[:400], "url": url}
    try:
        data: Any = r.json()
    except ValueError:
        return {"error": "bad_json", "detail": r.text[:400], "url": url}
    return data if isinstance(data, dict) else {"result": data}


# ── tools ─────────────────────────────────────────────────────────────────────


@mcp.tool()
async def get_situation() -> dict[str, Any]:
    """Global situational snapshot — the cheap first call to orient.

    Returns total aircraft (airborne/ground, by category), GNSS-degraded count,
    active emergency squawks, the worst GPS-jamming cells worldwide, tracked
    vessel counts by category, and recent fusion-alert counts. A few hundred
    tokens describing the whole planet."""
    return await _get("/api/intel/situation")


@mcp.tool()
async def focus_area(
    lat: float,
    lon: float,
    radius_nm: float = 200.0,
    label: str | None = None,
    cell_deg: float = 1.0,
) -> dict[str, Any]:
    """Load a region PRIMARY and return a full intel bundle for it in one call.

    This is the headline tool. It triggers a DEDICATED, always-fresh fetch for
    just this area (bypassing global rate limits) and registers it for ongoing
    priority refresh. The bundle contains: fresh aircraft summary + sample,
    aircraft-density grid, GPS-jamming assessment, vessels, and fused anomalies
    (emergencies, jamming hotspots, dark vessels, alerts) with a threat level.

    Args:
        lat, lon: centre of the area of interest.
        radius_nm: radius in nautical miles (1–250; default 200).
        label: optional human name for the AOI (e.g. "Kaliningrad").
        cell_deg: density grid cell size in degrees (0.1–10; default 1.0).
    """
    return await _get(
        "/api/intel/area",
        {
            "lat": lat,
            "lon": lon,
            "radius_nm": radius_nm,
            "label": label,
            "primary": True,
            "cell_deg": cell_deg,
        },
    )


@mcp.tool()
async def aircraft_density(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 200.0,
    min_lon: float | None = None,
    min_lat: float | None = None,
    max_lon: float | None = None,
    max_lat: float | None = None,
    cell_deg: float = 1.0,
) -> dict[str, Any]:
    """Aircraft density over an area as a grid of cells (count, by category,
    GNSS-degraded per cell) plus totals, peak cell, and in-area vessel count.

    Give either a centre (lat, lon [, radius_nm]) or an explicit bbox
    (min_lon, min_lat, max_lon, max_lat). cell_deg sets grid resolution."""
    return await _get(
        "/api/intel/density",
        {
            "lat": lat, "lon": lon, "radius_nm": radius_nm,
            "min_lon": min_lon, "min_lat": min_lat,
            "max_lon": max_lon, "max_lat": max_lat, "cell_deg": cell_deg,
        },
    )


@mcp.tool()
async def gps_jamming(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 500.0,
    min_lon: float | None = None,
    min_lat: float | None = None,
    max_lon: float | None = None,
    max_lat: float | None = None,
) -> dict[str, Any]:
    """GPS/GNSS jamming assessment (GPSJam method: ADS-B NACp<8 / NIC<7 binned
    into 1° cells). Returns flagged cells ranked by severity, counts of
    high/medium cells, and a sample of affected aircraft. Omit all coordinates
    for a global view; otherwise pass a centre or a bbox to scope it."""
    return await _get(
        "/api/intel/jamming",
        {
            "lat": lat, "lon": lon, "radius_nm": radius_nm,
            "min_lon": min_lon, "min_lat": min_lat,
            "max_lon": max_lon, "max_lat": max_lat,
        },
    )


@mcp.tool()
async def query_aircraft(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 200.0,
    min_lon: float | None = None,
    min_lat: float | None = None,
    max_lon: float | None = None,
    max_lat: float | None = None,
    category: str | None = None,
    squawk: str | None = None,
    callsign_contains: str | None = None,
    min_alt_m: float | None = None,
    max_alt_m: float | None = None,
    emergency: bool | None = None,
    gnss_degraded: bool | None = None,
    on_ground: bool | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """Filtered aircraft query against the live snapshot. Returns matched_total
    + a capped list of compact records.

    category ∈ airliner|private|helicopter|glider|military|emergency.
    Combine with area (centre or bbox), squawk, callsign_contains, altitude
    band (metres), emergency / gnss_degraded / on_ground booleans. limit ≤200."""
    return await _get(
        "/api/intel/aircraft",
        {
            "lat": lat, "lon": lon, "radius_nm": radius_nm,
            "min_lon": min_lon, "min_lat": min_lat,
            "max_lon": max_lon, "max_lat": max_lat,
            "category": category, "squawk": squawk,
            "callsign_contains": callsign_contains,
            "min_alt_m": min_alt_m, "max_alt_m": max_alt_m,
            "emergency": emergency, "gnss_degraded": gnss_degraded,
            "on_ground": on_ground, "limit": limit,
        },
    )


@mcp.tool()
async def lookup_aircraft(ident: str) -> dict[str, Any]:
    """Look up one aircraft by ICAO24 hex (exact) or callsign (substring).
    Returns its current state, registration, an integrity/threat assessment,
    and the latest server-held fix."""
    # quote(): ident is agent-supplied free text going into a URL path —
    # escape it so "x/../y" style values cannot re-route the request.
    return await _get(f"/api/intel/aircraft/{quote(ident, safe='')}")


@mcp.tool()
async def query_vessels(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 500.0,
    min_lon: float | None = None,
    min_lat: float | None = None,
    max_lon: float | None = None,
    max_lat: float | None = None,
    dark_only: bool = False,
    limit: int = 50,
) -> dict[str, Any]:
    """Vessels (AIS) in an area, classified (cargo/tanker/fishing/passenger/
    military/sailing/pleasure/tug). dark_only=True returns only dark-vessel
    candidates (moving with no static identity). Scoped by centre or bbox."""
    return await _get(
        "/api/intel/vessels",
        {
            "lat": lat, "lon": lon, "radius_nm": radius_nm,
            "min_lon": min_lon, "min_lat": min_lat,
            "max_lon": max_lon, "max_lat": max_lat,
            "dark_only": dark_only, "limit": limit,
        },
    )


@mcp.tool()
async def anomalies(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 500.0,
    min_lon: float | None = None,
    min_lat: float | None = None,
    max_lon: float | None = None,
    max_lat: float | None = None,
) -> dict[str, Any]:
    """Fused anomaly report for an area (or global if no coords): emergency
    aircraft, GPS-jamming hotspots, dark-vessel candidates, recent fusion
    alerts, plus a triage threat_level (low|elevated|high) and score."""
    return await _get(
        "/api/intel/anomalies",
        {
            "lat": lat, "lon": lon, "radius_nm": radius_nm,
            "min_lon": min_lon, "min_lat": min_lat,
            "max_lon": max_lon, "max_lat": max_lat,
        },
    )


@mcp.tool()
async def intel_brief(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 500.0,
    min_lon: float | None = None,
    min_lat: float | None = None,
    max_lon: float | None = None,
    max_lat: float | None = None,
    link_km: float = 50.0,
    window_hours: float = 6.0,
) -> dict[str, Any]:
    """Cross-domain INCIDENT brief — the headline analytic tool.

    Fuses the raw layers into ranked, cited INCIDENTS instead of returning
    signals you have to correlate yourself. An incident is a CONVERGENCE: signals
    within ``link_km`` across >=2 domains (GPS-jamming, dark/AIS-off vessels,
    military air, AIS gaps, emergencies, geocoded events, quakes) — or a single
    critical/high signal. Each incident carries a rule-based narrative, a
    threat_level, the contributing evidence (with IDs), and recommended follow-up
    queries. Omit coordinates for a global brief; pass a centre+radius or bbox to
    scope it. Start here, then drill into an incident's centroid with
    query_vessels / gps_jamming / deep_analyze.
    """
    return await _get(
        "/api/intel/brief",
        {
            "lat": lat, "lon": lon, "radius_nm": radius_nm,
            "min_lon": min_lon, "min_lat": min_lat,
            "max_lon": max_lon, "max_lat": max_lat,
            "link_km": link_km, "window_hours": window_hours,
        },
    )


@mcp.tool()
async def detect_deception(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 500.0,
) -> dict[str, Any]:
    """Denial & deception — "am I being fed?". Flags MANIPULATED tracks distinct
    from jamming: AIS duplicate-MMSI (one identity, two hulls) and impossible
    teleports; ADS-B GPS spoofing (many aircraft snapped to one false position)
    and kinematic position-injection. Run before trusting a feed in a contested
    area. Omit coords for global."""
    return await _get(
        "/api/intel/deception", {"lat": lat, "lon": lon, "radius_nm": radius_nm}
    )


@mcp.tool()
async def locate_emitter(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 500.0,
) -> dict[str, Any]:
    """Estimate a GPS jammer/spoofer LOCATION from the degraded-ADS-B footprint
    (severity-weighted centroid + CEP + confidence). Turns "jamming somewhere
    here" into "emitter ~here ±N km". Footprint-centroid estimate (~tens of km),
    not RF direction-finding — stated in the response. Scope with lat/lon."""
    return await _get(
        "/api/intel/emitter", {"lat": lat, "lon": lon, "radius_nm": radius_nm}
    )


@mcp.tool()
async def area_baseline(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 500.0,
) -> dict[str, Any]:
    """Is this normal? Current vessel / dark-vessel / jamming / military counts
    z-scored against a rolling baseline, with anomalies called out (e.g. "dark
    vessels +5σ", "traffic -3σ"). Global uses the background sampler; polling an
    AOI repeatedly builds that area's baseline. Distinguishes a real shift from
    a normal day."""
    return await _get(
        "/api/intel/baseline", {"lat": lat, "lon": lon, "radius_nm": radius_nm}
    )


@mcp.tool()
async def whats_changed(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 500.0,
) -> dict[str, Any]:
    """Standing watch — what CHANGED since the last check, not the full picture.

    Returns incidents that are NEW, ESCALATED, DE-ESCALATED, or RESOLVED. Global
    (no coords) reflects the background watch loop (recomputed ~every 60s); an
    AOI (lat/lon) diffs against YOUR previous whats_changed call for that area,
    so you can poll one region and be told only what moved. Use this to monitor
    instead of re-reading the whole brief each time.
    """
    return await _get(
        "/api/intel/watch", {"lat": lat, "lon": lon, "radius_nm": radius_nm}
    )


def _compact_points(points: list[dict[str, Any]], max_points: int) -> list[dict[str, Any]]:
    """Downsample one incident's observation series to its meaningful shape.

    Keeps the first + last point and every point whose threat ``level`` differs
    from its predecessor (a flat run of identical (level, score) is noise on a
    timeline). If transitions alone still exceed ``max_points`` it strides them
    down. Each kept point is shrunk to ``[t, level, score]`` (a list, not a
    verbose dict) so the wire form is a fraction of the size."""
    if not points:
        return []
    keep: list[dict[str, Any]] = [points[0]]
    prev = points[0].get("level")
    for p in points[1:-1]:
        if p.get("level") != prev:
            keep.append(p)
            prev = p.get("level")
    if len(points) > 1:
        keep.append(points[-1])
    if len(keep) > max_points:
        # Stride the kept transitions, but always retain the endpoints.
        step = (len(keep) - 1) / (max_points - 1)
        idx = sorted({0, *(round(i * step) for i in range(max_points)), len(keep) - 1})
        keep = [keep[i] for i in idx][:max_points]
    return [[p.get("t"), p.get("level"), p.get("score")] for p in keep]


def _compact_history(data: dict[str, Any], limit: int, max_points: int) -> dict[str, Any]:
    """Cap + condense the incident-history payload so the default call fits well
    under the MCP response token cap.

    The backend route returns EVERY incident in the window, each with its full
    per-snapshot ``points`` series and full ``narrative`` — ~89 KB at the
    default 6 h, which overflows the cap and hard-errors the tool. We keep the
    most-active incidents (the route already sorts by point-count desc), compact
    each one's series, trim the narrative, and report an honest "showing N of M".
    """
    incidents = data.get("incidents")
    if not isinstance(incidents, list):
        return data  # error payload or unexpected shape — pass through untouched
    total = len(incidents)
    kept = incidents[:limit]
    compact: list[dict[str, Any]] = []
    for inc in kept:
        narrative = inc.get("narrative")
        if isinstance(narrative, str) and len(narrative) > 240:
            narrative = narrative[:237] + "…"
        compact.append(
            {
                "key": inc.get("key"),
                "domains": inc.get("domains"),
                "centroid": inc.get("centroid"),
                "narrative": narrative,
                # series is [[t, level, score], …] — compact list form
                "series": _compact_points(inc.get("points") or [], max_points),
            }
        )
    out = {
        "scope": data.get("scope"),
        "window_hours": data.get("window_hours"),
        "snapshots": data.get("snapshots"),
        "incident_count": total,
        "returned": len(compact),
        "truncated": total > len(compact),
        "incidents": compact,
    }
    if out["truncated"]:
        out["note"] = (
            f"showing {len(compact)} of {total} incidents (most-active first); "
            "raise `limit` or scope with lat/lon/hours for more"
        )
    return out


@mcp.tool()
async def incident_history(
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 500.0,
    hours: float = 6.0,
    limit: int = 25,
    max_incidents: int | None = None,
) -> dict[str, Any]:
    """Timeline of how each incident built up over the recent window — per
    incident, a compact ``series`` of ``[time, threat_level, score]`` points.
    Reveals sequence (e.g. jamming first, then dark vessels, then a reported
    event). Global uses the background watch history; an AOI uses your prior
    watch calls.

    The full window can hold many incidents; this returns the ``limit`` most
    active ones (default 25, alias ``max_incidents``) with each series
    downsampled to its threat-level transitions, and reports
    ``incident_count`` / ``returned`` / ``truncated`` so you know if more exist.
    Raise ``limit`` or narrow with lat/lon/hours to drill in.
    """
    cap = max_incidents if max_incidents is not None else limit
    cap = max(1, min(int(cap), 200))
    data = await _get(
        "/api/intel/incident-history",
        {"lat": lat, "lon": lon, "radius_nm": radius_nm, "hours": hours},
    )
    return _compact_history(data, cap, max_points=12)


@mcp.tool()
async def vessel_dossier(mmsi: int | str) -> dict[str, Any]:
    """Pattern-of-life dossier for one vessel (MMSI): recent track, AIS gaps,
    derived speed profile (loiter / transit / loiter-then-dash), area covered,
    which live incidents it appears in, and a behaviour assessment. The track is
    the store's ~1h retention window."""
    # MMSI is numeric; agents pass it as an int or a string — accept both.
    return await _get(f"/api/intel/dossier/vessel/{quote(str(mmsi), safe='')}")


@mcp.tool()
async def aircraft_dossier(ident: str) -> dict[str, Any]:
    """Pattern-of-life dossier for one aircraft (ICAO24 hex or callsign): recent
    track, gaps, derived speed profile, GNSS-integrity, emergency/military flags,
    and which live incidents it appears in."""
    return await _get(f"/api/intel/dossier/aircraft/{quote(ident, safe='')}")


@mcp.tool()
async def list_focus_areas() -> dict[str, Any]:
    """List the priority areas currently loaded PRIMARY (with fetch stats and
    whether each is served by a dedicated fetch or the degraded snapshot
    fallback)."""
    return await _get("/api/intel/aois")


@mcp.tool()
async def data_sources() -> dict[str, Any]:
    """Which feeds are always-on vs key-gated, and the configured Ollama
    host/model. Use to explain coverage gaps (e.g. fires need a FIRMS key)."""
    return await _get("/api/intel/sources")


# ── deep analysis (DeepSeek reasoner, Ollama fallback) ────────────────────────

_SYS_PROMPT = (
    "You are a GEOINT analyst working a live open-source intelligence console. "
    "You are given distilled JSON from live ADS-B (aircraft), AIS (vessels), a "
    "GPS-jamming layer (ADS-B NACp/NIC, GPSJam method), and a cross-domain "
    "fusion engine whose `incident_brief` already chains co-located signals into "
    "ranked, cited INCIDENTS — lead your analysis from those incidents, then use "
    "the raw situation/area data to corroborate or challenge them. "
    "Reason ONLY over the provided JSON. Cite concrete numbers and IDs. Flag: "
    "GPS jamming/spoofing footprints, emergency squawks (7500 hijack / 7600 "
    "radio-fail / 7700 general), dark vessels, abnormal traffic density, and "
    "military activity. Be concise and structured: (1) ASSESSMENT (2 lines), "
    "(2) KEY FINDINGS (bullets with numbers), (3) RECOMMENDED FOLLOW-UP "
    "queries. If the data is thin, say so plainly — do not invent."
)


@mcp.tool()
async def deep_analyze(
    question: str,
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 250.0,
    model: str | None = None,
    tier: str = "reason",
) -> dict[str, Any]:
    """Have a reasoning model reason deeply over the live intel.

    Gathers the relevant data (global situation, plus a focused area bundle +
    jamming + anomalies when lat/lon given) and feeds it to a real reasoning
    model — DeepSeek (``deepseek-reasoner``) when configured, else a local
    Ollama model. Heavy reasoning runs off-context; only the conclusion enters
    the agent's context. Falls back to returning the raw structured data
    (analysis=null) if no LLM backend is reachable.

    Args:
        question: what to analyse (e.g. "Is there coordinated GPS jamming near
            the Baltic, and which aircraft are affected?").
        lat, lon, radius_nm: optional area to focus on (loaded PRIMARY).
        model: optional Ollama model override used only on the Ollama fallback.
        tier: ``reason`` (deepseek-reasoner, default — judgement) or ``fast``
            (deepseek-chat — quicker, shallower).
    """
    import json as _json

    from app import llm  # noqa: PLC0415

    # 1) gather context (already compact). The cross-domain incident BRIEF is the
    #    centrepiece — the reasoner judges fused, cited incidents rather than
    #    re-correlating raw layers in its head.
    context: dict[str, Any] = {"question": question, "situation": await get_situation()}
    context["incident_brief"] = await intel_brief(
        lat=lat, lon=lon, radius_nm=radius_nm,
        window_hours=12.0 if lat is None else 6.0,
    )
    if lat is not None and lon is not None:
        context["focus_area"] = await focus_area(lat, lon, radius_nm)

    # 2) reason off-context (DeepSeek → Ollama → raw data). Cap the wait so a
    #    slow upstream can't hang the tool for the 180 s default — the fast tier
    #    should answer well under 60 s, the deeper reason tier under 90 s.
    timeout_s = 60.0 if (tier or "").lower() == "fast" else 90.0
    res = await llm.complete(
        _SYS_PROMPT,
        f"QUESTION: {question}\n\nLIVE INTEL JSON:\n"
        + _json.dumps(context, separators=(",", ":"))[:60000],
        tier=tier,
        temperature=0.2,
        max_tokens=2048,
        timeout_s=timeout_s,
        ollama_model=model or "",
    )
    if not res.ok:
        return {
            "analysis": None,
            "model": res.model,
            "backend": res.backend,
            "note": f"No LLM backend reachable ({res.error}). Returning structured "
            "intel for you to analyse directly. Configure DEEPSEEK_API_KEY / the "
            "opencode DeepSeek key, or `ollama pull qwen2.5:3b`.",
            "data": context,
        }

    return {
        "analysis": res.text,
        "model": res.model,
        "backend": res.backend,
        "focused_on": (
            {"lat": lat, "lon": lon, "radius_nm": radius_nm} if lat is not None else "global"
        ),
        "data_summary": {
            "aircraft_total": context["situation"].get("aircraft", {}).get("total"),
            "jamming_high": context["situation"].get("gps_jamming", {}).get("high"),
        },
    }


# ── news intelligence (debias / fact-check) ──────────────────────────────────


@mcp.tool()
async def news_analysis() -> dict[str, Any]:
    """Cross-source, debiased world-news intelligence.

    Scrapes ~12 outlets (BBC, Reuters, AP, Al Jazeera, Guardian, CNN, Fox, …),
    then a reasoning model strips bias/propaganda and separates VERIFIED FACTS
    (corroborated by ≥2 independent outlets) from ATTRIBUTED CLAIMS and
    rhetoric. A leader promising "the war will end soon" is flagged as rhetoric,
    never reported as fact. Returns events with neutral_summary, verified_facts,
    attributed_claims, bias_flags, propaganda_techniques, rhetoric_flags and a
    confidence. May take ~30s when the cache is cold (it reasons over the feed).
    """
    return await _get("/api/news/analysis")


@mcp.tool()
async def fact_check(claim: str) -> dict[str, Any]:
    """Adjudicate one free-text claim against current world-news headlines.

    Returns ``{verdict: true|false|misleading|unverified, reasoning,
    supporting_sources, confidence}``. Use it to sanity-check a statement before
    treating it as fact.
    """
    return await _get("/api/news/factcheck", {"claim": claim})


@mcp.tool()
async def aoi_imagery(
    before: str,
    after: str,
    lat: float | None = None,
    lon: float | None = None,
    radius_km: float = 5.0,
    min_lon: float | None = None,
    min_lat: float | None = None,
    max_lon: float | None = None,
    max_lat: float | None = None,
    window_days: int = 30,
) -> dict[str, Any]:
    """Building imagery for a location at two dates — set time + place directly.

    Give a location (lat/lon + radius_km, OR an explicit min/max bbox) and a
    before + after date (YYYY-MM-DD). Returns what imagery is available for each
    date WITHOUT downloading: Maxar Open Data VHR (~0.3-0.5 m, event-gated — only
    where a disaster/conflict event covers the AOI) and Sentinel (10 m, global,
    any date). `best_source` says which to use. Reconstruction downloads the
    scenes to a temp dir on demand and discards them — nothing is stored.

    Args:
        before, after: dates as YYYY-MM-DD.
        lat, lon, radius_km: centre + radius (km) of the AOI.
        min_lon/min_lat/max_lon/max_lat: explicit bbox (overrides lat/lon).
        window_days: ± days around each date to search Maxar (events are sparse).
    """
    params: dict[str, Any] = {
        "before": before,
        "after": after,
        "radius_km": radius_km,
        "window_days": window_days,
    }
    if None not in (min_lon, min_lat, max_lon, max_lat):
        params.update(min_lon=min_lon, min_lat=min_lat, max_lon=max_lon, max_lat=max_lat)
    else:
        params.update(lat=lat, lon=lon)
    return await _get("/api/imagery/aoi", params)


# ── entrypoint ─────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="OSINT GEOINT MCP server")
    parser.add_argument("--http", action="store_true", help="serve over streamable-HTTP")
    parser.add_argument("--port", type=int, default=8765, help="HTTP port (with --http)")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP host (with --http)")
    parser.add_argument(
        "--list-tools", action="store_true", help="print registered tools and exit"
    )
    args = parser.parse_args()

    if args.list_tools:
        tools = asyncio.run(mcp.list_tools())
        print(f"osint-geoint MCP — {len(tools)} tools:")
        for t in tools:
            summary = (t.description or "").split("\n", 1)[0]
            print(f"  • {t.name}: {summary}")
        return

    if args.http:
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        mcp.run(transport="streamable-http")
    else:
        mcp.run()  # stdio


if __name__ == "__main__":
    main()
