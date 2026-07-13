"""POST /api/ai/selection/brief — Gotham-style selection-inference AI
assessment for whatever entity is selected on the globe (design doc "NEW:
Gotham-style selection inference").

Runs the small, fast selection-tier model (``llm.chat(tier="selection")`` —
resolves to the manager's active "selection"-role model on the local engine,
falling back to plain fast-tier behavior when unconfigured, per app.llm's
``_run_chat``) over a compact system+user prompt built from the selected
entity's kind/id/props. Same ``current_user_or_local`` keyless discipline as
the rest of the local-AI routes; rate-limited with the rest of the compute
surface (``/api/ai/selection`` is already in ``app.ratelimit._COMPUTE_PREFIXES``).

Cached 60s per ``(kind, id)`` in-process (reusing ``app.upstream``'s shared
TTL cache — an entity re-clicked within the same minute gets the same brief
without a second model call); the caller sees ``cached: true`` on a hit.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import llm, upstream
from app.config import get_settings
from app.keys import UserCtx, current_user_or_local

router = APIRouter(tags=["ai-selection"])

_CACHE_TTL_S = 60.0
_MAX_PROPS_BYTES = 4096
_MAX_STRING_LEN = 500
# Hard ceiling on how long the enrichment fusion may take before the brief
# gives up and runs on the raw props alone. The registry/route/reverse-geo
# upstreams are all cached (and usually already warm — EntityPanel fires the
# same /api/entity enrichment on the same selection), so the common path is a
# few ms of cache reads; this only caps a cold-cache tail (e.g. an adsbdb route
# lookup) so a slow upstream never delays the assessment.
_CONTEXT_TIMEOUT_S = 4.0
# Keep the fused context compact so the small, fast selection-tier model isn't
# swamped — a long narrative field would crowd out the reasoning budget.
_MAX_CONTEXT_STRING = 240
# Floor is well above the 3-6 sentence answer this brief actually needs — a
# reasoning-tier local model (Qwen3 family etc.) spends some of its budget on
# a thinking preamble even with `chat_template_kwargs.enable_thinking: false`
# sent (see app.llm._llamacpp_chat/_vllm_chat), so 300 wasn't enough headroom
# to survive that preamble and still answer; 768 leaves room for both the
# preamble and the longer structured markdown brief.
_MAX_TOKENS = 768


class BriefIn(BaseModel):
    kind: str = Field(min_length=1, max_length=64)
    id: str = Field(min_length=1, max_length=256)
    props: dict[str, Any] = Field(default_factory=dict)


def _clamp_props(props: dict[str, Any]) -> dict[str, Any]:
    """Truncate any individual string field so one giant value can't dominate
    the prompt even when the serialized whole is under the byte cap. The byte
    cap below is the hard boundary (413); this is a best-effort shrink."""
    out: dict[str, Any] = {}
    for k, v in props.items():
        if isinstance(v, str) and len(v) > _MAX_STRING_LEN:
            out[k] = v[:_MAX_STRING_LEN] + "…"
        else:
            out[k] = v
    return out


def _clip(v: Any) -> Any:
    """Best-effort shrink of one context value so a long narrative can't crowd
    the small selection model's budget."""
    if isinstance(v, str) and len(v) > _MAX_CONTEXT_STRING:
        return v[:_MAX_CONTEXT_STRING] + "…"
    return v


def _compact(d: dict[str, Any]) -> dict[str, Any]:
    """Drop null/empty values and clip strings — only high-signal fields survive."""
    out: dict[str, Any] = {}
    for k, v in d.items():
        if v is None or v == "" or v == [] or v == {}:
            continue
        out[k] = _clip(v)
    return out


def _airport_label(ap: Any) -> str | None:
    if not isinstance(ap, dict):
        return None
    code = ap.get("iata") or ap.get("icao")
    name = ap.get("municipality") or ap.get("name")
    if code and name:
        return f"{code} ({name})"
    return code or name


