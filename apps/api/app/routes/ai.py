"""GET/POST /api/ai/local — the app-scoped local-inference toggle (Part 4),
now also the engine + selection-inference control (design doc "API contract":
GET/POST /api/ai/local gains engine/selection_model/selection_enabled).

Lets the operator run the text-LLM tier on their own GPU ahead of the cloud
backends, to dodge cloud rate limits. GET reports hardware readiness (the
frontend gates the switch on ``ollama_up`` + ``tool_capable``) plus the
resolved local engine and selection-inference state; POST flips the runtime
preference(s) — every field is optional and independently settable, absent
fields leave that piece of state unchanged (mirrors the existing
``local_only`` convention). The switches are process-global — right for the
single-operator / desktop case this exists for.

POST carries write authority (engine/local_only/selection_model), so it is
gated with ``require_compute_enabled`` — the same fail-closed-on-a-keyless-box
rule ``ApiKeyMiddleware`` applies to the other compute paths (issue #8),
without adding this path to ``ratelimit._COMPUTE_PREFIXES`` (that predicate is
method-blind and would also 503 the GET status probe the settings UI polls).
GET stays open and ungated — pure keyless status.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app import llm
from app.auth import require_compute_enabled

router = APIRouter(tags=["ai"])


@router.get("/api/ai/local")
async def ai_local_status() -> dict:
    return await llm.local_status()


class LocalToggle(BaseModel):
    enabled: bool | None = None  # None → leave local-first preference unchanged
    local_only: bool | None = None  # None → leave the strict local-only mode unchanged
    engine: Literal["auto", "llamacpp", "vllm", "ollama"] | None = None  # None → unchanged
    selection_enabled: bool | None = None  # None → unchanged
    # None → unchanged; "" clears the pinned selection model (same "empty
    # clears" convention as POST /api/ai/models/active's `key`).
    selection_model: str | None = None


@router.post("/api/ai/local", dependencies=[Depends(require_compute_enabled)])
async def ai_local_set(body: LocalToggle) -> dict:
    if body.enabled is not None:
        llm.set_prefer_local(body.enabled)
    if body.local_only is not None:
        llm.set_local_only(body.local_only)
    if body.engine is not None:
        from app.localllm import state as engine_state  # noqa: PLC0415

        engine_state.set_engine(body.engine)
    if body.selection_enabled is not None:
        llm.set_selection_enabled(body.selection_enabled)
    if body.selection_model is not None:
        from app.localllm import manager  # noqa: PLC0415

        manager.set_active("selection", body.selection_model or None)
    return await llm.local_status()
