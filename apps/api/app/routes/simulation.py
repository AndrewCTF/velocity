"""POST /api/sim/reason — AI reasoning over a browser-computed war-game outcome.

The browser owns the simulation: physics, motion, and the deterministic combat /
economic math all run client-side. It POSTs the scenario plus the computed
numbers here and we ask the reasoning model to turn them into an analytic
narrative — likely outcomes, casualty / economic ranges, escalation risk,
second-order effects, and the assumptions behind them.

The model does NOT compute the numbers; it reasons over them. This is open-source,
analytical war-gaming (the kind CSIS / RAND publish) — outputs are clearly-labelled
estimates, not operational plans.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app import llm
from app.auth import require_api_key

router = APIRouter(tags=["simulation"], prefix="/api/sim")


class SimReasonRequest(BaseModel):
    scenario: dict[str, Any] = Field(default_factory=dict)
    outcome: dict[str, Any] = Field(default_factory=dict)
    question: str | None = None
    # fast=True selects the cheaper chat model (deepseek-chat) and skips the
    # slow MiniMax-M3 reasoner — a single-digit-second "first look" narrative
    # instead of the ~20s+ deep pass. Defaults to the reasoner for full depth.
    fast: bool = False


SYSTEM = (
    "You are a defence analyst running OPEN-SOURCE, analytical war-gaming for "
    "situational awareness (in the spirit of CSIS / RAND public studies). You are "
    "given a scenario and a deterministic model's numeric outcome (interception / "
    "leakage, attrition, estimated damage, economic disruption). Reason over those "
    "numbers — do not recompute them. Use only public, general knowledge. Give "
    "ranges and state uncertainty; never produce operational targeting or planning "
    "detail.\n\n"
    "Return STRICT JSON with this shape and nothing else:\n"
    "{\n"
    '  "assessment": "2-4 sentence headline judgement",\n'
    '  "outcomes": [{"description": str, "probability": 0.0-1.0, "rationale": str}],\n'
    '  "casualties_estimate": "qualitative range, clearly an estimate",\n'
    '  "economic_impact": "qualitative + any figures, clearly an estimate",\n'
    '  "escalation_risk": "low|moderate|high + one line why",\n'
    '  "second_order": [str, ...],\n'
    '  "assumptions": [str, ...],\n'
    '  "confidence": "low|medium|high"\n'
    "}"
)


@router.post("/reason", dependencies=[Depends(require_api_key)])
async def sim_reason(req: SimReasonRequest) -> dict[str, Any]:
    user = (
        "Scenario:\n"
        + json.dumps(req.scenario)[:4000]
        + "\n\nDeterministic model outcome:\n"
        + json.dumps(req.outcome)[:4000]
        + (f"\n\nAnalyst question: {req.question}" if req.question else "")
    )
    parsed, res = await llm.chat_json(
        [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
        tier="fast" if req.fast else "reason",
        fast=req.fast,
        temperature=0.2,
        max_tokens=1800,
    )
    if not res.ok:
        return {"ok": False, "error": res.error or "model unavailable", "model": res.model}
    if not isinstance(parsed, dict):
        return {
            "ok": False,
            "error": "model did not return JSON",
            "raw": (res.text or "")[:1200],
            "model": res.model,
        }
    return {"ok": True, "model": res.model, "backend": res.backend, **parsed}
