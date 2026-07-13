"""POST /api/geo/event-shapes — batch admin-boundary lookup for event shading.

Conflict/strike features now carry ``iso3`` + ``shape_level`` next to
``radius_m``; the frontend batches its visible events here and shades the REAL
admin polygon (geoBoundaries gbOpen, via app.geo.adminshapes) instead of an
uncertainty circle.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.geo import adminshapes

router = APIRouter(tags=["geo"])

_MAX_QUERIES = 200
# Distinct (iso3, level) files in one batch each cost a download on cold
# cache; bound the concurrent resolves so a 200-query cold batch can't open
# 200 upstream fetches at once (per-key loads are additionally Lock-guarded).
_CONCURRENCY = 8


class ShapeQuery(BaseModel):
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)
    level: Literal["adm1", "adm2"]
    iso3: str = Field(min_length=3, max_length=3, pattern=r"^[A-Za-z]{3}$")


class ShapeBatch(BaseModel):
    queries: list[ShapeQuery] = Field(min_length=1, max_length=_MAX_QUERIES)


def _key(q: ShapeQuery) -> str:
    return f"{q.iso3.upper()}|{q.level}|{q.lat:.3f}|{q.lon:.3f}"


@router.post("/api/geo/event-shapes")
async def event_shapes(body: ShapeBatch) -> dict[str, Any]:
    """Resolve up to 200 event positions to their containing admin polygons.

    Body: ``{"queries": [{"lat", "lon", "level": "adm1"|"adm2", "iso3"}, ...]}``
    (>200 queries → 422 from validation).

    Response ``{"shapes": [...], "misses": [key, ...]}``. Every query is
    identified by ``key = f"{iso3}|{level}|{lat:.3f}|{lon:.3f}"`` — iso3
    UPPERCASED, level as requested, lat/lon rounded server-side to 3 decimals
    (the frontend must build the identical key to join results back). One
    shape per admin unit even when several queries land in it:
    ``{"keys": [key, ...], "id", "name", "level", "iso3", "geometry"}`` —
    ``level`` is the level actually resolved (ADM2 falls back to ADM1 when a
    country ships no ADM2 file), while the key keeps the REQUESTED level.
    Resolver failures and unknown countries become misses, never a 500.
    """
    unique: dict[str, ShapeQuery] = {}
    for q in body.queries:
        unique.setdefault(_key(q), q)

    sem = asyncio.Semaphore(_CONCURRENCY)

    async def one(key: str, q: ShapeQuery) -> tuple[str, dict[str, Any] | None]:
        async with sem:
            try:
                return key, await adminshapes.resolve(q.iso3, q.lon, q.lat, q.level)
            except Exception:  # noqa: BLE001 — a bad query/country is a miss
                return key, None

    results = await asyncio.gather(*(one(k, q) for k, q in unique.items()))

    shapes: dict[tuple[Any, Any, Any], dict[str, Any]] = {}
    misses: list[str] = []
    for key, res in results:
        if not res:
            misses.append(key)
            continue
        ident = (res["iso3"], res["level"], res["id"])
        shape = shapes.get(ident)
        if shape is None:
            shapes[ident] = {"keys": [key], **res}
        else:
            shape["keys"].append(key)
    return {"shapes": list(shapes.values()), "misses": misses}
