"""GET /api/markets/* — thin router over ``app.markets`` (worldmonitor-gaps
wave, task B1e). All logic lives in ``app.markets``; this just wires the
in-process module functions to routes (never call another route handler
in-process — call the module fn directly, matching the invariant used by
``advisories_summary``/``displacement_summary``)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app import markets

router = APIRouter(tags=["markets"])


@router.get("/api/markets/snapshot")
async def markets_snapshot() -> dict[str, Any]:
    return await markets.snapshot()


@router.get("/api/markets/predictions")
async def markets_predictions() -> dict[str, Any]:
    return await markets.predictions()


@router.get("/api/markets/stress")
async def markets_stress() -> dict[str, Any]:
    return await markets.market_stress()
