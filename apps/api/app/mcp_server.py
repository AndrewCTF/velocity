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
- **Think deeper, locally.** ``deep_analyze`` pulls the relevant intel JSON and
  hands it to a local Ollama model to reason over — heavy analysis happens on
  the box, only the conclusion returns to the agent's context.

Run:
    python -m app.mcp_server                # stdio (Claude Code / Desktop / SDK)
    python -m app.mcp_server --http --port 8765   # streamable-HTTP
    python -m app.mcp_server --list-tools   # introspect, for CI / verification

Config (env or apps/api/.env): API_BASE, API_KEY, OLLAMA_HOST, OLLAMA_MODEL.
"""

from __future__ import annotations

import argparse
import asyncio
import os
from typing import Any

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


async def _get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """GET an intel endpoint. Returns parsed JSON or a structured error dict —
    never raises, so a tool call always yields something the agent can read."""
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
            "hint": "Start the API: cd apps/api && .venv/bin/uvicorn app.main:app --port 8000",
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
    return await _get(f"/api/intel/aircraft/{ident}")


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


# ── Ollama deep analysis ──────────────────────────────────────────────────────

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

_SMALL_HINTS = ("a3b", "1b", "2b", "3b", "mini", "small", "phi", "gemma2:2b", "qwen2.5:3b")


async def _ollama_models(host: str) -> list[str]:
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.get(host.rstrip("/") + "/api/tags")
        if r.status_code != 200:
            return []
        return [m.get("name", "") for m in (r.json().get("models") or []) if m.get("name")]
    except Exception:
        return []


def _pick_model(models: list[str], prefer: str) -> str | None:
    if prefer:
        # exact or prefix match against an installed tag
        for m in models:
            if m == prefer or m.startswith(prefer):
                return m
        return prefer  # let Ollama try; it may pull/resolve
    if not models:
        return None
    # Prefer a small/fast model so deep_analyze stays responsive.
    for hint in _SMALL_HINTS:
        for m in models:
            if hint in m.lower():
                return m
    return models[0]


@mcp.tool()
async def deep_analyze(
    question: str,
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float = 250.0,
    model: str | None = None,
) -> dict[str, Any]:
    """Have a LOCAL Ollama model reason deeply over the live intel.

    Gathers the relevant data (global situation, plus a focused area bundle +
    jamming + anomalies when lat/lon given), feeds it to a small local model,
    and returns the model's analysis. Heavy reasoning runs on the box; only the
    conclusion enters your context. Falls back to returning the raw structured
    data (analysis=null) if Ollama is unreachable.

    Args:
        question: what to analyse (e.g. "Is there coordinated GPS jamming near
            the Baltic, and which aircraft are affected?").
        lat, lon, radius_nm: optional area to focus on (loaded PRIMARY).
        model: optional Ollama model override; defaults to the smallest
            installed model.
    """
    settings = get_settings()
    host = os.environ.get("OLLAMA_HOST") or settings.ollama_host

    # 1) gather context (already compact)
    context: dict[str, Any] = {"question": question, "situation": await get_situation()}
    if lat is not None and lon is not None:
        context["focus_area"] = await focus_area(lat, lon, radius_nm)
    else:
        context["global_jamming"] = await gps_jamming()
        context["global_anomalies"] = await anomalies()

    # 2) choose a model
    models = await _ollama_models(host)
    chosen = _pick_model(models, model or os.environ.get("OLLAMA_MODEL") or settings.ollama_model)
    if not chosen:
        return {
            "analysis": None,
            "model": None,
            "note": f"Ollama unreachable at {host} or no models installed. "
            "Returning the structured intel for you to analyse directly. "
            "Install a small model, e.g. `ollama pull qwen2.5:3b`.",
            "available_models": models,
            "data": context,
        }

    # 3) reason locally
    import json as _json

    payload = {
        "model": chosen,
        "stream": False,
        "options": {"temperature": 0.2},
        "messages": [
            {"role": "system", "content": _SYS_PROMPT},
            {
                "role": "user",
                "content": f"QUESTION: {question}\n\nLIVE INTEL JSON:\n"
                + _json.dumps(context, separators=(",", ":"))[:60000],
            },
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=300.0) as c:
            r = await c.post(host.rstrip("/") + "/api/chat", json=payload)
        if r.status_code != 200:
            raise RuntimeError(f"ollama {r.status_code}: {r.text[:200]}")
        body = r.json()
        analysis = (body.get("message") or {}).get("content", "").strip()
    except Exception as exc:  # noqa: BLE001
        return {
            "analysis": None,
            "model": chosen,
            "note": f"Ollama call failed ({exc}). Returning structured intel instead.",
            "data": context,
        }

    return {
        "analysis": analysis,
        "model": chosen,
        "focused_on": (
            {"lat": lat, "lon": lon, "radius_nm": radius_nm} if lat is not None else "global"
        ),
        "data_summary": {
            "aircraft_total": context["situation"].get("aircraft", {}).get("total"),
            "jamming_high": context["situation"].get("gps_jamming", {}).get("high"),
        },
    }


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