def _aircraft_context(enrich: Any, dossier: Any) -> dict[str, Any]:
    """Pluck the high-signal fields from the registry+route enrichment and the
    pattern-of-life dossier for an aircraft. Both inputs may be an Exception
    (asyncio.gather return_exceptions) or a degraded/empty dict — handled."""
    ctx: dict[str, Any] = {}
    if isinstance(enrich, dict):
        ctx.update({
            "registration": enrich.get("registration"),
            "aircraft_type": enrich.get("type") or enrich.get("icao_type"),
            "operator": enrich.get("operator"),
            "manufacturer": enrich.get("manufacturer"),
            "reg_country": enrich.get("country_origin"),
            "airline": enrich.get("route_airline"),
        })
        origin = _airport_label(enrich.get("origin"))
        dest = _airport_label(enrich.get("destination"))
        if origin or dest:
            ctx["flight_route"] = f"{origin or '?'} → {dest or '?'}"
    if isinstance(dossier, dict) and dossier.get("found"):
        track = dossier.get("track") or {}
        ctx.update({
            "track_profile": track.get("profile"),
            "track_speed_kn": track.get("speed_kn"),
            "track_gaps": track.get("gap_count") or None,
            "gnss_degraded": dossier.get("gnss_degraded") or None,
            "military": True if dossier.get("source") == "adsb_mil" else None,
            "pattern_assessment": dossier.get("assessment"),
        })
        sq = str(dossier.get("squawk") or "")
        if sq in ("7500", "7600", "7700"):
            ctx["emergency_squawk"] = sq
        inc = dossier.get("in_incidents") or []
        if inc:
            ctx["live_incidents"] = [
                {"threat_level": i.get("threat_level"), "narrative": i.get("narrative")}
                for i in inc[:3]
            ]
    return _compact(ctx)


def _vessel_context(enrich: Any, dossier: Any) -> dict[str, Any]:
    """Pluck the high-signal fields from the MMSI/flag/reverse-geo/GFW
    enrichment and the pattern-of-life dossier for a vessel."""
    ctx: dict[str, Any] = {}
    if isinstance(enrich, dict):
        ctx.update({
            "vessel_name": enrich.get("name"),
            "flag": enrich.get("flag") or enrich.get("flag_country"),
            "imo": enrich.get("imo"),
            "vessel_type": enrich.get("vessel_type") or enrich.get("gear_type"),
            "length_m": enrich.get("length_m"),
            "nearest_place": enrich.get("nearest_port"),
        })
        dist = enrich.get("nearest_port_distance_km")
        if isinstance(dist, (int, float)):
            ctx["nearest_place_km"] = dist
    if isinstance(dossier, dict) and dossier.get("found"):
        track = dossier.get("track") or {}
        ctx.update({
            "category": dossier.get("category"),
            "track_profile": track.get("profile"),
            "track_speed_kn": track.get("speed_kn"),
            "ais_gaps": track.get("gap_count") or None,
            "pattern_assessment": dossier.get("assessment"),
        })
        ident = dossier.get("identity") or {}
        aka = ident.get("mmsi_history") or []
        if len(aka) > 1:
            ctx["mmsi_history"] = aka
        inc = dossier.get("in_incidents") or []
        if inc:
            ctx["live_incidents"] = [
                {"threat_level": i.get("threat_level"), "narrative": i.get("narrative")}
                for i in inc[:3]
            ]
    return _compact(ctx)


# Keys carrying photo/wiki/link/list blobs that add prompt weight without
# grounding an assessment — dropped from the static-kind enrichment.
_HEAVY_KEYS = frozenset({
    "kind", "url", "thumb_url", "photo_url", "image", "photos", "extract",
    "summary", "wikipedia_url", "wikidata_url", "liveatc_url",
    "candidate_mounts", "candidate_mounts_best_effort", "runways", "frequencies",
})


