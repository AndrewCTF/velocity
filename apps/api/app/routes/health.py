"""GET /api/health — liveness probe + memory-tier policy state."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app import memtier

router = APIRouter(tags=["health"])


@router.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/api/health/memory")
def health_memory() -> dict[str, Any]:
    """Available RAM + the per-cache byte budgets memtier resolves from it."""
    return memtier.snapshot()
