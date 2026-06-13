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
from typing import Any
from urllib.parse import quote, urlparse

import httpx
from mcp.server.fastmcp import FastMCP

from app.config import get_settings

mcp = FastMCP(
    "osint-geoint",
    instructions=(
        "Live geospatial intelligence over open ADS-B (aircraft), AIS (vessels), "
        "GPS-jamming (ADS-B NACp/NIC), and a fusion engine. Start with "
        "get_situation() to orient, then focus_area(lat,lon,radius_nm) to load a "
        "region PRIMARY and pull density / GPS jamming / anomalies for it. Use "
        "deep_analyze() to have a local model reason over the data."
    ),
)


# ── backend HTTP plumbing ─────────────────────────────────────────────────────


def _api_base() -> str:
    return (os.environ.get("API_BASE") or get_settings().api_base).rstrip("/")


def _headers() -> dict[str, str]:
    key = os.environ.get("API_KEY") or get_settings().api_key
    return {"X-API-Key": key} if key else {}


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
    "GPS-jamming layer (ADS-B NACp/NIC, GPSJam method), and a fusion engine. "
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

    # 1) gather context (already compact)
    context: dict[str, Any] = {"question": question, "situation": await get_situation()}
    if lat is not None and lon is not None:
        context["focus_area"] = await focus_area(lat, lon, radius_nm)
    else:
        context["global_jamming"] = await gps_jamming()
        context["global_anomalies"] = await anomalies()

    # 2) reason off-context (DeepSeek → Ollama → raw data)
    res = await llm.complete(
        _SYS_PROMPT,
        f"QUESTION: {question}\n\nLIVE INTEL JSON:\n"
        + _json.dumps(context, separators=(",", ":"))[:60000],
        tier=tier,
        temperature=0.2,
        max_tokens=2048,
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