def _static_context(enrich: Any) -> dict[str, Any]:
    """Compact context for a fixed entity (quake / airport / port / facility /
    satellite): keep only scalar fields, dropping list/dict blobs (runways,
    frequencies, photos) and known photo/link keys so the prompt stays small."""
    if not isinstance(enrich, dict):
        return {}
    picked = {
        k: v
        for k, v in enrich.items()
        if k not in _HEAVY_KEYS and not isinstance(v, (list, dict))
    }
    return _compact(picked)


async def _gather_context(
    kind: str, eid: str, props: dict[str, Any]
) -> tuple[dict[str, Any], str]:
    """Fuse the platform's existing enrichment substrate for the selected entity
    so the brief is grounded in registry identity, flight route, flag state,
    reverse-geocoded location, pattern-of-life and live incident membership —
    not just the ~6 self-reported fields the client sends.

    Reuses the same enrichment the EntityPanel already fetches (routes.entity's
    ``_enrich_aircraft``/``_enrich_vessel``, all cached) plus the dossier
    (intel.dossier, local store + positions DB). Every layer is best-effort:
    any failure yields thinner context, never an error, so the brief always
    still runs on the raw props alone.

    Returns ``(context, status)`` where status reports enrichment health so the
    caller can tell a genuinely thin brief from a degraded one:
    - ``"full"``    — every attempted source returned;
    - ``"partial"`` — at least one attempted source failed;
    - ``"skipped"`` — nothing attempted (no enrichment path for the kind, or an
      id that doesn't resolve to a real identifier).
    """
    # The globe sends the entity id as "<kind>:<raw>" (e.g. "aircraft:a1b2c3");
    # recover the bare registry identifier. Some callers pass a bare id — accept
    # both. The kind field is authoritative for dispatch.
    raw = eid.split(":", 1)[1].strip() if ":" in eid else eid.strip()
    k = kind.strip().lower()
    # Imported lazily so this route module doesn't hard-depend on the entity
    # route (and to keep import order simple); both are cheap module lookups.
    from app.intel.dossier import aircraft_dossier, vessel_dossier
    from app.routes.entity import (
        AIRPORT_CODE_RE,
        ICAO24_RE,
        MMSI_RE,
        PORT_WPI_RE,
        QUAKE_ID_RE,
        SAT_NORAD_RE,
        SAT_TAIL_RE,
        _enrich_aircraft,
        _enrich_airport,
        _enrich_facility,
        _enrich_port,
        _enrich_quake,
        _enrich_satellite,
        _enrich_vessel,
    )

    def _pair_status(*results: Any) -> str:
        return "partial" if any(isinstance(r, BaseException) for r in results) else "full"

    try:
        if k == "aircraft" and ICAO24_RE.match(raw):
            callsign = props.get("callsign")
            callsign = callsign if isinstance(callsign, str) else None
            enrich, dossier = await asyncio.gather(
                _enrich_aircraft(raw, callsign),
                aircraft_dossier(raw),
                return_exceptions=True,
            )
            return _aircraft_context(enrich, dossier), _pair_status(enrich, dossier)
        if k == "vessel" and MMSI_RE.match(raw):
            enrich, dossier = await asyncio.gather(
                _enrich_vessel(raw, get_settings()),
                vessel_dossier(raw),
                return_exceptions=True,
            )
            return _vessel_context(enrich, dossier), _pair_status(enrich, dossier)
        # Fixed entities — a single cached local/registry lookup, no dossier.
        if k == "quake" and QUAKE_ID_RE.match(raw):
            return _static_context(await _enrich_quake(raw)), "full"
        if k == "airport" and AIRPORT_CODE_RE.match(raw):
            return _static_context(await _enrich_airport(raw)), "full"
        if k == "port" and PORT_WPI_RE.match(raw):
            return _static_context(await _enrich_port(raw)), "full"
        if k in ("facility", "military"):
            return _static_context(_enrich_facility(k, raw)), "full"
        if k == "satellite" and SAT_NORAD_RE.match(raw):
            return _static_context(await _enrich_satellite(raw)), "full"
        # A globe-clicked satellite id carries its layer descriptor as the head
        # and the NORAD id in a ":sat:<id>" tail — recover it (mirrors the
        # entity route's own fallback).
        tail = SAT_TAIL_RE.search(eid)
        if tail:
            return _static_context(await _enrich_satellite(tail.group(1))), "full"
    except Exception:  # noqa: BLE001 — enrichment is additive; never break the brief
        # An attempted source blew up outside the gather's return_exceptions
        # net (static-kind lookup, or setup after dispatch matched).
        return {}, "partial"
    return {}, "skipped"


