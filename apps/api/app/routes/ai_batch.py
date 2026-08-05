"""``/api/ai/batch`` — many documents through the local model at once.

The rest of the AI surface is one prompt per request, because the rest of the AI
surface answers a question an analyst just asked. This one exists for the other
half of the work: a pile of raw documents that has to become structured facts
before anybody asks anything. Workflows, Foundry transforms and the ingest path
are the callers.

The response always carries the measured batch stats, not just the answers. A
batch job whose throughput nobody can see is a batch job nobody can size.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import llm_pool
from app.auth import require_compute_enabled

router = APIRouter(prefix="/api/ai/batch", tags=["ai"])


class BatchRequest(BaseModel):
    system: str = Field(..., max_length=8000)
    items: list[str] = Field(..., min_length=1, max_length=llm_pool.MAX_BATCH)
    #: Parse each answer as JSON and return the object. An item that comes back
    #: unparseable is counted as a failure, never silently retried.
    structured: bool = False
    #: Concurrency. Defaults to what the engine can actually serve; a caller may
    #: go narrower, and going wider only moves the queue inside the server.
    width: int | None = Field(None, ge=1, le=64)
    max_tokens: int = Field(512, ge=16, le=8192)
    temperature: float = Field(0.1, ge=0.0, le=2.0)
    label: str = Field("batch", max_length=64)


@router.get("")
async def pool_info() -> dict[str, Any]:
    """Engine, width, and where the width came from."""
    return llm_pool.describe()


@router.post("")
async def run_batch(
    req: BatchRequest, _gate: None = Depends(require_compute_enabled)
) -> dict[str, Any]:
    if any(len(s) > 32000 for s in req.items):
        raise HTTPException(413, "an item exceeds 32000 characters")
    kwargs: dict[str, Any] = {
        "width": req.width,
        "max_tokens": req.max_tokens,
        "temperature": req.temperature,
        "label": req.label,
    }
    if req.structured:
        results, stats = await llm_pool.map_structured(req.system, req.items, **kwargs)
    else:
        results, stats = await llm_pool.map_prompts(req.system, req.items, **kwargs)
    return {"results": results, "stats": stats.as_dict(), "pool": llm_pool.describe()}
