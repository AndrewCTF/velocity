"""Streaming analyst agent — a real tool-calling loop over the live intel tools.

Unlike a one-shot LLM call, this runs a genuine ReAct loop: the model is given
the REAL intel tools (the same functions the MCP server and the globe use),
seeded with the fused incident brief, and on each turn it either calls a tool
(executed against live data) or returns its final assessment. Every step is
yielded as an event so the frontend can render the loop live — thoughts, tool
calls, tool results, and the final brief — the way Claude Code shows its work.

Grounding + honesty: tools return real distilled JSON; the model is told to cite
real incident ids; final findings are filtered to ids that actually appeared in
a brief this run, and enriched with the incident centroid so the UI can fly to
them. If the LLM is unavailable the loop still emits the brief-derived result.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from app import llm
from app.intel import actions, analytics, baseline, classification, deception, dossier, emitter, incidents
from app.intel.geo import BBox, bbox_from_radius
from app.intel.incident_store import incident_store
from app.keys import UserCtx

# ── tool registry — each maps to a REAL live-intel function ──────────────────

ToolFn = Callable[[dict[str, Any], BBox | None], Awaitable[dict[str, Any]]]


def _bbox(args: dict[str, Any], default: BBox | None) -> BBox | None:
    lat, lon = args.get("lat"), args.get("lon")
    if lat is not None and lon is not None:
        return bbox_from_radius(float(lat), float(lon), float(args.get("radius_nm", 200) or 200))
    return default


async def _t_situation(_a: dict[str, Any], _b: BBox | None) -> dict[str, Any]:
    return await analytics.situation()


async def _t_brief(a: dict[str, Any], b: BBox | None) -> dict[str, Any]:
    return await incidents.brief(_bbox(a, b))


async def _t_vessels(a: dict[str, Any], b: BBox | None) -> dict[str, Any]:
    return await analytics.query_vessels(_bbox(a, b), dark_only=bool(a.get("dark_only", False)))


async def _t_aircraft(a: dict[str, Any], b: BBox | None) -> dict[str, Any]:
    cat = a.get("category")
    return await analytics.query_aircraft(
        _bbox(a, b), category=cat if isinstance(cat, str) else None
    )


async def _t_lookup_aircraft(a: dict[str, Any], _b: BBox | None) -> dict[str, Any]:
    # Identify ONE named aircraft by callsign / tail / ICAO24 hex. Returns its
    # registration, type, live position AND flight route (departure + destination
    # airport, distance-to-go, ETA). This is the tool for "where is/where did
    # flight X come from / where is it going / when does it land".
    ident = str(a.get("ident") or a.get("callsign") or a.get("icao24") or "").strip()
    if not ident:
        return {"error": "lookup_aircraft needs 'ident' — a callsign, tail number, or ICAO24 hex."}
    return await analytics.lookup_aircraft(ident)


async def _t_lookup_vessel(a: dict[str, Any], _b: BBox | None) -> dict[str, Any]:
    # Identify ONE named vessel by MMSI (9 digits). Returns its dossier — identity,
    # latest fix, track stats, and any incident membership.
    ident = str(a.get("ident") or a.get("mmsi") or "").strip()
    if not ident:
        return {"error": "lookup_vessel needs 'ident' — a 9-digit MMSI."}
    return await dossier.vessel_dossier(ident)


async def _t_jamming(a: dict[str, Any], b: BBox | None) -> dict[str, Any]:
    return await analytics.jamming(_bbox(a, b))


async def _t_anomalies(a: dict[str, Any], b: BBox | None) -> dict[str, Any]:
    return await analytics.anomalies(_bbox(a, b))


async def _t_deception(a: dict[str, Any], b: BBox | None) -> dict[str, Any]:
    return await deception.detect(_bbox(a, b))


async def _t_emitter(a: dict[str, Any], b: BBox | None) -> dict[str, Any]:
    return await emitter.estimate(_bbox(a, b))


async def _t_baseline(a: dict[str, Any], b: BBox | None) -> dict[str, Any]:
    bb = _bbox(a, b)
    return baseline.baseline_store.assess(
        "global" if bb is None else "agent", await baseline.current_metrics(bb)
    )


def _store_scope(bbox: BBox | None) -> str:
    """The incident_store scope key for a bbox — mirrors routes.intel._scope_for so
    the agent reads the SAME history the watch loop and /watch endpoint write."""
    if bbox is None:
        return "global"
    d = bbox.as_dict()
    return (
        f"aoi:{round(d['min_lon'], 1)}:{round(d['min_lat'], 1)}:"
        f"{round(d['max_lon'], 1)}:{round(d['max_lat'], 1)}"
    )


async def _world_news() -> dict[str, Any]:
    """The current debiased world-news analysis. Reads the cache the background
    refresher keeps warm; only fetches+analyses if nothing is cached yet."""
    from app.config import get_settings  # noqa: PLC0415

    if not get_settings().news_enabled:
        return {"enabled": False, "note": "news engine disabled"}
    from app.news import store as news_store  # noqa: PLC0415

    cached = news_store.get_analysis()
    if cached is not None:
        return cached
    from app.routes import news as news_routes  # noqa: PLC0415

    return await news_routes.refresh_once()


def _compact_news(news: dict[str, Any], limit: int = 6) -> dict[str, Any]:
    """Shrink the news analysis to what the model needs: headline, neutral gist,
    corroboration, and the bias/propaganda flags — small enough to seed cheaply."""
    if not isinstance(news, dict) or news.get("enabled") is False:
        return {"enabled": False, "note": news.get("note") if isinstance(news, dict) else None}
    events = []
    for e in (news.get("events") or [])[:limit]:
        corro = e.get("corroboration") or {}
        events.append(
            {
                "title": e.get("title"),
                "summary": e.get("neutral_summary"),
                "sources": corro.get("source_count"),
                "bias_flags": (e.get("bias_flags") or [])[:3],
                "propaganda": (e.get("propaganda_techniques") or [])[:3],
                "confidence": e.get("confidence"),
            }
        )
    return {
        "generated": news.get("generated"),
        "source_count": news.get("source_count"),
        "article_count": news.get("article_count"),
        "events": events,
    }


async def _t_news(_a: dict[str, Any], _b: BBox | None) -> dict[str, Any]:
    return _compact_news(await _world_news(), limit=8)


async def _t_factcheck(a: dict[str, Any], _b: BBox | None) -> dict[str, Any]:
    claim = str(a.get("claim") or "").strip()
    if not claim:
        return {"error": "fact_check needs a 'claim' string arg"}
    from app.config import get_settings  # noqa: PLC0415

    if not get_settings().news_enabled:
        return {"enabled": False, "note": "news engine disabled"}
    from app.news import analyze as news_analyze  # noqa: PLC0415

    return await news_analyze.factcheck(claim)


async def _t_history(a: dict[str, Any], b: BBox | None) -> dict[str, Any]:
    hours = min(24.0, max(0.25, float(a.get("hours", 6) or 6)))
    scope = _store_scope(_bbox(a, b))
    res = incident_store.history(scope, hours * 3600.0)
    # AOI history only exists if someone polled /watch for it; the meaningful
    # timeline lives under "global" (the watch loop). Fall back honestly.
    if res.get("incident_count", 0) == 0 and scope != "global":
        res = {**incident_store.history("global", hours * 3600.0), "fallback": "global"}
    return res


async def _t_whats_changed(a: dict[str, Any], b: BBox | None) -> dict[str, Any]:
    bb = _bbox(a, b)
    scope = _store_scope(bb)
    if scope == "global":
        return incident_store.last_changes("global") or {
            "had_baseline": False,
            "note": "global watch loop has not ticked yet",
        }
    cur = await incidents.brief(bb)
    return incident_store.record(scope, cur.get("incidents") or [])


# name → (one-line description, real async fn). Args every geo tool accepts:
# {lat, lon, radius_nm} to scope (omit for global). Kept small + honest.
TOOLS: dict[str, tuple[str, ToolFn]] = {
    "get_situation": (
        "Global orienting counts (aircraft/vessels/jamming/emergencies). No args.",
        _t_situation,
    ),
    "intel_brief": (
        "Fused cross-domain incidents, ranked + cited. Args: lat,lon,radius_nm (omit=global).",
        _t_brief,
    ),
    "query_vessels": (
        "Vessels in an area. Args: lat,lon,radius_nm, dark_only(bool).",
        _t_vessels,
    ),
    "query_aircraft": (
        "Aircraft in an area. Args: lat,lon,radius_nm, category(airliner|military|...).",
        _t_aircraft,
    ),
    "lookup_aircraft": (
        "Identify ONE specific aircraft/flight by callsign (e.g. KLM589, BAW123), tail "
        "number, or ICAO24 hex. Returns registration, type, live position AND the flight "
        "ROUTE: departure + destination airport, distance-to-go, and ETA. THIS is the tool "
        "for any question about a named flight — where it departed, where it's going, when "
        "it lands. Args: ident(str).",
        _t_lookup_aircraft,
    ),
    "lookup_vessel": (
        "Identify ONE specific vessel by MMSI (9 digits): identity, latest fix, track, and "
        "incident membership. Use for any question about a named ship. Args: ident(str).",
        _t_lookup_vessel,
    ),
    "gps_jamming": (
        "GPS-jamming cells (degraded ADS-B). Args: lat,lon,radius_nm (omit=global).",
        _t_jamming,
    ),
    "anomalies": (
        "Emergencies, dark vessels, loiterers. Args: lat,lon,radius_nm (omit=global).",
        _t_anomalies,
    ),
    "detect_deception": (
        "AIS/ADS-B spoofing sweep. Args: lat,lon,radius_nm.",
        _t_deception,
    ),
    "locate_emitter": (
        "Estimate a GPS jammer location (CEP) from the degraded-ADS-B footprint. "
        "Args: lat,lon,radius_nm.",
        _t_emitter,
    ),
    "area_baseline": (
        "Is this area normal? z-scored vs a rolling baseline. Args: lat,lon,radius_nm.",
        _t_baseline,
    ),
    "world_news": (
        "Debiased cross-source world-news events with bias/propaganda flags — what "
        "the open-source press is reporting now. No args.",
        _t_news,
    ),
    "fact_check": (
        "Adjudicate one specific claim against the current headlines. Args: claim(str).",
        _t_factcheck,
    ),
    "incident_history": (
        "How incidents built up over a recent window (per-convergence timeline of "
        "level/score). Args: hours(0.25-24, default 6); lat,lon,radius_nm to scope.",
        _t_history,
    ),
    "whats_changed": (
        "What moved since the last watch tick — new/escalated/de-escalated/resolved "
        "incidents. Args: lat,lon,radius_nm (omit=global).",
        _t_whats_changed,
    ),
}

# ── write-back actions + app control (Track C6) ──────────────────────────────
# Two ADDITIVE tool families on top of the read-only TOOLS above:
#
#   • ACTION tools — governed write-back. Each dispatches through
#     ``intel/actions.dispatch`` (validate params → mutate the ontology → fire a
#     side effect → append an ``action_log`` audit row). The agent NEVER mutates
#     state any other way: every write is the SAME audited path the /api/actions
#     route uses. Requires a signed-in user (a UserCtx); keyless runs see the
#     tools but get a "sign-in required" observation instead of a mutation.
#
#   • CONTROL tools — drive the operator's client (camera / filter / selection)
#     by emitting a NEW ``app_var`` SSE event the loop forwards verbatim. These
#     do NOT touch the backend or the ontology — purely a view nudge.
#
# Both are surfaced to the model in the tool catalog, but they are dispatched on
# a separate path in the loop (not the read-only ``ToolFn`` signature), because
# an action needs the UserCtx + emits extra events (action / app_var).

# Action name → the one-line description the model sees. The param schema is the
# action's own Pydantic model (intel/actions.py), advertised via list_actions().
_ACTION_DESCRIPTIONS: dict[str, str] = {
    "flag_entity": (
        "Flag a specific object (an aircraft:<icao24>, vessel:<mmsi>, or "
        "incident:<id>) with an analyst note + severity 1-5. Args: target_id(str), "
        "note(str), severity(int 1-5). AUDITED write-back."
    ),
    "promote_incident": (
        "Promote an object to a tracked incident node in the ontology. Args: "
        "target_id(str), title(str), note(str). AUDITED write-back."
    ),
    "nominate_target": (
        "Add an object to the F2T2EA target board for tracking. Args: target_id(str), "
        "priority(int 1-5), note(str). AUDITED write-back."
    ),
    "add_watch": (
        "Create a standing geofence watch (alert rule) over an area. Args: "
        "target_id(str), label(str), lat, lon, radius_nm, kinds(list[str]), "
        "min_severity(int 1-5). AUDITED write-back."
    ),
}

# The action names the agent may invoke — exactly the registered ActionSpecs.
ACTION_TOOLS: frozenset[str] = frozenset(_ACTION_DESCRIPTIONS)

# Control tools — drive the client via an app_var event (no backend mutation).
CONTROL_TOOLS: dict[str, str] = {
    "control_view": (
        "Drive the operator's MAP to show what you found — no data change, just a "
        "view nudge. Args (all optional, send what's relevant): "
        'fly_to({"lat":..,"lon":..,"alt_m":..}) to slew the camera; '
        'select(object_id) to select+highlight one entity (an aircraft:/vessel:/'
        'incident: id); filter({"facet":"aircraftCategory|vesselType|altBucket|'
        'flag|squawk","value":"<bucket>","mode":"only|not"}) to focus the layer on '
        'a category, or filter({"clear":true}) to drop all filters. Use this to '
        "POINT the operator at the asset/area your analysis is about."
    ),
    "request_clarification": (
        "Ask the operator ONE focused question when the request is ambiguous and you "
        "cannot proceed safely (e.g. which of two flights, or confirm before a "
        "write-back). Args: question(str), options(list[str], optional). This STOPS "
        "the loop and hands control back to the operator — use sparingly."
    ),
}


_MAX_STEPS = 6
_WALL_BUDGET_S = 240.0
_OBS_CHARS = 1800


def _tool_catalog(*, with_actions: bool) -> str:
    """The tool menu shown to the model. Read-only tools always; the write-back
    actions + control tools are appended only when an authenticated user is
    present (``with_actions``) so a keyless run is never told it can mutate."""
    lines = [f"- {name}: {desc}" for name, (desc, _) in TOOLS.items()]
    lines += [f"- {name}: {desc}" for name, desc in CONTROL_TOOLS.items()]
    if with_actions:
        lines += [f"- {name}: {desc}" for name, desc in _ACTION_DESCRIPTIONS.items()]
        lines.append(
            "  (every AUDITED write-back also accepts an optional confidence(number "
            "0-1) — your confidence this action is correct; low/absent → the action "
            "is queued for operator approval rather than executed immediately.)"
        )
    return "\n".join(lines)


def _app_var_from_control(args: dict[str, Any]) -> dict[str, Any] | None:
    """Translate a ``control_view`` tool call into the payload of an ``app_var``
    SSE event the client consumes. Returns None if nothing actionable was asked.

    Shape (all keys optional): ``fly_to {lat,lon,alt_m?}`` · ``select <id>`` ·
    ``filter {facet,value,mode}`` | ``filter {clear:true}``. Everything is
    validated/clamped here so a hallucinated field can never reach the client as
    a crash — bad pieces are dropped, not raised.
    """
    out: dict[str, Any] = {}

    ft = args.get("fly_to")
    if isinstance(ft, dict):
        lat, lon = ft.get("lat"), ft.get("lon")
        try:
            if lat is not None and lon is not None:
                la, lo = float(lat), float(lon)
                if -90.0 <= la <= 90.0 and -180.0 <= lo <= 180.0:
                    fly: dict[str, Any] = {"lat": la, "lon": lo}
                    alt = ft.get("alt_m")
                    if alt is not None:
                        fly["alt_m"] = max(1000.0, min(float(alt), 40_000_000.0))
                    out["fly_to"] = fly
        except (TypeError, ValueError):
            pass

    sel = args.get("select")
    if isinstance(sel, str) and sel.strip():
        out["select"] = sel.strip()[:200]

    flt = args.get("filter")
    if isinstance(flt, dict):
        if flt.get("clear"):
            out["filter"] = {"clear": True}
        else:
            facet = flt.get("facet")
            value = flt.get("value")
            mode = flt.get("mode", "only")
            valid_facets = {
                "altBucket", "aircraftCategory", "vesselType", "flag", "squawk",
            }
            if (
                isinstance(facet, str)
                and facet in valid_facets
                and isinstance(value, str)
                and value.strip()
            ):
                out["filter"] = {
                    "facet": facet,
                    "value": value.strip()[:60],
                    "mode": "not" if mode == "not" else "only",
                }

    return out or None


_SYS = (
    "You are VELOCITY, an all-source intelligence analyst running a fast TOOL-GATHERING loop. "
    "You have live tools over real ADS-B/AIS/SAR/GPS-jamming/event data PLUS a debiased "
    "world-news desk and the incident history:\n"
    "{catalog}\n\n"
    "The fused incident brief, what-changed, and world-news you were seeded with are BACKGROUND "
    "context — NOT the operator's question. ANSWER THE OPERATOR'S ACTUAL QUESTION FIRST, with "
    "real numbers from a tool.\n\n"
    "PICK THE RIGHT TOOL FOR THE QUESTION:\n"
    "- Operator names a specific FLIGHT/aircraft — a callsign (e.g. KLM589, KL589, BAW123, "
    "UAL1), a tail number, or a 6-char ICAO24 hex → call lookup_aircraft{{\"ident\":\"<that>\"}}. "
    "A flight callsign is an AIRCRAFT; NEVER treat it as a vessel or a generic area sweep. Then "
    "report its route: departure airport, destination, distance-to-go, and ETA.\n"
    "- Operator names a specific SHIP — a 9-digit MMSI or ship name → call lookup_vessel.\n"
    "- Question is about an AREA or the overall picture → use the area tools "
    "(query_aircraft / query_vessels / gps_jamming / anomalies / intel_brief) scoped by "
    "lat,lon,radius_nm.\n"
    "- Drill into incidents (use a relevant incident centroid for lat/lon), locate emitters, or "
    "cross-check news ONLY when the question is about threats/incidents — not about one named "
    "asset.\n\n"
    "BESIDES the read-only tools you also have CONTROL + WRITE-BACK tools:\n"
    "- control_view — POINT the operator's map at what you found: fly the camera, select an "
    "entity, or filter the layer to a category. Call it once you know WHERE the answer is, so "
    "the operator sees it. This changes the VIEW only, never the data.\n"
    "- request_clarification — when the request is genuinely ambiguous (two matching flights, a "
    "destructive write-back you should confirm), ask ONE question and stop.\n"
    "- flag_entity / promote_incident / nominate_target / add_watch — AUDITED write-backs that "
    "change tracked state. Call these ONLY when the operator explicitly asks to flag / promote / "
    "nominate / watch something (verbs like 'flag', 'add to the target board', 'watch', "
    "'promote'). NEVER write back on a read-only question. Every write is logged with your "
    "user id. If the operator did not ask for a change, do NOT call them.\n\n"
    "On each turn reply with ONE JSON object, nothing else:\n"
    '  call a tool:    {{"action":"tool","thought":"<one line: why this tool now>",'
    '"say":"<1-2 plain sentences telling the operator what you see and what you are checking>",'
    '"tool":"<name>","args":{{...}}}}\n'
    '  stop gathering: {{"action":"done","thought":"<one line>",'
    '"say":"<2-3 plain sentences ANSWERING the operator with the real numbers you found>"}}\n\n'
    "Write `say` for a human reading along — narrate what you FOUND, do not just name the tool. "
    "If a lookup returns found=false, say so plainly and try ONE sensible variant of the ident "
    "(e.g. KLM589 → KL589) — do NOT pivot to unrelated incidents or invent a route. STOP within "
    "1-3 tool calls once you can answer. Never invent ids, routes, airports, or numbers — report "
    "only what a tool actually returned."
)

_SYNTH_SYS = (
    "You are VELOCITY, an all-source intelligence analyst. Given the operator's "
    "question and the REAL evidence gathered (the fused incident brief, the incident "
    "history, the world-news picture, and the tool observations), write the final "
    "assessment. Reply with ONLY a JSON object: "
    '{"assessment":"<3-6 sentence judgement that answers the question in plain language, '
    "states the situation, cites incident ids, and ties in any relevant world-news or "
    'history signal>",'
    '"findings":[{"id":"<incident id>","label":"<short>","threat":"high|elevated|low",'
    '"why":"<one line citing the evidence>"}],'
    '"recommended_detection":{"rule":"<plain-logic detection rule>","scope":"<area>"},'
    '"follow_up":["<concrete next analytic step>", ...]}. '
    "Cite ONLY incident ids that appear in the evidence. You MAY reference a world-news "
    "headline by its title. Never invent vessels, aircraft, ids, or numbers."
)


def _narrate_brief(
    brief: dict[str, Any],
    changes: dict[str, Any] | None,
    news: dict[str, Any] | None,
    scope: str,
) -> str:
    """A deterministic, human paragraph describing the situation — emitted on the
    seed so the operator always gets a readable orientation, no LLM required."""
    n = brief.get("incident_count", 0)
    lvl = brief.get("by_level") or {}
    lvl_str = ", ".join(f"{v} {k}" for k, v in lvl.items()) or "none active"
    sig = brief.get("signals_considered", "?")
    top = brief.get("top_threat_level") or "—"
    parts = [
        f"Scanning the {scope} picture across {sig} live signals: {n} active "
        f"convergence{'s' if n != 1 else ''} ({lvl_str}), top threat {top}."
    ]
    incs = brief.get("incidents") or []
    if incs:
        lead = incs[0]
        dom = " + ".join(lead.get("domains") or []) or "multi-domain"
        narr = str(lead.get("narrative") or "").strip()
        parts.append(
            f"Lead incident — {dom}: {narr[:180]}"
            if narr
            else f"Lead incident is a {dom} convergence."
        )
    if isinstance(changes, dict) and changes.get("had_baseline"):
        nn = len(changes.get("new") or [])
        ee = len(changes.get("escalated") or [])
        rr = len(changes.get("resolved") or [])
        if nn or ee or rr:
            parts.append(f"Since the last watch tick: {nn} new, {ee} escalated, {rr} resolved.")
    if isinstance(news, dict) and news.get("events"):
        head = news["events"][0]
        parts.append(f"World-news desk leads with: {head.get('title')}.")
    return " ".join(
        p.rstrip() + ("" if p.rstrip().endswith((".", "!", "?")) else ".")
        for p in parts
        if p.strip()
    )


def _scope_label(bbox: BBox | None) -> str:
    return "global" if bbox is None else "scoped AOI"


def _redact_tool_result(
    clearance: int, compartments: tuple[str, ...], result: Any
) -> Any:
    """Need-to-know seam: drop anything above the reader's clearance/compartments
    BEFORE a read-tool result reaches the LLM conversation or the SSE frame.

    GeoJSON FeatureCollections filter by ``properties.classification``; plain
    ``list[dict]`` rows filter by their top-level ``classification``. Every other
    shape passes through unchanged. Honest scope: live OSINT feeds
    (query_vessels/query_aircraft/gps_jamming) carry NO classification field, so
    this is a no-op on them (defense-in-depth + future-proof). The teeth land on
    the classified ontology-backed rows (intel_brief, lookups) that DO carry a
    level. This does NOT "secure the feeds" — it secures classified ontology rows.
    """
    if isinstance(result, dict) and isinstance(result.get("features"), list):
        return classification.redact_features(clearance, compartments, result)
    if isinstance(result, list):
        return classification.redact_for(clearance, compartments, result)
    return result


async def run_agent(
    q: str,
    bbox: BBox | None,
    ctx: UserCtx | None = None,
    clearance: int = 0,
    compartments: tuple[str, ...] = (),
) -> AsyncIterator[dict[str, Any]]:
    """Yield the live agent trace as events: thinking | tool_call | tool_result |
    action | app_var | clarification | final | error | done. The route serialises
    each as an SSE frame.

    ``ctx`` is the signed-in user (``keys.UserCtx``) when one resolved. It gates the
    AUDITED write-back tools: with a user, ``flag_entity`` & co. dispatch through
    ``intel/actions.dispatch`` (mutate + ``action_log`` row); without one the tools
    are hidden from the catalog and a stray call gets a "sign-in required"
    observation. The read-only tools + the control tools work either way.
    """
    t0 = time.monotonic()
    can_act = ctx is not None
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    backend: str | None = None
    model: str | None = None
    # Incidents seen across the run, for final-finding centroid enrichment.
    incident_index: dict[str, dict[str, Any]] = {}

    def _index(brief: dict[str, Any]) -> None:
        for inc in brief.get("incidents") or []:
            if inc.get("id"):
                incident_index[str(inc["id"])] = inc

    yield {"type": "start", "query": q, "scope": _scope_label(bbox)}

    # ── seed: run the fused brief (no LLM) so the loop starts grounded ──
    yield {
        "type": "tool_call", "step": 0, "tool": "intel_brief",
        "args": {"scope": _scope_label(bbox)},
        "thought": "Seed with the fused cross-domain picture before reasoning.",
    }
    seed_t = time.monotonic()
    brief = await incidents.brief(bbox)
    _index(brief)
    seed_summary = (
        f"{brief.get('incident_count', 0)} incidents · "
        f"top {brief.get('top_threat_level', '—')} · "
        f"{brief.get('signals_considered', '?')} signals"
    )
    yield {
        "type": "tool_result", "step": 0, "tool": "intel_brief",
        "ms": round((time.monotonic() - seed_t) * 1000),
        "summary": seed_summary,
    }

    # ── seed: scrub recent incident history (what moved since last tick) ──
    yield {
        "type": "tool_call", "step": 0, "tool": "whats_changed",
        "args": {"scope": "global"},
        "thought": "Scrub the incident history for what moved recently.",
    }
    ch_t = time.monotonic()
    changes = incident_store.last_changes("global") or {
        "had_baseline": False, "note": "watch loop has not ticked yet",
    }
    yield {
        "type": "tool_result", "step": 0, "tool": "whats_changed",
        "ms": round((time.monotonic() - ch_t) * 1000),
        "summary": _summarise("whats_changed", changes),
    }

    # ── seed: scrub the debiased world-news desk ──
    yield {
        "type": "tool_call", "step": 0, "tool": "world_news", "args": {},
        "thought": "Scrub the open-source news desk for context.",
    }
    nw_t = time.monotonic()
    try:
        news_compact = _compact_news(await _world_news(), limit=6)
    except Exception as exc:  # noqa: BLE001
        news_compact = {"error": f"{type(exc).__name__}: {exc}"}
    yield {
        "type": "tool_result", "step": 0, "tool": "world_news",
        "ms": round((time.monotonic() - nw_t) * 1000),
        "summary": _summarise("world_news", news_compact),
    }

    # A readable orientation paragraph the operator always gets, LLM or not.
    yield {"type": "narration", "step": 0,
           "text": _narrate_brief(brief, changes, news_compact, _scope_label(bbox))}

    messages: list[dict[str, str]] = [
        {"role": "system", "content": _SYS.format(catalog=_tool_catalog(with_actions=can_act))},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "question": q,
                    "scope": _scope_label(bbox),
                    "seed_brief": {
                        "incident_count": brief.get("incident_count"),
                        "by_level": brief.get("by_level"),
                        "top_threat_level": brief.get("top_threat_level"),
                        "incidents": [
                            {
                                "id": i.get("id"),
                                "threat_level": i.get("threat_level"),
                                "domains": i.get("domains"),
                                "signal_count": i.get("signal_count"),
                                "centroid": i.get("centroid"),
                                "narrative": i.get("narrative"),
                            }
                            for i in (brief.get("incidents") or [])[:8]
                        ],
                    },
                    "recent_changes": changes,
                    "world_news": news_compact,
                },
                ensure_ascii=False,
            ),
        },
    ]

    # ── gather loop: a FAST model drives quick tool calls (Claude-Code-style) ──
    evidence: list[str] = []
    for step in range(1, _MAX_STEPS + 1):
        if time.monotonic() - t0 > _WALL_BUDGET_S:
            yield {
                "type": "note",
                "text": "time budget reached — synthesising from evidence so far",
            }
            break
        yield {"type": "thinking", "step": step}
        parsed, res = await llm.chat_json(messages, max_tokens=700, fast=True)
        for k in usage:
            usage[k] += int((res.usage or {}).get(k, 0) or 0)

        if not res.ok or not isinstance(parsed, dict):
            yield {
                "type": "note", "step": step,
                "text": "gather step returned no action — moving to synthesis",
            }
            break

        if parsed.get("say"):
            yield {"type": "narration", "step": step, "text": str(parsed["say"])}

        action = parsed.get("action")
        if action == "done":
            if parsed.get("thought") and not parsed.get("say"):
                yield {"type": "note", "step": step, "text": str(parsed["thought"])}
            break

        if action == "tool":
            name = str(parsed.get("tool") or "")
            args = parsed.get("args") if isinstance(parsed.get("args"), dict) else {}
            thought = str(parsed.get("thought") or "")

            # ── control tools: drive the client, no backend mutation ──────────
            if name == "request_clarification":
                question = str(args.get("question") or "").strip()
                opts = args.get("options")
                options = [str(o) for o in opts][:6] if isinstance(opts, list) else []
                yield {
                    "type": "tool_call", "step": step, "tool": name,
                    "args": args, "thought": thought,
                }
                yield {
                    "type": "clarification", "step": step,
                    "question": question or "Could you clarify the request?",
                    "options": options,
                }
                # A clarification hands control back to the operator — end the run
                # here (no synthesis): the next message is the operator's answer.
                yield {
                    "type": "done", "backend": backend, "model": model, "usage": usage,
                    "latency_ms": round((time.monotonic() - t0) * 1000),
                    "incident_count": brief.get("incident_count"),
                    "signals_considered": brief.get("signals_considered"),
                    "scope": _scope_label(bbox), "awaiting_clarification": True,
                }
                return

            if name == "control_view":
                yield {
                    "type": "tool_call", "step": step, "tool": name,
                    "args": args, "thought": thought,
                }
                payload = _app_var_from_control(args)
                if payload is not None:
                    yield {"type": "app_var", "step": step, **payload}
                drove = [k for k in ("fly_to", "select", "filter") if payload and k in payload]
                summary = " · ".join(drove) if drove else "no-op (nothing to drive)"
                yield {
                    "type": "tool_result", "step": step, "tool": name,
                    "ms": 0, "summary": f"view → {summary}",
                }
                obs = {"applied": payload or {}}
                messages.append(
                    {"role": "user", "content": f"OBSERVATION ({name}): {json.dumps(obs)}"}
                )
                continue

            # ── write-back actions: dispatch through the AUDITED path ─────────
            if name in ACTION_TOOLS:
                yield {
                    "type": "tool_call", "step": step, "tool": name,
                    "args": args, "thought": thought,
                }
                if not can_act:
                    obs = {
                        "error": "sign-in required: write-back actions need an "
                        "authenticated user (the audit log records who acted)."
                    }
                    yield {
                        "type": "tool_result", "step": step, "tool": name,
                        "ms": 0, "summary": obs["error"],
                    }
                    messages.append(
                        {"role": "user", "content": f"OBSERVATION ({name}): {json.dumps(obs)}"}
                    )
                    continue
                # ── HITL gate: unless the model is confident enough to auto-run,
                # queue the write-back as a PROPOSAL for the operator to approve /
                # reject in AgentConsole (approval re-dispatches the SAME audited
                # path below). Default threshold 1.01 → always propose.
                from app.config import get_settings  # noqa: PLC0415
                from app.routes.actions import propose  # noqa: PLC0415

                _s = get_settings()
                confidence = float(args.pop("confidence", 0.0) or 0.0)
                if _s.action_approval and confidence < _s.action_auto_threshold:
                    pid = propose(name, args, ctx, confidence=confidence)
                    yield {
                        "type": "action_proposal", "step": step,
                        "proposal_id": pid, "action": name,
                        "params": args, "confidence": confidence,
                    }
                    obs = {
                        "queued": True, "proposal_id": pid,
                        "note": "action queued for operator approval; do not retry",
                    }
                    yield {
                        "type": "tool_result", "step": step, "tool": name,
                        "ms": 0, "summary": f"{name} queued for approval ({pid})",
                    }
                    messages.append(
                        {"role": "user", "content": f"OBSERVATION ({name}): {json.dumps(obs)}"}
                    )
                    continue
                tt = time.monotonic()
                try:
                    # ctx is non-None here (can_act); dispatch validates params,
                    # mutates the ontology, fires the side effect, and appends the
                    # action_log audit row — the SAME path /api/actions uses.
                    receipt = await actions.dispatch(name, args, ctx)  # type: ignore[arg-type]
                    ms = round((time.monotonic() - tt) * 1000)
                    yield {
                        "type": "action", "step": step, "action": name,
                        "target_id": receipt.target_id, "ok": True,
                        "audit": receipt.audit, "detail": receipt.detail,
                    }
                    yield {
                        "type": "tool_result", "step": step, "tool": name,
                        "ms": ms, "summary": f"{name} ✓ {receipt.target_id}",
                    }
                    obs = {"ok": True, "action": name, "target_id": receipt.target_id}
                    messages.append(
                        {"role": "user", "content": f"OBSERVATION ({name}): {json.dumps(obs)}"}
                    )
                    evidence.append(f"{name}({json.dumps(args)}) → {json.dumps(obs)}")
                except Exception as exc:  # noqa: BLE001
                    # A 400/404/502/503 (bad params / store down) is reported back to
                    # the model as an observation; never crash the stream.
                    detail = getattr(exc, "detail", None)
                    msg = str(detail) if detail is not None else f"{type(exc).__name__}: {exc}"
                    yield {
                        "type": "action", "step": step, "action": name, "ok": False,
                        "error": msg,
                    }
                    yield {
                        "type": "tool_result", "step": step, "tool": name,
                        "ms": round((time.monotonic() - tt) * 1000),
                        "summary": f"{name} failed: {msg}"[:160],
                    }
                    err_obs = json.dumps({"error": msg})
                    messages.append(
                        {"role": "user", "content": f"OBSERVATION ({name}): {err_obs}"}
                    )
                continue

            tool = TOOLS.get(name)
            if tool is None:
                valid = list(TOOLS) + list(CONTROL_TOOLS) + (
                    list(ACTION_TOOLS) if can_act else []
                )
                obs = {"error": f"unknown tool '{name}'. Valid: {valid}"}
                yield {
                    "type": "tool_call", "step": step, "tool": name,
                    "args": args, "thought": thought,
                }
                yield {
                    "type": "tool_result", "step": step, "tool": name,
                    "ms": 0, "summary": obs["error"],
                }
                messages.append(
                    {"role": "user", "content": f"OBSERVATION ({name}): {json.dumps(obs)}"}
                )
                continue
            yield {
                "type": "tool_call", "step": step, "tool": name,
                "args": args, "thought": thought,
            }
            tt = time.monotonic()
            try:
                result = await tool[1](args, bbox)
            except Exception as exc:  # noqa: BLE001
                result = {"error": f"{type(exc).__name__}: {exc}"}
            # Need-to-know: redact above the reader's clearance BEFORE the result
            # reaches the LLM or the SSE frame (no-op on unclassified live feeds).
            result = _redact_tool_result(clearance, compartments, result)
            if name == "intel_brief" and isinstance(result, dict):
                _index(result)
            ms = round((time.monotonic() - tt) * 1000)
            summary = _summarise(name, result)
            yield {"type": "tool_result", "step": step, "tool": name, "ms": ms, "summary": summary}
            obs_text = json.dumps(result, ensure_ascii=False)[:_OBS_CHARS]
            messages.append({"role": "user", "content": f"OBSERVATION ({name}): {obs_text}"})
            evidence.append(f"{name}({json.dumps(args)}) → {obs_text}")
            continue

        messages.append(
            {"role": "user", "content": 'Reply now with {"action":"done","thought":"..."}.'}
        )

    # ── synthesis: MiniMax-M3 (reasoning) judges the gathered evidence ──
    yield {"type": "synthesizing"}
    seed_incidents = [
        {"id": i.get("id"), "threat_level": i.get("threat_level"), "domains": i.get("domains"),
         "narrative": i.get("narrative")}
        for i in (brief.get("incidents") or [])[:8]
    ]
    synth_user = json.dumps(
        {
            "question": q,
            "scope": _scope_label(bbox),
            "seed_incidents": seed_incidents,
            "recent_changes": changes,
            "world_news": news_compact,
            "observations": evidence,
        },
        ensure_ascii=False,
    )
    parsed_f, res_f = await llm.chat_json(
        [{"role": "system", "content": _SYNTH_SYS}, {"role": "user", "content": synth_user}],
        tier="reason",
        max_tokens=1600,
        timeout_s=90.0,
    )
    backend = res_f.backend or backend
    model = res_f.model or model
    for k in usage:
        usage[k] += int((res_f.usage or {}).get(k, 0) or 0)

    if res_f.ok and isinstance(parsed_f, dict):
        final = parsed_f
    else:
        top = (brief.get("incidents") or [])[:6]
        final = {
            "assessment": (top[0].get("narrative") if top else "No active convergences in scope."),
            "findings": [
                {
                    "id": i.get("id"),
                    "label": " + ".join(i.get("domains") or []) or "convergence",
                    "threat": i.get("threat_level"),
                    "why": (str(i.get("narrative") or ""))[:160],
                }
                for i in top
            ],
            "recommended_detection": None,
            "follow_up": [],
            "_derived": True,
        }

    findings = _enrich(final.get("findings") or [], incident_index)
    yield {
        "type": "final",
        "assessment": final.get("assessment"),
        "findings": findings,
        "recommended_detection": final.get("recommended_detection"),
        "follow_up": final.get("follow_up") or [],
        "derived": bool(final.get("_derived")),
        # The need-to-know level this run executed at (keyless ⇒ UNCLASSIFIED).
        "operated_at_clearance": classification.marking(clearance, compartments),
    }
    yield {
        "type": "done",
        "backend": backend,
        "model": model,
        "usage": usage,
        "latency_ms": round((time.monotonic() - t0) * 1000),
        "incident_count": brief.get("incident_count"),
        "signals_considered": brief.get("signals_considered"),
        "scope": _scope_label(bbox),
    }


def _enrich(findings: list[Any], index: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for f in findings:
        if not isinstance(f, dict):
            continue
        inc = index.get(str(f.get("id")))
        if inc is None:
            continue
        domains = inc.get("domains") or []
        out.append(
            {
                "id": inc.get("id"),
                "label": f.get("label") or (" + ".join(domains) if domains else "convergence"),
                "threat": f.get("threat") or inc.get("threat_level"),
                "why": f.get("why") or (str(inc.get("narrative") or ""))[:180],
                "centroid": inc.get("centroid"),
                "domains": domains,
            }
        )
    return out


def _summarise(name: str, result: dict[str, Any]) -> str:
    """A one-line human summary of a tool result for the live trace."""
    if not isinstance(result, dict):
        return str(result)[:120]
    if "error" in result:
        return str(result["error"])[:160]
    if name == "intel_brief":
        return (
            f"{result.get('incident_count', 0)} incidents · "
            f"top {result.get('top_threat_level', '—')}"
        )
    if name == "get_situation":
        return (
            f"{result.get('aircraft', '?')} ac · {result.get('vessels', '?')} vessels · "
            f"{result.get('jamming_cells', result.get('gnss_degraded', '?'))} jamming"
        )
    if name in ("query_vessels", "query_aircraft"):
        return f"{result.get('count', result.get('total', '?'))} matches" + (
            f" · {result.get('dark', 0)} dark" if result.get("dark") else ""
        )
    if name == "gps_jamming":
        return f"{result.get('cell_count', result.get('count', '?'))} jamming cells"
    if name == "locate_emitter":
        est = result.get("estimate") or result
        cep = est.get("cep_km") if isinstance(est, dict) else None
        return (
            f"emitter ~{est.get('lat', '?')},{est.get('lon', '?')} · CEP {cep} km"
            if cep is not None
            else "no emitter estimate"
        )
    if name == "detect_deception":
        return f"{result.get('count', len(result.get('suspects', []) or []))} deception suspects"
    if name == "anomalies":
        return (
            f"{len(result.get('emergencies', []) or [])} emerg · "
            f"{len(result.get('dark_vessels', []) or [])} dark · "
            f"{len(result.get('loiter', []) or [])} loiter"
        )
    if name == "area_baseline":
        return str(result.get("assessment") or result.get("summary") or "baseline assessed")[:140]
    if name == "world_news":
        if result.get("enabled") is False:
            return "news engine disabled"
        evs = result.get("events") or []
        return f"{len(evs)} world events · {result.get('source_count', '?')} sources"
    if name == "fact_check":
        return f"{result.get('verdict', '?')} · conf {result.get('confidence', '?')}"
    if name == "incident_history":
        tag = " (global fallback)" if result.get("fallback") == "global" else ""
        return (
            f"{result.get('incident_count', 0)} tracked · "
            f"{result.get('snapshots', 0)} snaps · {result.get('window_hours', '?')}h{tag}"
        )
    if name == "whats_changed":
        if not result.get("had_baseline"):
            return str(result.get("note") or "no baseline yet")[:120]
        return (
            f"{len(result.get('new') or [])} new · {len(result.get('escalated') or [])} esc · "
            f"{len(result.get('resolved') or [])} resolved"
        )
    # generic
    keys = [k for k in ("count", "total", "incident_count") if k in result]
    return f"{result[keys[0]]} {keys[0]}" if keys else "ok"
