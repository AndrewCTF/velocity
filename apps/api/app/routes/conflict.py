"""GET /api/conflict/live — real armed-conflict events (GDELT 2.0, keyless).

Distinct from /api/intel/brief (inference/warning fusion): these are
machine-coded violent events (fights, air strikes, shelling, bombings, mass
violence) with coordinates + actors, refreshed every 15 min.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.intel import conflict, ucdp

router = APIRouter(tags=["conflict"])


@router.get("/api/conflict/live")
async def conflict_live(hours: int = Query(6, ge=1, le=24)) -> dict[str, Any]:
    return await conflict.conflict_events(hours=hours)


@router.get("/api/conflict/ucdp")
async def conflict_ucdp(version: str = Query(ucdp.DEFAULT_VERSION, pattern=r"^[\d.]+$")) -> dict[str, Any]:
    """UCDP GED candidate events (named side_a/side_b threat actors, death
    estimates). Token-gated upstream — empty + `unavailable` without
    OSINT_UCDP_TOKEN configured; GDELT `/api/conflict/live` stays the keyless
    default."""
    return await ucdp.ucdp_events(version=version)
