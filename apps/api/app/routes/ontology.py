"""Ontology routes — /api/ontology/* (the typed semantic spine, Track A1 / C4).

Access to the per-user Object/Link graph persisted by ``intel/ontology.py``.
The audited write-back verbs (flag / nominate / promote …) still live in the
action layer (``/api/actions/*``); the one write exposed here is the plain
``POST /api/ontology/object`` upsert the Investigation canvas (C4) uses to save a
named investigation as an ontology node — a graph-shaping write, not a kinetic
action, so it needs no ``action_log`` audit row.

  GET  /api/ontology/schema                   → declared relations + kind props
  GET  /api/ontology/search?q=&kind=          → full-text over the stored graph
  GET  /api/ontology/object/{id}              → one Object (404 if absent)
  POST /api/ontology/object                   → upsert one Object (save a node)
  GET  /api/ontology/assertions/{id}?prop=    → the id's assertion history
  GET  /api/ontology/search-around/{id}?depth= → the id's neighbourhood graph
  GET  /api/ontology/path?a=&b=&max_depth=    → shortest chain linking a ↔ b

Auth is ``current_principal_or_local``: a real signed-in user when Supabase auth
is configured, else the shared ``local`` identity — which is a clearance-0,
compartment-less ``Principal``, so a keyless box keeps seeing everything it
already had (every row it ever wrote is level 0). Either way the store is the
local SQLite spine (``get_registry``) — every route works on a keyless boot.
The principal is passed into the registry, which is what makes the stored
classification actually gate a read (``intel/ontology_local.SqliteRegistry``).
``GET /api/ontology/schema`` is the one route with no principal: it is static,
per-deployment and identical for every caller, so it has never had an auth
dependency and gaining one would 401 it on a Supabase deployment.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.audit import audit_mutation
from app.config import get_settings
from app.intel import classification as clf
from app.intel import graph_analytics
from app.intel.ontology import (
    _KNOWN_KINDS,
    Assertion,
    Object,
    PathResult,
    SearchAround,
    get_registry,
    visible_to,
)
from app.intel.ontology_schema import schema_payload, validate_object
from app.keys import UserCtx
from app.security import Principal, current_principal_or_local

# Every ontology mutation leaves an audit row naming its actor (ASVS V15.3.3).
router = APIRouter(tags=["ontology"], dependencies=[Depends(audit_mutation)])

# Evidence is written by /api/evidence, which hashes the bytes and appends the
# custody log. The generic object route must not be a second way to write it,
# or a caller rewrites the hash a custody record vouches for (ASVS V15.3.3,
# gap-analysis G18 residual).
_CUSTODY_PROPS = frozenset(
    {"sha256", "custody", "captured_by", "captured_at", "capture_method", "size_bytes"}
)


def _reg(p: Principal, *, filtered: bool = True):  # type: ignore[no-untyped-def]
    """The registry for this caller — clearance-filtered unless asked otherwise.

    ``filtered=False`` is the write path's view of the store: a ceiling check has
    to be able to see the row it is defending, and ``upsert`` must not be handed
    a registry whose ``get`` would lie to it.
    """
    ctx = UserCtx(user_id=p.user_id, token=p.token)
    return get_registry(ctx, get_settings(), principal=p if filtered else None)


def _refuse_write_above_clearance(p: Principal, level: int, comps: list[str]) -> None:
    """The create ceiling, same rule as ``routes/extract.py``: a caller may not
    mint a row above their own clearance, nor tag it with a compartment they do
    not hold. Without it the write side is a laundering path — post at level 4,
    then read your own row back."""
    if clf.clamp(level) > clf.clamp(p.clearance):
        raise HTTPException(
            status_code=403, detail="cannot classify above your clearance"
        )
    if not clf.holds(p.compartments, comps):
        raise HTTPException(
            status_code=403, detail="cannot use compartments you do not hold"
        )


async def _refuse_overwrite_of_hidden_row(p: Principal, object_id: str) -> None:
    """Refuse a write that lands on a row the caller is not cleared to read.

    A read filter alone is half a gate: an unfiltered ``upsert`` would let a
    clearance-0 caller replace a level-4 object's props (and its
    classification) wholesale, and an unfiltered ``assert_props`` MERGES and
    then RETURNS the merged row, which hands the hidden props straight back.
    403 rather than 404 mirrors the ``routes/extract.py`` gate; it does admit
    that the id exists, which is the accepted trade for not silently destroying
    classified data.
    """
    existing = await _reg(p, filtered=False).get(object_id)
    if existing is not None and not visible_to(
        p, existing.classification, existing.compartments
    ):
        raise HTTPException(
            status_code=403,
            detail="that object is classified above your clearance",
        )


def _refuse_custody_writes(obj: Object) -> None:
    kind = str(obj.kind or "")
    pkind = str((obj.props or {}).get("kind") or "")
    if obj.id.startswith("evidence:") or "evidence" in (kind, pkind):
        raise HTTPException(
            status_code=403,
            detail="evidence objects are written through /api/evidence, not the generic route",
        )
    forged = sorted(_CUSTODY_PROPS & set((obj.props or {}).keys()))
    if forged:
        raise HTTPException(
            status_code=403,
            detail=f"custody properties {forged} are written by /api/evidence only",
        )


class ObjectSaved(Object):
    """What ``POST /api/ontology/object`` answers: the stored object, plus any
    way it departs from what its kind declares.

    A subclass rather than a wrapper so the round-trip contract the Investigation
    canvas depends on is untouched — every ``Object`` field is still at the top
    level, and a caller that does not know about ``warnings`` reads the same
    body it always did. The warnings are advisory and are NOT stored: the
    registry accepts the write either way (see ``intel/ontology_schema.py``).
    """

    warnings: list[str] = Field(default_factory=list)

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
    object_id: str, p: Principal = Depends(current_principal_or_local)
) -> Object:
    """Fetch one ontology object by its canonical id.

    Uses a ``:path`` converter because canonical ids contain a colon
    (``aircraft:4ca7b3``) — without it FastAPI would still match, but ``:path``
    also tolerates ids that themselves contain slashes.
    """
    reg = _reg(p)
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
    p: Principal = Depends(current_principal_or_local),
) -> list[Assertion]:
    """The evidenced property history of one object, newest first.

    Every row answers *who said this, when, how sure* (source, confidence,
    observed_at, optional derivation).
    """
    reg = _reg(p)
    return await reg.get_assertions(object_id, prop=prop, limit=limit)


@router.get("/api/ontology/schema")
async def ontology_schema() -> dict[str, Any]:
    """What the ontology declares: every relation with BOTH of its names, and
    the properties each known kind carries.

    Static, per-deployment, and identical for every caller, so it needs no auth
    dependency and no store round-trip. The Graph canvas reads it once to label
    an edge correctly when it is traversed from the target's end; the Explorer
    reads it to build typed facets.
    """
    return schema_payload()


@router.get("/api/ontology/search", response_model=list[Object])
async def search_objects(
    q: str = Query(..., min_length=1, max_length=200),
    kind: list[str] | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    p: Principal = Depends(current_principal_or_local),
) -> list[Object]:
    """Find ontology objects by words in their id, kind or property values.

    Distinct from ``/api/search/objects``, which searches the LIVE observation
    store — what is being emitted right now. This searches what was promoted
    into the graph and kept, which until now had no search at all: ``get`` needs
    the exact canonical id and ``list_by_kind`` filters one props field.
    """
    reg = _reg(p)
    return await reg.search(q, kinds=kind, limit=limit)


@router.post("/api/ontology/object", response_model=ObjectSaved)
async def upsert_object(
    obj: Object, p: Principal = Depends(current_principal_or_local)
) -> ObjectSaved:
    """Insert or merge one ontology object (RLS-scoped to the caller).

    The graph-shaping write the Investigation canvas (C4) uses to persist a saved
    investigation as a node (``investigation:<uuid>`` with the member ids in
    ``props.nodes``). ``kind`` is reconciled to the id prefix server-side
    (``upsert`` calls ``normalised()``), so a caller may omit it. This is NOT a
    kinetic action — no ``action_log`` audit row — so it stays here rather than in
    ``/api/actions``.

    The write happens first and unconditionally: ``warnings`` describes the
    object that was stored, it does not gate storing it.

    Two clearance gates run BEFORE the write, though. A caller may not classify
    above their own clearance or use a compartment they do not hold (the
    ``routes/extract.py`` ceiling), and may not land a write on a row they are
    not cleared to read — ``props`` is a WHOLESALE replace, so an ungated write
    is a way to destroy or declassify an object you cannot see.
    """
    _refuse_custody_writes(obj)
    _refuse_write_above_clearance(p, obj.classification, obj.compartments)
    await _refuse_overwrite_of_hidden_row(p, obj.id)
    # Unfiltered: the gates above already decided this caller may write here, and
    # ``upsert`` reads the prior row to diff props into assertions.
    reg = _reg(p, filtered=False)
    saved = await reg.upsert(obj)
    return ObjectSaved(
        **saved.model_dump(),
        warnings=validate_object(saved.kind, saved.props),
    )


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
    body: PromoteIn, p: Principal = Depends(current_principal_or_local)
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
    # evidence is a known kind, and assert_props MERGES: without this a promote
    # of ``evidence:<sha>`` rewrites the hash, type or custody a record vouches
    # for (ASVS V2.2.1). Same boundary as the object route, minus the custody-prop
    # names, which a promoted feed entity may legitimately carry.
    if prefix == "evidence" or str(body.props.get("kind") or "") == "evidence":
        raise HTTPException(
            status_code=403,
            detail="evidence objects are written through /api/evidence, not the generic route",
        )
    # ``assert_props`` MERGES into the existing row and RETURNS the merged
    # object, so an ungated promote onto a classified id is a read as much as a
    # write. ``PromoteIn`` carries no classification field and ``assert_props``
    # stamps a new row at level 0, so there is no requested level to ceiling
    # here — only the existing row to defend.
    await _refuse_overwrite_of_hidden_row(p, body.id)
    reg = _reg(p, filtered=False)
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
    p: Principal = Depends(current_principal_or_local),
) -> SearchAround:
    """Breadth-first neighbourhood of ``object_id`` up to ``depth`` hops (1–3).

    Returns the reachable objects + the links between them — the radial-graph
    payload the EntityPanel ConnectionsCard and the agent compose on. The center
    is always present even if it has no persisted row yet (a derived stub).
    """
    reg = _reg(p)
    return await reg.traverse(object_id, depth=depth)


@router.get("/api/ontology/analytics/{object_id:path}")
async def graph_analytics_route(
    object_id: str,
    depth: int = Query(2, ge=1, le=3),
    p: Principal = Depends(current_principal_or_local),
) -> dict[str, Any]:
    """Link-analysis metrics over the ``object_id`` neighbourhood (Phase 3).

    Expands the search-around graph to ``depth`` hops, then computes degree +
    betweenness centrality, connected-component communities, and a ranked
    ``key_nodes`` list (the most central actors — whose removal most fragments the
    network). This is the "who are the important nodes" question Gotham's graph
    explorer answers; ``search-around`` shows the graph, this scores it.
    """
    reg = _reg(p)
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
    p: Principal = Depends(current_principal_or_local),
) -> PathResult:
    """Shortest UNDIRECTED chain linking object ``a`` to object ``b``.

    Breadth-first over the link graph (edges connect both ways for path-finding),
    bounded by ``max_depth`` hops (1–6, default 4). Returns the ordered node ids +
    the edges along the chain — the two-entity path-finding the Investigation
    canvas (C4) draws. ``found=False`` (empty path) when no chain exists within the
    budget, which the canvas surfaces honestly rather than as an error.
    """
    reg = _reg(p)
    return await reg.path_between(a, b, max_depth=max_depth)
