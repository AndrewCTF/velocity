"""Ontology routes — /api/ontology/* (the typed semantic spine, Track A1 / C4).

Access to the per-user Object/Link graph persisted by ``intel/ontology.py``.
The audited write-back verbs (flag / nominate / promote …) still live in the
action layer (``/api/actions/*``); the one write exposed here is the plain
``POST /api/ontology/object`` upsert the Investigation canvas (C4) uses to save a
named investigation as an ontology node — a graph-shaping write, not a kinetic
action, so it needs no ``action_log`` audit row.

  GET  /api/ontology/object/{id}              → one Object (404 if absent)
  POST /api/ontology/object                   → upsert one Object (save a node)
  GET  /api/ontology/assertions/{id}?prop=    → the id's assertion history
  GET  /api/ontology/search-around/{id}?depth= → the id's neighbourhood graph
  GET  /api/ontology/path?a=&b=&max_depth=    → shortest chain linking a ↔ b

Auth is ``current_user_or_local``: a real signed-in user when Supabase auth is
configured, else the shared ``local`` identity. Either way the store is the
local SQLite spine (``get_registry``) — every route works on a keyless boot.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.config import get_settings
from app.intel import graph_analytics
from app.intel.ontology import (
    _KNOWN_KINDS,
    Assertion,
    Object,
    PathResult,
    SearchAround,
    get_registry,
)
from app.keys import UserCtx, current_user_or_local

router = APIRouter(tags=["ontology"])

# Trigger → provenance source for POST /api/ontology/promote. The SERVER owns
# the source string (the client passes only a trigger enum, never a raw source)
# so a caller can't forge feed/rule authority into the assertion trail —
# provenance integrity is the whole point of the evidenced-assertion model. The
# first segment stays inside the closed vocab ``analyst|rule|feed|agent`` the
# provenance-trail UI (Move 3) groups and colours by.
_PROMOTE_SOURCE: dict[str, str] = {
    "flag": "analyst:flag",
    "nominate": "analyst:nominate",
    "watch": "analyst:watch",
    "situation": "analyst:situation",
    "manual": "analyst:manual",
}


@router.get("/api/ontology/object/{object_id:path}", response_model=Object)
async def get_object(
    object_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> Object:
    """Fetch one ontology object by its canonical id.

    Uses a ``:path`` converter because canonical ids contain a colon
    (``aircraft:4ca7b3``) — without it FastAPI would still match, but ``:path``
    also tolerates ids that themselves contain slashes.
    """
    reg = get_registry(ctx, get_settings())
    obj = await reg.get(object_id)
    if obj is None:
        raise HTTPException(status_code=404, detail="object not found")
    return obj


@router.get(
    "/api/ontology/assertions/{object_id:path}",
    response_model=list[Assertion],
)
async def object_assertions(
    object_id: str,
    prop: str | None = Query(None, max_length=200),
    limit: int = Query(200, ge=1, le=1000),
    ctx: UserCtx = Depends(current_user_or_local),
) -> list[Assertion]:
    """The evidenced property history of one object, newest first.

    Every row answers *who said this, when, how sure* (source, confidence,
    observed_at, optional derivation).
    """
    reg = get_registry(ctx, get_settings())
    return await reg.get_assertions(object_id, prop=prop, limit=limit)


@router.post("/api/ontology/object", response_model=Object)
async def upsert_object(
    obj: Object, ctx: UserCtx = Depends(current_user_or_local)
) -> Object:
    """Insert or merge one ontology object (RLS-scoped to the caller).

    The graph-shaping write the Investigation canvas (C4) uses to persist a saved
    investigation as a node (``investigation:<uuid>`` with the member ids in
    ``props.nodes``). ``kind`` is reconciled to the id prefix server-side
    (``upsert`` calls ``normalised()``), so a caller may omit it. This is NOT a
    kinetic action — no ``action_log`` audit row — so it stays here rather than in
    ``/api/actions``.
    """
    reg = get_registry(ctx, get_settings())
    return await reg.upsert(obj)


class PromoteIn(BaseModel):
    """Materialize a live feed entity into a durable, evidenced ontology object.

    The *semantic capture* verb (Move 1 of the ontology roadmap) — distinct from
    the *kinetic* ``/api/actions/*`` verbs, which are signed-in + audited. Here
    ``props`` are client-supplied VALUES (the Cesium blob of the selected entity,
    since feeds are transient and not held server-side); ``source``, ``kind`` and
    the timestamp are stamped server-side so the provenance trail stays trustworthy.
    """

    id: str = Field(min_length=1, max_length=200)
    props: dict[str, Any] = Field(default_factory=dict)
    trigger: Literal["flag", "nominate", "watch", "situation", "manual"] = "manual"
    confidence: float = Field(0.8, ge=0.0, le=1.0)


@router.post("/api/ontology/promote", response_model=Object)
async def promote_object(
    body: PromoteIn, ctx: UserCtx = Depends(current_user_or_local)
) -> Object:
    """Promote a live entity to a durable, evidenced ontology object (keyless).

    Fired when an analyst takes a decision on the selected entity (flag /
    nominate / watch) or a rule/situation pulls it in — never on bare selection —
    so presence in the graph means *someone decided the object mattered*. This is
    what turns the otherwise-hollow graph live on a fresh keyless boot, so it uses
    ``current_user_or_local`` (not the stricter ``current_user`` of the audited
    action surface). Writes via ``assert_props`` — MERGE + one evidenced assertion
    per prop, never the wholesale ``upsert`` (whose blob-replace contract the
    frontend round-trip depends on). The id must be ``<kind>:<value>`` with a known
    ontology kind, so a junk-prefixed id can't mint a garbage-kinded stub.
    """
    prefix = body.id.split(":", 1)[0] if ":" in body.id else ""
    if prefix not in _KNOWN_KINDS:
        raise HTTPException(
            status_code=400,
            detail="id must be '<kind>:<value>' with a known ontology kind",
        )
    reg = get_registry(ctx, get_settings())
    return await reg.assert_props(
        body.id,
        body.props,
        source=_PROMOTE_SOURCE[body.trigger],
        confidence=body.confidence,
        derivation={"trigger": body.trigger},
    )


@router.get(
    "/api/ontology/search-around/{object_id:path}", response_model=SearchAround
)
async def search_around(
    object_id: str,
    depth: int = Query(1, ge=1, le=3),
    ctx: UserCtx = Depends(current_user_or_local),
) -> SearchAround:
    """Breadth-first neighbourhood of ``object_id`` up to ``depth`` hops (1–3).

    Returns the reachable objects + the links between them — the radial-graph
    payload the EntityPanel ConnectionsCard and the agent compose on. The center
    is always present even if it has no persisted row yet (a derived stub).
    """
    reg = get_registry(ctx, get_settings())
    return await reg.traverse(object_id, depth=depth)


@router.get("/api/ontology/analytics/{object_id:path}")
async def graph_analytics_route(
    object_id: str,
    depth: int = Query(2, ge=1, le=3),
    ctx: UserCtx = Depends(current_user_or_local),
) -> dict[str, Any]:
    """Link-analysis metrics over the ``object_id`` neighbourhood (Phase 3).

    Expands the search-around graph to ``depth`` hops, then computes degree +
    betweenness centrality, connected-component communities, and a ranked
    ``key_nodes`` list (the most central actors — whose removal most fragments the
    network). This is the "who are the important nodes" question Gotham's graph
    explorer answers; ``search-around`` shows the graph, this scores it.
    """
    reg = get_registry(ctx, get_settings())
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
    ctx: UserCtx = Depends(current_user_or_local),
) -> PathResult:
    """Shortest UNDIRECTED chain linking object ``a`` to object ``b``.

    Breadth-first over the link graph (edges connect both ways for path-finding),
    bounded by ``max_depth`` hops (1–6, default 4). Returns the ordered node ids +
    the edges along the chain — the two-entity path-finding the Investigation
    canvas (C4) draws. ``found=False`` (empty path) when no chain exists within the
    budget, which the canvas surfaces honestly rather than as an error.
    """
    reg = get_registry(ctx, get_settings())
    return await reg.path_between(a, b, max_depth=max_depth)
