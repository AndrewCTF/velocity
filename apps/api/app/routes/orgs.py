"""``/api/org/resolve`` — one organisation, four registries, attributed.

The route is deliberately thin. All the judgement is in `intel/orgs.py`, and the
part that matters most is what it refuses to do: it does not score, rank or
summarise, and it never reports an empty result without saying whether the
source that would have filled it actually answered.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.intel import orgs

router = APIRouter(prefix="/api/org", tags=["osint"])


@router.get("/resolve")
async def resolve(
    name: str = Query(..., min_length=2, max_length=160),
    limit: int = Query(10, ge=1, le=50),
) -> dict[str, Any]:
    """Legal entity, filings, federal awards and designations for one name."""
    return await orgs.resolve(name.strip(), limit)
