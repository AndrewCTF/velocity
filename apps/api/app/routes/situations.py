"""Situations — the Gotham-style aggregate object (Track: Palantir UX parity).

A *Situation* is a persistent, analyst-curated case file (Gotham's "PLA Military
Exercise" / "South China Sea Situation"): a name, a severity, a lifecycle status,
an area of interest, a free-text summary, and a set of LINKED children (incidents,
aircraft, vessels, watchboxes, annotations, COAs). It is persisted as an **ontology
object** (``props.kind='situation'``, id ``situation:<uuid>``) via the P0
``OntologyRegistry`` — no new table, RLS-scoped to the caller, exactly the
``maps.py`` precedent. Children are ontology LINKS (``situation --contains--> …``),
NOT embedded in props, so the Link/search-around graph already renders them.

    GET    /api/situations                 → list the caller's situations (newest first)
    POST   /api/situations                 → create / overwrite a situation
    GET    /api/situations/{id}             → one situation + its 1-hop neighbourhood
    DELETE /api/situations/{id}             → delete a situation
    POST   /api/situations/{id}/link        → attach a child (the missing link-write)
    POST   /api/situations/{id}/coa/propose → grounded-LLM Courses of Action (hypothetical)

Everything degrades to 503 when Supabase is unconfigured (the store-not-configured
contract). The COA endpoint additionally degrades to ``ok:false`` when no reasoning
model is wired — it NEVER fabricates a course of action.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import llm
from app.config import Settings, get_settings
from app.intel.ontology import Link, Object, OntologyRegistry
from app.keys import UserCtx, _client, _headers, current_user

router = APIRouter(tags=["situations"])

# Semantic kind lives in ``props.kind`` (the structural ``kind`` column stays the
# catch-all "object", mirroring maps.py) so a list query filters on props->>kind.
_SITUATION_KIND = "situation"
_MAX_LIST = 200

Severity = Literal["critical", "high", "med", "low"]
Status = Literal["active", "monitoring", "resolved", "archived"]


# ── models ──────────────────────────────────────────────────────────────────────


class Centroid(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)


class SituationIn(BaseModel):
    """Create/overwrite payload. Omit ``id`` to mint a fresh ``situation:<uuid>``."""

    name: str = Field("Untitled situation", min_length=1, max_length=160)
    severity: Severity = "med"
    status: Status = "active"
    centroid: Centroid | None = None
    radius_km: float = Field(50.0, ge=0, le=20_000)
    summary: str = Field("", max_length=8000)
    report: str = Field("", max_length=20000)
    id: str | None = Field(None, max_length=200)


class Situation(BaseModel):
    """A persisted situation as returned to the client."""

    id: str
    name: str
    severity: Severity
    status: Status
    centroid: Centroid | None = None
    radius_km: float = 50.0
    summary: str = ""
    report: str = ""
    updated_at: str | None = None
    created_at: str | None = None


class SituationDetail(BaseModel):
    """One situation plus its 1-hop neighbourhood (linked children + edges)."""

    situation: Situation
    objects: list[Object] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)


class LinkIn(BaseModel):
    dst: str = Field(..., min_length=1, max_length=200)
    rel: str = Field("contains", min_length=1, max_length=60)
    props: dict[str, Any] = Field(default_factory=dict)


class CoaCard(BaseModel):
    title: str
    side: Literal["enemy", "friendly"]
    likelihood: Literal["low", "med", "high"]
    rationale: str = ""


# ── object ↔ situation coercion (one place, like maps.py) ────────────────────────


def _to_object(sit_id: str, body: SituationIn, ts: str) -> Object:
    return Object(
        id=sit_id,
        kind="object",  # structural kind stays catch-all; semantic kind is in props
        props={
            "kind": _SITUATION_KIND,
            "name": body.name,
            "severity": body.severity,
            "status": body.status,
            "centroid": body.centroid.model_dump() if body.centroid else None,
            "radius_km": body.radius_km,
            "summary": body.summary,
            "report": body.report,
            "updated_at": ts,
        },
    )


def _from_object(obj: Object) -> Situation | None:
    """Adapt an ontology Object back to a Situation, or ``None`` if it isn't one."""
    props = obj.props or {}
    if props.get("kind") != _SITUATION_KIND:
        return None
    cen = props.get("centroid")
    try:
        centroid = Centroid.model_validate(cen) if cen else None
    except Exception:  # noqa: BLE001 — a malformed blob loads with no AOI
        centroid = None
    return Situation(
        id=obj.id,
        name=str(props.get("name") or obj.id),
        severity=props.get("severity") if props.get("severity") in ("critical", "high", "med", "low") else "med",  # type: ignore[arg-type]
        status=props.get("status") if props.get("status") in ("active", "monitoring", "resolved", "archived") else "active",  # type: ignore[arg-type]
        centroid=centroid,
        radius_km=float(props.get("radius_km") or 50.0),
        summary=str(props.get("summary") or ""),
        report=str(props.get("report") or ""),
        updated_at=props.get("updated_at"),
        created_at=obj.created_at,
    )


