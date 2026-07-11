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

import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import llm, upstream
from app.keys import UserCtx, current_user_or_local

router = APIRouter(tags=["ai-selection"])

_CACHE_TTL_S = 60.0
_MAX_PROPS_BYTES = 4096
_MAX_STRING_LEN = 500
# Floor is well above the 2-4 sentence answer this brief actually needs — a
# reasoning-tier local model (Qwen3 family etc.) spends some of its budget on
# a thinking preamble even with `chat_template_kwargs.enable_thinking: false`
# sent (see app.llm._llamacpp_chat/_vllm_chat), so 300 wasn't enough headroom
# to survive that preamble and still answer; 512 is.
_MAX_TOKENS = 512


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

    cache_key = f"selection-brief:{body.kind}:{body.id}"
    computed = False

    async def _load() -> dict[str, Any]:
        nonlocal computed
        computed = True
        props_json = json.dumps(_clamp_props(body.props), default=str, separators=(",", ":"))
        system = (
            "You are an OSINT watch assistant. Give a 2-4 sentence assessment of "
            f"this {body.kind}, noting anything anomalous in the data. Do not "
            "speculate beyond the data given."
        )
        user = f"{body.kind} {body.id}:\n{props_json}"
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
        }

    payload = await upstream.cache.get_or_fetch(cache_key, _CACHE_TTL_S, _load)
    return {**payload, "cached": not computed}
