"""GET/POST /api/ai/local — the app-scoped local-inference toggle (Part 4).

Lets the operator run the text-LLM tier on their own GPU (Ollama) ahead of the
cloud backends, to dodge cloud rate limits. GET reports hardware readiness (the
frontend gates the switch on ``ollama_up`` + ``tool_capable``); POST flips the
runtime preference. The switch is process-global — right for the single-operator
/ desktop case this exists for.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app import llm

router = APIRouter(tags=["ai"])


@router.get("/api/ai/local")
async def ai_local_status() -> dict:
    return await llm.local_status()


class LocalToggle(BaseModel):
    enabled: bool


@router.post("/api/ai/local")
async def ai_local_set(body: LocalToggle) -> dict:
    llm.set_prefer_local(body.enabled)
    return await llm.local_status()
