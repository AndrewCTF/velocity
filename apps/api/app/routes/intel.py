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

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app import llm
from app.config import get_settings
from app.intel import agent, analytics, aoi, baseline, deception, dossier, emitter, incidents, pol
from app.intel.baseline import baseline_store
from app.intel.geo import BBox, bbox_from_radius
from app.intel.incident_store import incident_store
from app.keys import UserCtx, current_user
from app.security import current_principal

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
    limit: int = Query(200, ge=1, le=500),
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
        timeout_s=90.0,  # cap at 90 s; MiniMax-M3 reasoning → DeepSeek fallback on overrun
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
    request: Request,
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
    step until it returns a final assessment. With a signed-in user it can ALSO
    invoke the audited write-back actions (flag_entity / promote_incident /
    nominate_target / add_watch) and drive the operator's map (camera / filter /
    selection) via an ``app_var`` event. Each step is streamed as an SSE
    ``data:`` frame so the UI renders the loop live. Events:
    start | tool_call | tool_result | thinking | note | narration | action |
    app_var | clarification | error | final | done.
    """
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)

    # Resolve the signed-in user best-effort. The global ApiKeyMiddleware already
    # authorised the request, but a static-API-key dev caller has no user
    # identity — and write-back actions need one (the audit log records WHO). A
    # token-less/keyless run gets ctx=None: the agent keeps every read-only tool
    # and the control tools, and simply hides the audited write-back verbs.
    try:
        ctx: UserCtx | None = await current_user(request)
    except HTTPException:
        ctx = None

    # Need-to-know: the agent redacts every read-tool result to the reader's
    # clearance/compartments. Resolve them least-privilege — a keyless/token-less
    # run (ctx is None) is pinned at clearance 0 / no compartments, NOT full read.
    # No try/except that elevates: current_principal already degrades to clearance
    # 0 when the profile is unreachable.
    clearance, compartments = 0, ()
    if ctx is not None:
        principal = await current_principal(request, ctx)
        clearance, compartments = principal.clearance, principal.compartments

    async def gen() -> Any:
        try:
            # The serializer forwards EVERY event verbatim (no event-type
            # whitelist), so the new action/app_var/clarification frames reach
            # the client with no extra plumbing.
            async for ev in agent.run_agent(q, bbox, ctx, clearance, compartments):
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
    if bbox is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "lat+lon (or min_lon/min_lat/max_lon/max_lat) required; "
                "a global emitter estimate is not meaningful"
            ),
        )
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


# ── grounded dossier narrative (the Gotham "Dossier" prose) ──────────────────────
# Turns the DETERMINISTIC dossier dict into a short analytic narrative via the
# reasoning model. Hard anti-hallucination contract: the model reasons ONLY over
# the facts handed in, every claim cites the field it came from, and the output is
# labelled an ASSESSMENT (never asserted fact). Degrades to ok:false when no model
# is wired — it never invents a story.

_NARRATIVE_SYSTEM = (
    "You are an intelligence analyst writing a SHORT pattern-of-life assessment. "
    "You are given a deterministic dossier (observed track stats, AIS/ADS-B gaps, "
    "speed profile, coverage, recent incident ids, identity attributes, source "
    "freshness) for one tracked entity. Reason ONLY over the facts provided. Every "
    "claim MUST reference a field from the input. Do NOT invent vessel/aircraft "
    "names, ports, destinations, dates, counts, intentions, or events not present "
    "in the data. This is an ANALYTIC ASSESSMENT, not a stated fact; hedge "
    "accordingly and produce no operational detail.\n\n"
    "Return STRICT JSON and nothing else:\n"
    "{\n"
    '  "assessment": "2-4 sentence analytic narrative",\n'
    '  "observations": [{"claim": str, "grounded_in": "<the exact input field>"}],\n'
    '  "confidence": "low|medium|high",\n'
    '  "caveats": [str]\n'
    "}\n"
    "If the dossier is too thin to assess (almost no track), say so in one sentence "
    "and return an empty observations list — do NOT fill the gap with a story."
)

# (entity_id) → (expires_epoch, payload). The dossier moves slowly; a ~10 min TTL
# keeps the reason-tier cost off repeat selections without staleness mattering.
_NARRATIVE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_NARRATIVE_TTL_S = 600.0


@router.post("/api/intel/dossier/narrative")
async def intel_dossier_narrative(entity_id: str = Query(...)) -> dict[str, Any]:
    """Grounded analytic narrative for one entity (``vessel:<mmsi>``/``aircraft:<id>``).

    Builds the deterministic dossier, then asks the reasoning model to narrate it
    under a strict grounding prompt. On-demand only (the frontend gates it behind a
    button), cached ~10 min. ``ok:false`` when no model is configured — never a fake.
    """
    now = time.time()
    cached = _NARRATIVE_CACHE.get(entity_id)
    if cached and cached[0] > now:
        return cached[1]

    prefix, _, raw_id = entity_id.partition(":")
    bare = raw_id or entity_id
    if prefix == "aircraft":
        doss = await dossier.aircraft_dossier(bare)
    elif prefix == "vessel":
        doss = await dossier.vessel_dossier(bare)
    else:
        return {"ok": False, "error": "entity_id must be vessel:<mmsi> or aircraft:<id>"}

    # Trim the full track array out of the prompt (keep its size, not 1000s of fixes)
    # — the stats already summarise it and a long array just burns tokens.
    facts = {k: v for k, v in doss.items() if k != "track"}
    facts["track_points"] = len(doss.get("track") or [])
    user = "Dossier:\n" + json.dumps(facts, default=str)[:6000]

    parsed, res = await llm.chat_json(
        [
            {"role": "system", "content": _NARRATIVE_SYSTEM},
            {"role": "user", "content": user},
        ],
        tier="reason",
        temperature=0.2,
        max_tokens=900,
    )
    if not res.ok or not isinstance(parsed, dict):
        return {
            "ok": False,
            "error": res.error or "model unavailable",
            "model": res.model,
        }
    payload = {"ok": True, "model": res.model, "backend": res.backend, **parsed}
    _NARRATIVE_CACHE[entity_id] = (now + _NARRATIVE_TTL_S, payload)
    return payload


@router.get("/api/intel/pol/{entity_id:path}")
async def intel_pattern_of_life(entity_id: str) -> dict[str, Any]:
    """Pattern-of-life baseline for ONE entity, from its own positions-DB track.

    ``entity_id`` is the canonical id (``aircraft:<icao24>`` or
    ``vessel:<mmsi>``) — the colon is captured via a ``:path`` converter. Returns
    the recurring places it keeps returning to (a small self-contained DBSCAN
    over its fixes), dwell/transit + speed-variance stats, a movement profile,
    and an anomaly-vs-baseline score. Honest about short tracks: returns
    ``sufficient: false`` rather than a synthesised norm when the DB holds too
    few fixes."""
    return await pol.pattern_of_life(entity_id)


@router.get("/api/intel/aois")
async def intel_aois() -> dict[str, Any]:
    """List the priority areas currently loaded PRIMARY."""
    return {"aois": aoi.list_aois(), "max": aoi._MAX_AOIS}


@router.get("/api/intel/sources")
async def intel_sources() -> dict[str, Any]:
    """Data-source health + which feeds are key-gated vs always-on."""
    from app import ais_firehose, ais_keyless  # noqa: PLC0415

    s = get_settings()

    # opensky_authed honesty: a set key proves nothing (CLAUDE.md: configured !=
    # working — expired creds 401 with "Invalid client"). `opensky_authed` stays
    # the CONFIGURED bool (stable contract), and `opensky_authed_working` is
    # PROVEN by an actual cached OAuth token fetch — None when unconfigured,
    # False when the authed probe fails, True only when a token was issued.
    opensky_configured = bool(s.opensky_client_id and s.opensky_client_secret)
    opensky_working: bool | None = None
    if opensky_configured:
        try:
            from app.routes.aviation import _token_manager  # noqa: PLC0415

            opensky_working = bool(await _token_manager(s).get())
        except Exception:  # noqa: BLE001 — dead/expired creds → not working
            opensky_working = False

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
            "opensky_authed": opensky_configured,
            "gfw_dark_vessels": bool(s.gfw_token),
            "acled_events": bool(s.acled_key),
            "cloudflare_outages": bool(s.cloudflare_token),
            "openaip": bool(s.openaip_key),
        },
        # Proven-working signal (not just configured) for the authed OpenSky tier:
        # null = no creds set, false = creds set but the OAuth probe failed
        # (expired / "Invalid client"), true = a token was actually issued.
        "opensky_authed_working": opensky_working,
        "key_gated_note": (
            "true = key is CONFIGURED, not proven working — a set key can still "
            "401 or be expired. Hit the feed to confirm liveness. See "
            "opensky_authed_working for a probe-backed signal."
        ),
        "degraded": {
            "adsb_single_shot_firehose": (
                "adsb.fi 403 / adsb.lol 451 / /v2/all* 404 from most datacenter "
                "egress IPs; used opportunistically. OpenSky /states/all is the "
                "breadth source."
            ),
        },
        "osint_lookup": {
            "note": (
                "keyless on-demand infra/domain OSINT (not a streaming feed): "
                "GET /api/osint/{dns,whois,ip,certs,shodan,threat}?target= and "
                "POST /api/osint/investigate. Hit a source to confirm liveness."
            ),
            "sources": [
                "dns (dns.google DoH)",
                "whois (rdap.org)",
                "certs (crt.sh — flaky from datacenter egress)",
                "ip (ip-api.com, 45/min free)",
                "shodan (internetdb.shodan.io)",
                "threat (otx.alienvault.com)",
            ],
        },
        "ais_firehose": ais_firehose.stats(),
        "ais_keyless": ais_keyless.stats(),
        "ollama": {"host": s.ollama_host, "model": s.ollama_model or "(auto-detect)"},
        "llm": llm.status(),
    }
