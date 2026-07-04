"""GET /api/conflict/live — real armed-conflict events (GDELT 2.0, keyless).

Distinct from /api/intel/brief (inference/warning fusion): these are
machine-coded violent events (fights, air strikes, shelling, bombings, mass
violence) with coordinates + actors, refreshed every 15 min.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.intel import conflict

router = APIRouter(tags=["conflict"])


@router.get("/api/conflict/live")
async def conflict_live(hours: int = Query(6, ge=1, le=24)) -> dict[str, Any]:
    return await conflict.conflict_events(hours=hours)
