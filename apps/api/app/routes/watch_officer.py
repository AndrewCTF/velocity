"""Watch-officer briefs — /api/watch-officer/*.

Read + triage the draft briefs the ``intel.watch_officer`` loop files. Keyless,
like ``/api/alerts`` — this is a personal analyst surface reading in-process state,
and gating it behind ``current_user`` would 401 whenever Supabase is unset (the
standing-detections trap). The briefs are derived from public fusion output; there
is nothing user-scoped to protect here.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app import llm, upstream
from app.intel import watch_officer
from app.keys import UserCtx, current_user_or_local

router = APIRouter(tags=["watch-officer"])

# Deeper AI write-up of a filed brief. Cached per brief id — briefs are immutable
# once filed, so an elaboration never needs recomputing (a re-file after escalation
# gets a fresh id, so it re-elaborates). Longer than the selection-brief TTL since
# the input can't drift.
_ELABORATE_TTL_S = 900.0
_ELABORATE_MAX_TOKENS = 512


@router.get("/api/watch-officer/status")
async def wo_status() -> dict[str, Any]:
    """Live telemetry — is the officer running, its cadence, sweep/brief counts,
    and the playbooks it can fire. Lets the UI prove the agent is alive."""
    return watch_officer.status()


@router.get("/api/watch-officer/briefs")
async def briefs() -> dict[str, Any]:
    """Open draft briefs the watch-officer has filed, newest first."""
    return {"briefs": watch_officer.list_briefs()}


@router.post("/api/watch-officer/briefs/{bid}/dismiss")
async def dismiss_brief(bid: str) -> dict[str, Any]:
    """Drop a brief as noise. 404 if unknown/expired."""
    if not watch_officer.dismiss(bid):
        raise HTTPException(status_code=404, detail="unknown brief")
    return {"ok": True, "id": bid}


@router.post("/api/watch-officer/briefs/{bid}/ack")
async def ack_brief(bid: str) -> dict[str, Any]:
    """Acknowledge a brief (operator saw the finding). 404 if unknown/expired."""
    if not watch_officer.ack(bid):
        raise HTTPException(status_code=404, detail="unknown brief")
    return {"ok": True, "id": bid}


def _elaborate_prompt(brief: dict[str, Any]) -> tuple[str, str]:
    """Grounded system+user prompt for a deeper analytic write-up of one brief."""
    system = (
        "You are a senior OSINT watch analyst. You are handed a watch-officer "
        "brief: a fused, cited convergence of live signals the automated loop "
        "flagged. Write 3-5 sentences of markdown that go DEEPER than the "
        "one-line narrative: (1) what this convergence most likely represents; "
        "(2) why — grounded in the specific evidence rows (cite the ids, "
        "distances, gaps); (3) what would confirm or refute it; (4) the single "
        "most useful next action. Ground every claim in the brief — never "
        "invent ids, positions, or events, and never overstate intent. End "
        "with a bold **Confidence: low | medium | high** reflecting how much "
        "the evidence supports the read."
    )
    payload = {
        "title": brief.get("title"),
        "threat_level": brief.get("threat_level"),
        "domains": brief.get("domains"),
        "centroid": brief.get("centroid"),
        "narrative": brief.get("narrative"),
        "evidence": brief.get("evidence"),
        "follow_up": brief.get("follow_up"),
        "playbook": brief.get("playbook"),
    }
    user = json.dumps(payload, default=str, separators=(",", ":"))[:4000]
    return system, user


@router.post("/api/watch-officer/briefs/{bid}/elaborate")
async def elaborate_brief(
    bid: str, _ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    """Deeper AI assessment of one brief, grounded in its evidence chain. Cached
    per brief id. 404 if the brief is unknown/expired; 409 if selection inference
    is disabled (same gate as the selection brief); 502 if the model fails."""
    brief = watch_officer.get_brief(bid)
    if brief is None:
        raise HTTPException(status_code=404, detail="unknown brief")
    if not llm.selection_enabled():
        raise HTTPException(status_code=409, detail="selection inference is disabled")

    cache_key = f"wo-elaborate:{bid}"
    computed = False

    async def _load() -> dict[str, Any]:
        nonlocal computed
        computed = True
        system, user = _elaborate_prompt(brief)
        res = await llm.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            tier="selection",
            max_tokens=_ELABORATE_MAX_TOKENS,
            label="watch_officer.elaborate",
        )
        if not res.ok:
            raise HTTPException(status_code=502, detail=res.error or "elaboration failed")
        return {"ok": True, "id": bid, "text": res.text, "model": res.model, "backend": res.backend}

    payload = await upstream.cache.get_or_fetch(cache_key, _ELABORATE_TTL_S, _load)
    return {**payload, "cached": not computed}
