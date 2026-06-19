"""GET /api/intel/* — deep, agent-facing intelligence API.

This is the HTTP surface the MCP server (``app.mcp_server``) drives, and a
power-user can hit it directly. Everything returns compact JSON
(``app.intel.analytics``); nothing dumps raw feature collections.

Geography is accepted two ways on the query endpoints:
- explicit bbox: ``min_lon,min_lat,max_lon,max_lat``
- centre + radius: ``lat,lon,radius_nm`` (radius defaults to 200 nm)

The ``/area`` endpoint is the headline tool: it loads the requested region
PRIMARY (dedicated fresh fetch + ongoing priority refresh) and returns a full
intel bundle for it in a single round trip.
"""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app import llm
from app.config import get_settings
from app.intel import agent, analytics, aoi, baseline, deception, dossier, emitter, incidents
from app.intel.baseline import baseline_store
from app.intel.geo import BBox, bbox_from_radius
from app.intel.incident_store import incident_store

router = APIRouter(tags=["intel"])


def _resolve_bbox(
    min_lon: float | None,
    min_lat: float | None,
    max_lon: float | None,
    max_lat: float | None,
    lat: float | None,
    lon: float | None,
    radius_nm: float,
) -> BBox | None:
    corners = (min_lon, min_lat, max_lon, max_lat)
    if all(v is not None for v in corners):
        if min_lon >= max_lon or min_lat >= max_lat:  # type: ignore[operator]
            raise HTTPException(422, "bbox requires min < max for both axes")
        return BBox(min_lon, min_lat, max_lon, max_lat)  # type: ignore[arg-type]
    if lat is not None and lon is not None:
        return bbox_from_radius(lat, lon, radius_nm)
    return None


@router.get("/api/intel/situation")
async def intel_situation() -> dict[str, Any]:
    """Global orienting summary — the cheap first call for an agent."""
    return await analytics.situation()


@router.get("/api/intel/area")
async def intel_area(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_nm: float = Query(200.0, ge=1, le=250),
    label: str | None = Query(None, max_length=80),
    primary: bool = Query(True),
    cell_deg: float = Query(1.0, ge=0.1, le=10.0),
) -> dict[str, Any]:
    """Load a region PRIMARY and return its full intel bundle in one shot."""
    return await analytics.area_intel(
        lat=lat,
        lon=lon,
        radius_nm=radius_nm,
        label=label,
        set_primary=primary,
        cell_deg=cell_deg,
    )


@router.get("/api/intel/density")
async def intel_density(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(200.0, ge=1, le=2000),
    cell_deg: float = Query(1.0, ge=0.1, le=10.0),
) -> dict[str, Any]:
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await analytics.density(bbox, cell_deg)


@router.get("/api/intel/jamming")
async def intel_jamming(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
) -> dict[str, Any]:
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await analytics.jamming(bbox)