def _situations_url(s: Settings) -> str:
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    return s.supabase_url.rstrip("/") + "/rest/v1/objects"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ── HTTP: list / create / load / delete ──────────────────────────────────────────


@router.get("/api/situations", response_model=list[Situation])
async def list_situations(ctx: UserCtx = Depends(current_user)) -> list[Situation]:
    """The caller's situations, newest first (filtered to props->>kind=situation)."""
    s = get_settings()
    async with _client() as c:
        r = await c.get(
            _situations_url(s),
            params={
                "user_id": f"eq.{ctx.user_id}",
                "props->>kind": f"eq.{_SITUATION_KIND}",
                "select": "id,kind,props,created_at",
                "order": "created_at.desc",
                "limit": str(_MAX_LIST),
            },
            headers=_headers(ctx, s),
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="situation store unavailable")
    rows = r.json()
    out: list[Situation] = []
    for row in rows if isinstance(rows, list) else []:
        obj = Object(
            id=row.get("id"),
            kind=row.get("kind") or "object",
            props=row.get("props") or {},
            created_at=row.get("created_at"),
        )
        sit = _from_object(obj)
        if sit is not None:
            out.append(sit)
    return out


@router.post("/api/situations", response_model=Situation, status_code=201)
async def create_situation(
    body: SituationIn, ctx: UserCtx = Depends(current_user)
) -> Situation:
    """Create (insert) or overwrite (when ``id`` is supplied) a situation."""
    sit_id = body.id or f"{_SITUATION_KIND}:{uuid.uuid4().hex[:12]}"
    if not sit_id.startswith(f"{_SITUATION_KIND}:"):
        raise HTTPException(status_code=400, detail="id must start with 'situation:'")
    reg = OntologyRegistry(ctx, get_settings())
    stored = await reg.upsert(_to_object(sit_id, body, _now_iso()))
    sit = _from_object(stored)
    if sit is None:
        raise HTTPException(status_code=502, detail="could not save situation")
    return sit


@router.get("/api/situations/{sit_id:path}", response_model=SituationDetail)
async def get_situation_detail(
    sit_id: str, ctx: UserCtx = Depends(current_user)
) -> SituationDetail:
    """One situation + its 1-hop neighbourhood (linked incidents/entities/COAs).

    ``traverse(depth=1)`` returns the children even if they aren't persisted as
    their own rows (derived stubs from the id prefix), so a link to a live-but-
    unsaved ``incident:…`` still appears in the Intel tab.
    """
    reg = OntologyRegistry(ctx, get_settings())
    obj = await reg.get(sit_id)
    sit = _from_object(obj) if obj is not None else None
    if sit is None:
        raise HTTPException(status_code=404, detail="situation not found")
    around = await reg.traverse(sit_id, depth=1)
    # Drop the center node from the children list — the panel already has it.
    children = [o for o in around.objects if o.id != sit_id]
    return SituationDetail(situation=sit, objects=children, links=around.links)


@router.delete("/api/situations/{sit_id:path}", status_code=204)
async def delete_situation(sit_id: str, ctx: UserCtx = Depends(current_user)) -> None:
    """Delete a situation (own rows only). A missing row is a no-op."""
    s = get_settings()
    async with _client() as c:
        r = await c.delete(
            _situations_url(s),
            params={"id": f"eq.{sit_id}", "user_id": f"eq.{ctx.user_id}"},
            headers=_headers(ctx, s),
        )
    if r.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail="could not delete situation")


