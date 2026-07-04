"""Ontology routes — /api/ontology/* (the typed semantic spine, Track A1 / C4).

Access to the per-user Object/Link graph persisted by ``intel/ontology.py``.
The audited write-back verbs (flag / nominate / promote …) still live in the
action layer (``/api/actions/*``); the one write exposed here is the plain
``POST /api/ontology/object`` upsert the Investigation canvas (C4) uses to save a
named investigation as an ontology node — a graph-shaping write, not a kinetic
action, so it needs no ``action_log`` audit row.

  GET  /api/ontology/object/{id}              → one Object (404 if absent)
  POST /api/ontology/object                   → upsert one Object (save a node)
  GET  /api/ontology/search-around/{id}?depth= → the id's neighbourhood graph
  GET  /api/ontology/path?a=&b=&max_depth=    → shortest chain linking a ↔ b

Auth is ``current_user`` (a real signed-in Supabase user — every row is RLS-scoped
to ``auth.uid()``). Degrades to 503 when Supabase is unconfigured, mirroring
``targets.py``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from typing import Any

from app.config import get_settings
from app.intel import graph_analytics
from app.intel.ontology import (
    Object,
    OntologyRegistry,
    PathResult,
    SearchAround,
)
from app.keys import UserCtx, current_user

router = APIRouter(tags=["ontology"])


@router.get("/api/ontology/object/{object_id:path}", response_model=Object)
async def get_object(
    object_id: str, ctx: UserCtx = Depends(current_user)
) -> Object:
    """Fetch one ontology object by its canonical id.

    Uses a ``:path`` converter because canonical ids contain a colon
    (``aircraft:4ca7b3``) — without it FastAPI would still match, but ``:path``
    also tolerates ids that themselves contain slashes.
    """
    reg = OntologyRegistry(ctx, get_settings())
    obj = await reg.get(object_id)
    if obj is None:
        raise HTTPException(status_code=404, detail="object not found")
    return obj


@router.post("/api/ontology/object", response_model=Object)
async def upsert_object(
    obj: Object, ctx: UserCtx = Depends(current_user)
) -> Object:
    """Insert or merge one ontology object (RLS-scoped to the caller).

    The graph-shaping write the Investigation canvas (C4) uses to persist a saved
    investigation as a node (``investigation:<uuid>`` with the member ids in
    ``props.nodes``). ``kind`` is reconciled to the id prefix server-side
    (``upsert`` calls ``normalised()``), so a caller may omit it. This is NOT a
    kinetic action — no ``action_log`` audit row — so it stays here rather than in
    ``/api/actions``. 503 when Supabase is unconfigured.
    """
    reg = OntologyRegistry(ctx, get_settings())
    return await reg.upsert(obj)


@router.get(
    "/api/ontology/search-around/{object_id:path}", response_model=SearchAround
)
async def search_around(
    object_id: str,
    depth: int = Query(1, ge=1, le=3),
    ctx: UserCtx = Depends(current_user),
) -> SearchAround:
    """Breadth-first neighbourhood of ``object_id`` up to ``depth`` hops (1–3).

    Returns the reachable objects + the links between them — the radial-graph
    payload the EntityPanel ConnectionsCard and the agent compose on. The center
    is always present even if it has no persisted row yet (a derived stub).
    """
    reg = OntologyRegistry(ctx, get_settings())
    return await reg.traverse(object_id, depth=depth)


@router.get("/api/ontology/analytics/{object_id:path}")
async def graph_analytics_route(
    object_id: str,
    depth: int = Query(2, ge=1, le=3),
    ctx: UserCtx = Depends(current_user),
) -> dict[str, Any]:
    """Link-analysis metrics over the ``object_id`` neighbourhood (Phase 3).

    Expands the search-around graph to ``depth`` hops, then computes degree +
    betweenness centrality, connected-component communities, and a ranked
    ``key_nodes`` list (the most central actors — whose removal most fragments the
    network). This is the "who are the important nodes" question Gotham's graph
    explorer answers; ``search-around`` shows the graph, this scores it.
    """
    reg = OntologyRegistry(ctx, get_settings())
    sa = await reg.traverse(object_id, depth=depth)
    node_ids, edges = graph_analytics.from_search_around(sa)
    result = graph_analytics.analyze(node_ids, edges)
    result["center"] = object_id
    result["depth"] = depth
    return result


@router.get("/api/ontology/path", response_model=PathResult)
async def ontology_path(
    a: str = Query(..., min_length=1, max_length=200),
    b: str = Query(..., min_length=1, max_length=200),
    max_depth: int = Query(4, ge=1, le=6),
    ctx: UserCtx = Depends(current_user),
) -> PathResult:
    """Shortest UNDIRECTED chain linking object ``a`` to object ``b``.

    Breadth-first over the link graph (edges connect both ways for path-finding),
    bounded by ``max_depth`` hops (1–6, default 4). Returns the ordered node ids +
    the edges along the chain — the two-entity path-finding the Investigation
    canvas (C4) draws. ``found=False`` (empty path) when no chain exists within the
    budget, which the canvas surfaces honestly rather than as an error.
    """
    reg = OntologyRegistry(ctx, get_settings())
    return await reg.path_between(a, b, max_depth=max_depth)