async def _safe_context(
    kind: str, eid: str, props: dict[str, Any]
) -> tuple[dict[str, Any], str]:
    """`_gather_context` under a hard timeout; on timeout or any error the
    brief runs on the raw props alone and the status reports "skipped"."""
    try:
        return await asyncio.wait_for(
            _gather_context(kind, eid, props), timeout=_CONTEXT_TIMEOUT_S
        )
    except Exception:  # noqa: BLE001 — timeout or any enrichment failure → no context
        return {}, "skipped"


@router.post("/api/ai/selection/brief")
async def post_selection_brief(
    body: BriefIn, _ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    if not llm.selection_enabled():
        raise HTTPException(status_code=409, detail="selection inference is disabled")

    serialized = json.dumps(body.props, default=str)
    if len(serialized.encode("utf-8")) > _MAX_PROPS_BYTES:
        raise HTTPException(
            status_code=413, detail=f"props too large (max {_MAX_PROPS_BYTES} bytes serialized)"
        )

    # Key on a hash of the props too, not just (kind, id): the same entity
    # re-clicked within 60s can carry changed props (new position, altitude,
    # status), and keying on identity alone would serve a stale brief as
    # cached:true. `serialized` is the exact props payload used to build the
    # prompt, so its digest tracks every input the brief depends on.
    props_hash = hashlib.sha1(serialized.encode("utf-8")).hexdigest()[:16]
    cache_key = f"selection-brief:{body.kind}:{body.id}:{props_hash}"
    computed = False

    async def _load() -> dict[str, Any]:
        nonlocal computed
        computed = True
        props_json = json.dumps(_clamp_props(body.props), default=str, separators=(",", ":"))
        context, enrichment_status = await _safe_context(body.kind, body.id, body.props)
        system = (
            "You are a senior OSINT watch analyst briefing a watch floor. "
            f"Write 3-6 sentences of markdown about this {body.kind} (bold key "
            "identifiers), in this order: what it is; what it is doing now "
            "(position, track, speed from the live fields); anomalies or "
            "notable pattern-of-life from the ENRICHMENT block when present; "
            "end with a one-line assessment. Ground every claim in the data "
            "provided. If nothing stands out, say 'no anomalies evident' — "
            "never invent one, and never speculate about intent. If the "
            "enrichment conflicts with the live data, say so."
        )
        user = f"{body.kind} {body.id}:\n{props_json}"
        if context:
            context_json = json.dumps(context, default=str, separators=(",", ":"))
            user += f"\n\nENRICHMENT:\n{context_json}"
        started = time.monotonic()
        res = await llm.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            tier="selection",
            max_tokens=_MAX_TOKENS,
            label="ai.selection_brief",
        )
        latency_ms = round((time.monotonic() - started) * 1000)
        if not res.ok:
            raise HTTPException(status_code=502, detail=res.error or "selection brief failed")
        return {
            "ok": True,
            "text": res.text,
            "model": res.model,
            "backend": res.backend,
            "latency_ms": latency_ms,
            # Enrichment-fusion health for this brief — "full" | "partial" |
            # "skipped" — so the frontend can tell a genuinely thin brief from
            # a degraded one. Cached hits keep the status they were built with.
            "enrichment": enrichment_status,
        }

    payload = await upstream.cache.get_or_fetch(cache_key, _CACHE_TTL_S, _load)
    return {**payload, "cached": not computed}
