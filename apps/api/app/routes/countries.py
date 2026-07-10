"""Country-OSINT catalog routes — /api/osint/countries/*.

Generic, parameterized by ``{code}`` — the SAME shape for all countries in
the catalog (docs/country-osint-spec.md). All GETs are keyless (public
reference data, same posture as the digital-OSINT connector GETs in
``routes/osint.py``); only ``/{code}/ingest`` requires a signed-in user
because it persists into that user's ontology graph.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.audit import audit
from app.config import get_settings
from app.intel.ontology import get_registry
from app.keys import UserCtx, current_user
from app.osint import country_catalog

router = APIRouter(tags=["osint-countries"], prefix="/api/osint/countries")


@router.get("/categories")
async def categories() -> dict[str, Any]:
    return country_catalog.category_summary()


@router.get("")
async def list_countries(
    region: str | None = Query(None), category: str | None = Query(None)
) -> dict[str, Any]:
    return country_catalog.list_summary(region=region, category=category)


@router.get("/{code}")
async def country_detail(code: str) -> dict[str, Any]:
    rec = country_catalog.by_code(code)
    if rec is None:
        raise HTTPException(status_code=404, detail=f"unknown country code: {code}")
    return {
        "code": rec.code,
        "name": rec.name,
        "region": rec.region,
        "iso2": rec.iso2,
        "source_url": rec.source_url,
        "note": rec.note,
        "resources": [
            {
                "name": r.name,
                "url": r.url,
                "category": r.category,
                "note": r.note,
                "keyless": r.keyless,
            }
            for r in rec.resources
        ],
    }


@router.get("/{code}/graph")
async def country_graph(code: str) -> dict[str, Any]:
    """Canvas preview — NOT persisted."""
    graph = country_catalog.build_graph(code)
    if graph is None:
        raise HTTPException(status_code=404, detail=f"unknown country code: {code}")
    return {
        "nodes": [o.model_dump() for o in graph["nodes"]],
        "links": [lk.model_dump() for lk in graph["links"]],
    }


@router.post("/{code}/ingest")
async def ingest_country(code: str, ctx: UserCtx = Depends(current_user)) -> dict[str, Any]:
    """Persist ``build_graph(code)`` into the caller's ontology."""
    graph = country_catalog.build_graph(code)
    if graph is None:
        raise HTTPException(status_code=404, detail=f"unknown country code: {code}")

    reg = get_registry(ctx, get_settings())
    for obj in graph["nodes"]:
        await reg.upsert(obj)
    for lk in graph["links"]:
        await reg.link(lk)

    root = "country:" + code.strip().lower()
    await audit(
        ctx,
        "osint_country_ingest",
        "country",
        root,
        detail={
            "objects": len(graph["nodes"]),
            "links": len(graph["links"]),
            "ts": time.time(),
        },
    )
    return {"root": root, "objects": len(graph["nodes"]), "links": len(graph["links"])}
