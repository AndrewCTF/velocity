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

Also the AI accountability surface (2026-09-17, W4):

  GET /api/ai/calls       → the local ``llm_calls`` audit trail (every model
                            call this box made, newest first)
  GET /api/ai/guardrails  → what the model is allowed to SEE and DO here

Both are reads, both keyless, and neither is a control: "the model is governed"
is only a claim until an operator can open the page that says by what.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app import llm
from app.auth import require_compute_enabled
from app.config import get_settings
from app.security import Principal, current_principal_or_local

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
    # The llama.cpp router is no longer spawned at boot — it holds models on the
    # GPU, and holding them for a feature that is switched off cost 6.2 GB of
    # VRAM here (see llamacpp_sidecar.is_enabled). Turning local inference on is
    # exactly the moment to bring it up. Idempotent, and a no-op when the switch
    # went the other way.
    from app import llamacpp_sidecar  # noqa: PLC0415

    await llamacpp_sidecar.start()
    return await llm.local_status()


@router.get("/api/ai/calls")
async def ai_calls(limit: int = Query(50, ge=1, le=500)) -> list[dict[str, Any]]:
    """Every model call this box recorded locally, newest first.

    The LOCAL sink only (``app/llm_calls_local.py``). With Supabase configured
    the rows go to PostgREST under that user's RLS and are read there, so this
    route answering empty on such a deployment is the honest answer, not a bug:
    it reports what this box holds.

    Each row is the shape ``llm.call_row`` produces — backend, model id, tier,
    ok, token counts, latency, tool calls, label — and deliberately NOT the
    prompt or the completion. This is an accountability trail, not a transcript
    store; keeping the text would make every brief about a person a second copy
    of it.
    """
    from app import llm_calls_local  # noqa: PLC0415 — keep import cost off boot

    return await llm_calls_local.list_calls(limit)


@router.get("/api/ai/guardrails")
async def ai_guardrails(
    p: Principal = Depends(current_principal_or_local),
) -> dict[str, Any]:
    """What the model can SEE and what it can DO on this deployment.

    Assembled from the live objects rather than restated, so the page cannot
    drift from the policy: the tool names come from ``intel/agent.py``'s own
    registries, the approval knobs from ``Settings``, the actuation kill switch
    from ``workflows/control``, and the clearance from the caller's principal.
    A guardrail surface that is written by hand is a guardrail surface that is
    eventually wrong.
    """
    from app.intel import agent  # noqa: PLC0415
    from app.intel.actions import list_actions  # noqa: PLC0415
    from app.workflows import control  # noqa: PLC0415

    s = get_settings()
    specs = list_actions()
    return {
        # See
        "clearance": p.clearance,
        "compartments": list(p.compartments),
        "tools": sorted(agent.TOOLS),
        # Do
        "action_tools": sorted(agent.ACTION_TOOLS),
        "control_tools": sorted(agent.CONTROL_TOOLS),
        "operator_only_actions": sorted(a["name"] for a in specs if a.get("operator_only")),
        # Under what rules
        "action_approval": bool(s.action_approval),
        "action_auto_threshold": float(s.action_auto_threshold),
        "control_enabled": control.control_enabled(),
        "local_only": llm.local_only(),
        "citations_required": bool(getattr(s, "llm_require_citations", True)),
    }