@router.post("/api/situations/{sit_id:path}/link", response_model=Link)
async def link_child(
    sit_id: str, body: LinkIn, ctx: UserCtx = Depends(current_user)
) -> Link:
    """Attach a child to a situation: ``situation --rel--> dst``.

    The one relationship-write the Situation/COA feature needs (``routes/ontology.py``
    exposes object upsert + traversal but no link route). Idempotent on
    ``(user_id, src, dst, rel)``.
    """
    reg = OntologyRegistry(ctx, get_settings())
    return await reg.link(Link(src=sit_id, dst=body.dst, rel=body.rel, props=body.props))


# ── grounded COA proposal ─────────────────────────────────────────────────────────

_COA_SYSTEM = (
    "You are a defence analyst producing OPEN-SOURCE Courses of Action (COAs) for "
    "situational awareness (CSIS / RAND public-study style). You are given a "
    "situation and its LINKED EVIDENCE (incident narratives, tracked entities). "
    "Propose plausible enemy and friendly COAs that REASON ONLY over the evidence "
    "provided. Do NOT invent units, weapons, place names, dates, or events not "
    "present in the evidence. Every COA is HYPOTHETICAL and clearly an estimate; "
    "produce no operational targeting or planning detail.\n\n"
    "Return STRICT JSON and nothing else:\n"
    "{\n"
    '  "coas": [\n'
    '    {"title": str, "side": "enemy|friendly", '
    '"likelihood": "low|med|high", "rationale": "1-2 sentences citing the evidence"}\n'
    "  ]\n"
    "}\n"
    "Give 2-4 enemy and 2-4 friendly COAs when the evidence supports them; fewer if "
    "it does not. If the evidence is too thin to reason, return an empty list."
)


@router.post("/api/situations/{sit_id:path}/coa/propose")
async def propose_coas(
    sit_id: str, ctx: UserCtx = Depends(current_user)
) -> dict[str, Any]:
    """Grounded-LLM COAs over the situation's linked evidence (hypothetical, not saved).

    Gathers the situation + its 1-hop neighbourhood, hands the reasoning model ONLY
    those facts, and returns hypothetical COA cards. The analyst persists the ones
    worth keeping via ``/api/ontology/object`` (a ``coa:<uuid>`` node) + this
    router's ``/link``. Degrades to ``ok:false`` (never a fabricated COA) when no
    model is configured.
    """
    reg = OntologyRegistry(ctx, get_settings())
    obj = await reg.get(sit_id)
    sit = _from_object(obj) if obj is not None else None
    if sit is None:
        raise HTTPException(status_code=404, detail="situation not found")
    around = await reg.traverse(sit_id, depth=1)
    evidence = {
        "situation": {
            "name": sit.name,
            "severity": sit.severity,
            "summary": sit.summary,
            "aoi": sit.centroid.model_dump() if sit.centroid else None,
        },
        "linked": [
            {"id": o.id, "kind": o.kind, "props": o.props}
            for o in around.objects
            if o.id != sit_id
        ][:30],
    }
    user = "Situation and linked evidence:\n" + json.dumps(evidence)[:6000]
    parsed, res = await llm.chat_json(
        [{"role": "system", "content": _COA_SYSTEM}, {"role": "user", "content": user}],
        tier="reason",
        temperature=0.2,
        max_tokens=1200,
    )
    if not res.ok or not isinstance(parsed, dict):
        return {
            "ok": False,
            "error": res.error or "model unavailable",
            "model": res.model,
            "coas": [],
        }
    raw = parsed.get("coas") if isinstance(parsed.get("coas"), list) else []
    coas: list[dict[str, Any]] = []
    for c in raw:
        try:
            coas.append(CoaCard.model_validate(c).model_dump())
        except Exception:  # noqa: BLE001 — skip a malformed card, keep the rest
            continue
    return {"ok": True, "model": res.model, "backend": res.backend, "coas": coas}
