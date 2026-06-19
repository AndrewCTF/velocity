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
from app.intel import analytics, baseline, deception, emitter, incidents
from app.intel.geo import BBox, bbox_from_radius
from app.intel.incident_store import incident_store

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

_MAX_STEPS = 6
_WALL_BUDGET_S = 240.0
_OBS_CHARS = 1800


def _tool_catalog() -> str:
    return "\n".join(f"- {name}: {desc}" for name, (desc, _) in TOOLS.items())


_SYS = (
    "You are VELOCITY, an all-source intelligence analyst running a fast TOOL-GATHERING loop. "
    "You have live tools over real ADS-B/AIS/SAR/GPS-jamming/event data PLUS a debiased "
    "world-news desk and the incident history:\n"
    "{catalog}\n\n"
    "You are seeded with the fused incident brief, what changed since the last watch tick, "
    "and the current world-news picture. On each turn reply with ONE JSON object, nothing else:\n"
    '  call a tool:    {{"action":"tool","thought":"<one line: why this tool now>",'
    '"say":"<1-2 plain sentences telling the operator what you see and what you are checking>",'
    '"tool":"<name>","args":{{...}}}}\n'
    '  stop gathering: {{"action":"done","thought":"<one line>",'
    '"say":"<2-3 plain sentences summarising what the evidence shows>"}}\n\n'
    "Write the `say` field for a human reading along — narrate the situation, do not just name "
    "the tool. Call a tool ONLY to add evidence the seed lacks: drill into an incident's "
    "lat/lon, locate an emitter, confirm dark vessels under jamming, read how a convergence "
    "built up over time (incident_history), or cross-check a reported event against the live "
    "geospatial picture (world_news / fact_check). Use the centroid of a relevant incident for "
    "lat/lon. STOP within 1-3 tool calls once you can answer. Never invent ids or numbers."
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
        parts.append(f"Lead incident — {dom}: {narr[:180]}" if narr else f"Lead incident is a {dom} convergence.")
    if isinstance(changes, dict) and changes.get("had_baseline"):
        nn = len(changes.get("new") or [])
        ee = len(changes.get("escalated") or [])
        rr = len(changes.get("resolved") or [])
        if nn or ee or rr:
            parts.append(f"Since the last watch tick: {nn} new, {ee} escalated, {rr} resolved.")
    if isinstance(news, dict) and news.get("events"):
        head = news["events"][0]
        parts.append(f"World-news desk leads with: {head.get('title')}.")
    return " ".join(p.rstrip() + ("" if p.rstrip().endswith((".", "!", "?")) else ".") for p in parts if p.strip())


def _scope_label(bbox: BBox | None) -> str:
    return "global" if bbox is None else "scoped AOI"


async def run_agent(q: str, bbox: BBox | None) -> AsyncIterator[dict[str, Any]]:
    """Yield the live agent trace as events: thinking | tool_call | tool_result |
    final | error | done. The route serialises each as an SSE frame."""
    t0 = time.monotonic()
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
        {"role": "system", "content": _SYS.format(catalog=_tool_catalog())},
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
            tool = TOOLS.get(name)
            if tool is None:
                obs = {"error": f"unknown tool '{name}'. Valid: {list(TOOLS)}"}
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
        timeout_s=160.0,
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