@router.get("/api/intel/aircraft")
async def intel_aircraft(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(200.0, ge=1, le=2000),
    category: str | None = Query(None),
    squawk: str | None = Query(None),
    callsign_contains: str | None = Query(None),
    min_alt_m: float | None = Query(None),
    max_alt_m: float | None = Query(None),
    emergency: bool | None = Query(None),
    gnss_degraded: bool | None = Query(None),
    on_ground: bool | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await analytics.query_aircraft(
        bbox=bbox,
        category=category,
        squawk=squawk,
        callsign_contains=callsign_contains,
        min_alt_m=min_alt_m,
        max_alt_m=max_alt_m,
        emergency=emergency,
        gnss_degraded=gnss_degraded,
        on_ground=on_ground,
        limit=limit,
    )


@router.get("/api/intel/aircraft/{ident}")
async def intel_aircraft_lookup(ident: str) -> dict[str, Any]:
    return await analytics.lookup_aircraft(ident)


@router.get("/api/intel/vessels")
async def intel_vessels(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
    dark_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await analytics.query_vessels(bbox, dark_only=dark_only, limit=limit)


@router.get("/api/intel/anomalies")
async def intel_anomalies(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
) -> dict[str, Any]:
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await analytics.anomalies(bbox)


@router.get("/api/intel/brief")
async def intel_brief(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
    link_km: float = Query(50.0, ge=1, le=500),
    window_hours: float = Query(6.0, ge=0.25, le=72.0),
) -> dict[str, Any]:
    """Cross-domain incident brief: signals fused into ranked, cited incidents.

    Omit coordinates for a global brief; pass a centre+radius or a bbox to scope
    it. ``link_km`` is the convergence distance; ``window_hours`` bounds recency.
    """
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await incidents.brief(bbox, link_km=link_km, window_s=window_hours * 3600.0)


_INVESTIGATE_SYS = (
    "You are VELOCITY, an all-source intelligence analyst. You are given a list of REAL "
    "cross-domain incidents already fused from live ADS-B, AIS, SAR, GPS-jamming and event "
    "feeds for the operator's area, plus their question. Reason ONLY over the incidents "
    "provided — never invent vessels, aircraft, numbers, or events not present. Cite incidents "
    "by their exact id. If the evidence is thin, say so. Reply with ONLY a JSON object: "
    '{"assessment": "<=3 sentence analyst judgement answering the question, grounded in the '
    'incidents>", "findings": [{"id": "<incident id>", "label": "<short label>", "threat": '
    '"high|elevated|low", "why": "<one line citing the domains/evidence>"}], '
    '"recommended_detection": {"rule": "<a standing-detection rule in plain logic, e.g. '
    "ais.gap>=3h AND sar.detect<=3km>\", \"scope\": \"<area>\"} | null, "
    '"follow_up": ["<concrete next analytic step>", ...]}'
)


@router.get("/api/intel/investigate")
async def intel_investigate(
    q: str = Query(..., min_length=2, max_length=400, description="natural-language prompt"),
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
    link_km: float = Query(50.0, ge=1, le=500),
    window_hours: float = Query(6.0, ge=0.25, le=72.0),
) -> dict[str, Any]:
    """Agent investigator: runs the REAL cross-domain incident fusion for the scope,
    then has the LLM reason over those CITED incidents to answer a natural-language
    prompt — returning an analyst assessment, the steps taken, ranked findings (grounded
    in real incident ids), a proposed standing detection, and follow-ups, with the real
    model + token usage. Degrades to a deterministic brief-only summary (``llm_ok:false``,
    ``backend:"rule-based"``) when no LLM backend answers — never fabricates."""
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    t0 = time.monotonic()
    brief = await incidents.brief(bbox, link_km=link_km, window_s=window_hours * 3600.0)
    scope = brief.get("scope") or _scope_for(bbox)
    incidents_full = brief.get("incidents") or []

    # Trim the real incidents to a model-sized, citable context.
    top: list[dict[str, Any]] = [
        {
            "id": inc.get("id"),
            "threat_level": inc.get("threat_level"),
            "domains": inc.get("domains"),
            "signal_count": inc.get("signal_count"),
            "span_km": inc.get("span_km"),
            "centroid": inc.get("centroid"),
            "narrative": inc.get("narrative"),
            "follow_up": inc.get("follow_up"),
        }
        for inc in incidents_full[:8]
    ]

    # The fusion pipeline's real stages, annotated with this run's real counts.
    method_steps = [
        {
            "label": "Ingest theater signals",
            "detail": str(brief.get("method") or "fuse live ADS-B/AIS/SAR/jamming/events"),
            "result": f"{brief.get('signals_considered', '?')} signals",
        },
        {
            "label": "Cluster convergences",
            "detail": f"link ≤ {link_km:.0f} km · window {window_hours:.0f} h",
            "result": f"{brief.get('incident_count', 0)} incidents",
        },
        {
            "label": "Score + rank threat",
            "detail": "domain convergence + recency",
            "result": f"top {brief.get('top_threat_level', '—')}",
        },
    ]

    user_payload = json.dumps(
        {"question": q, "scope": scope, "by_level": brief.get("by_level"), "incidents": top},
        ensure_ascii=False,
    )
    parsed, res = await llm.chat_json(
        [
            {"role": "system", "content": _INVESTIGATE_SYS},
            {"role": "user", "content": user_payload},
        ],
        tier="fast",
        max_tokens=1400,
        timeout_s=160.0,  # MiniMax-M3 reasoning is slow; degrade to DeepSeek if it overruns
    )
    latency_ms = round((time.monotonic() - t0) * 1000)

    base = {
        "query": q,
        "scope": scope,
        "latency_ms": latency_ms,
        "incident_count": brief.get("incident_count"),
        "signals_considered": brief.get("signals_considered"),
        "top_threat_level": brief.get("top_threat_level"),
        "by_level": brief.get("by_level"),
        "generated_at": brief.get("generated_at"),
        "steps": method_steps,
    }

    if res.ok and isinstance(parsed, dict):
        # Keep only model findings whose id matches a REAL incident, and enrich
        # each with that incident's centroid (so the UI can fly to it) — strict
        # anti-fabrication: a finding the model invented is dropped.
        findings = _enrich_findings(parsed.get("findings") or [], top) or _fallback_findings(top)
        return {
            **base,
            "llm_ok": True,
            "backend": res.backend,
            "model": res.model,
            "usage": res.usage,
            "assessment": parsed.get("assessment"),
            "findings": findings,
            "recommended_detection": parsed.get("recommended_detection"),
            "follow_up": parsed.get("follow_up") or _first_follow_up(top),
        }

    # No LLM answer — deterministic brief-only result, clearly flagged.
    return {
        **base,
        "llm_ok": False,
        "backend": "rule-based",
        "model": None,
        "usage": {},
        "llm_error": res.error,
        "assessment": (top[0]["narrative"] if top else "No active convergences in scope."),
        "findings": _fallback_findings(top),
        "recommended_detection": None,
        "follow_up": _first_follow_up(top),
    }


def _fallback_findings(top: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i in top:
        domains = i.get("domains") or []
        out.append(
            {
                "id": i.get("id"),
                "label": " + ".join(domains) if domains else "convergence",
                "threat": i.get("threat_level"),
                "why": (str(i.get("narrative") or ""))[:200],
                "centroid": i.get("centroid"),
                "domains": domains,
            }
        )
    return out


def _enrich_findings(
    findings: list[Any], top: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Keep only model findings that cite a REAL incident id, backfilling each
    with that incident's centroid + domains so the UI can fly to it."""
    idx = {str(i.get("id")): i for i in top if i.get("id")}
    out: list[dict[str, Any]] = []
    for f in findings:
        if not isinstance(f, dict):
            continue
        inc = idx.get(str(f.get("id")))
        if inc is None:
            continue
        domains = inc.get("domains") or []
        out.append(
            {
                "id": inc.get("id"),
                "label": f.get("label") or (" + ".join(domains) if domains else "convergence"),
                "threat": f.get("threat") or inc.get("threat_level"),
                "why": f.get("why") or (str(inc.get("narrative") or ""))[:200],
                "centroid": inc.get("centroid"),
                "domains": domains,
            }
        )
    return out


def _first_follow_up(top: list[dict[str, Any]]) -> list[str]:
    for i in top:
        fu = i.get("follow_up")
        if isinstance(fu, list) and fu:
            return [str(x) for x in fu]
    return []


@router.get("/api/intel/agent")
async def intel_agent(
    q: str = Query(..., min_length=2, max_length=400, description="natural-language prompt"),
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
) -> StreamingResponse:
    """Streaming analyst agent — a REAL tool-calling loop (Server-Sent Events).

    Seeds with the fused incident brief, then MiniMax-M3 reasons and calls the
    live intel tools (query_vessels, gps_jamming, locate_emitter, …) step by
    step until it returns a final assessment. Each step is streamed as an SSE
    ``data:`` frame so the UI renders the loop live. Events:
    start | tool_call | tool_result | thinking | note | error | final | done.
    """
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)

    async def gen() -> Any:
        try:
            async for ev in agent.run_agent(q, bbox):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001
            err = {"type": "error", "text": f"{type(exc).__name__}: {exc}"}
            yield f"data: {json.dumps(err)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _scope_for(bbox: BBox | None) -> str:
    if bbox is None:
        return "global"
    d = bbox.as_dict()
    return (f"aoi:{round(d['min_lon'], 1)}:{round(d['min_lat'], 1)}:"
            f"{round(d['max_lon'], 1)}:{round(d['max_lat'], 1)}")


@router.get("/api/intel/watch")
async def intel_watch(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
) -> dict[str, Any]:
    """Standing watch: what CHANGED since the last check (new / escalated /
    de-escalated / resolved incidents).

    Global: returns the background watch loop's latest diff (recomputed every
    ~60s) plus the current top-line — read-only, no clobbering the baseline.
    AOI (centre+radius or bbox): records a fresh snapshot under that area's scope
    and diffs it against YOUR previous call for the same area — so an agent can
    poll one AOI and be told only what moved.
    """
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    b = await incidents.brief(bbox)
    if bbox is None:
        changes = incident_store.last_changes("global") or {
            "scope": "global", "had_baseline": False, "new": [], "escalated": [],
            "deescalated": [], "resolved": [], "steady": 0, "active": b["incident_count"],
            "note": "watch loop has not ticked yet",
        }
    else:
        changes = incident_store.record(_scope_for(bbox), b["incidents"])
    return {
        "top_threat_level": b["top_threat_level"],
        "incident_count": b["incident_count"],
        "by_level": b["by_level"],
        "changes": changes,
    }


@router.get("/api/intel/incident-history")
async def intel_incident_history(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
    hours: float = Query(6.0, ge=0.25, le=24.0),
) -> dict[str, Any]:
    """Per-incident timeline over the recent window — how each convergence built
    up. Global uses the background watch loop's history; an AOI uses the history
    accumulated by your prior /watch calls for that area."""
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return incident_store.history(_scope_for(bbox), hours * 3600.0)


@router.get("/api/intel/deception")
async def intel_deception(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
) -> dict[str, Any]:
    """Denial & deception sweep: spoofed AIS identity/position + ADS-B GPS
    spoofing (distinct from the jamming layer)."""
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await deception.detect(bbox)


@router.get("/api/intel/emitter")
async def intel_emitter(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
) -> dict[str, Any]:
    """Estimate a GPS jammer/spoofer location from the degraded-ADS-B footprint
    (severity-weighted centroid + CEP). Footprint estimate, not RF DF."""
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await emitter.estimate(bbox)


@router.get("/api/intel/baseline")
async def intel_baseline(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
) -> dict[str, Any]:
    """Is this normal? Current vessel/dark/jamming/military counts z-scored
    against a rolling baseline. Global uses the background sampler; an AOI
    samples-on-read so repeated polls of the same area build its baseline."""
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    scope = _scope_for(bbox)
    current = await baseline.current_metrics(bbox)
    if bbox is not None:  # build an AOI baseline from the caller's own polling
        baseline_store.sample(scope, current)
    return baseline_store.assess(scope, current)


@router.get("/api/intel/dossier/vessel/{mmsi}")
async def intel_vessel_dossier(mmsi: str) -> dict[str, Any]:
    """Pattern-of-life dossier for one vessel (MMSI)."""
    return await dossier.vessel_dossier(mmsi)


@router.get("/api/intel/dossier/aircraft/{ident}")
async def intel_aircraft_dossier(ident: str) -> dict[str, Any]:
    """Pattern-of-life dossier for one aircraft (ICAO24 hex or callsign)."""
    return await dossier.aircraft_dossier(ident)


@router.get("/api/intel/aois")
async def intel_aois() -> dict[str, Any]:
    """List the priority areas currently loaded PRIMARY."""
    return {"aois": aoi.list_aois(), "max": aoi._MAX_AOIS}


@router.get("/api/intel/sources")
async def intel_sources() -> dict[str, Any]:
    """Data-source health + which feeds are key-gated vs always-on."""
    from app import ais_firehose, ais_keyless  # noqa: PLC0415

    s = get_settings()
    return {
        "always_on": [
            "adsb (adsb.lol + airplanes.live grid — keyless aircraft firehose)",
            "opensky /states/all (anonymous — the ~13k global breadth tier; "
            "OAuth creds only raise the daily credit budget)",
            "ais (digitraffic Finland/Baltic)",
            "ais firehose (Kystverket NMEA + Kystdatahuset REST [Norway] + "
            "Digitraffic MQTT [Baltic] — keyless, Northern Europe only; "
            "global vessels still need AISStream)",
            "jamming (derived from ADS-B NACp/NIC)",
            "usgs quakes",
        ],
        "key_gated": {
            "aisstream": bool(s.aisstream_key),
            "firms_fires": bool(s.firms_map_key),
            "opensky_authed": bool(s.opensky_client_id and s.opensky_client_secret),
            "gfw_dark_vessels": bool(s.gfw_token),
            "acled_events": bool(s.acled_key),
            "cloudflare_outages": bool(s.cloudflare_token),
            "openaip": bool(s.openaip_key),
        },
        "key_gated_note": (
            "true = key is CONFIGURED, not proven working — a set key can still "
            "401 or be expired. Hit the feed to confirm liveness."
        ),
        "degraded": {
            "adsb_single_shot_firehose": (
                "adsb.fi 403 / adsb.lol 451 / /v2/all* 404 from most datacenter "
                "egress IPs; used opportunistically. OpenSky /states/all is the "
                "breadth source."
            ),
        },
        "ais_firehose": ais_firehose.stats(),
        "ais_keyless": ais_keyless.stats(),
        "ollama": {"host": s.ollama_host, "model": s.ollama_model or "(auto-detect)"},
        "llm": llm.status(),
    }
