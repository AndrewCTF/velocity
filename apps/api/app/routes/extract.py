"""POST /api/extract — pull ontology objects/links out of unstructured text.

The document-entity-extraction surface (Gotham parity): paste text, an LLM
(NVIDIA MiniMax-M3 → DeepSeek → Ollama, via ``app.llm``) reads it under a strict
JSON schema, and we persist a source Document object plus the extracted entities
and relationships into the per-user ontology. Every row is stamped with the
request's classification + compartments (never above the caller's own clearance),
provenance links run document → entity, and each extraction writes one immutable
audit row. ``commit=false`` returns a preview without writing.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import llm
from app.audit import audit
from app.config import get_settings
from app.intel import classification as clf
from app.intel.ontology import Link, Object, OntologyRegistry
from app.keys import UserCtx
from app.security import Principal, current_principal

router = APIRouter(tags=["extract"])

_MAX_TEXT = 40_000
_ENTITY_TYPES = {
    "Person", "Organization", "Location", "Vessel", "Aircraft", "Event", "Document", "Other",
}
_TYPES_LC = {t.lower() for t in _ENTITY_TYPES}


class ExtractRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=_MAX_TEXT)
    title: str = Field("", max_length=200)
    situation_id: str | None = Field(None, max_length=200)
    classification: int = 0
    compartments: list[str] = Field(default_factory=list)
    shared: bool = False
    commit: bool = True  # False → preview only, no writes


class ExtractedEntity(BaseModel):
    id: str
    entity_type: str
    name: str
    props: dict[str, Any] = Field(default_factory=dict)


class ExtractedLink(BaseModel):
    src: str
    dst: str
    rel: str


class ExtractResponse(BaseModel):
    document_id: str
    marking: str
    entities: list[ExtractedEntity]
    links: list[ExtractedLink]
    committed: bool


def _slug(s: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", s.strip().lower()).strip("-")
    return out[:64] or "x"


def _entity_id(etype: str, name: str) -> str:
    t = etype.strip().lower()
    if t not in _TYPES_LC:
        t = "other"
    return f"ext:{t}:{_slug(name)}"


_PROMPT = (
    "You are an intelligence analyst extracting a knowledge graph from a document. "
    'Return ONLY JSON of the form {"entities":[{"type":<one of '
    "Person|Organization|Location|Vessel|Aircraft|Event|Document|Other>,"
    '"name":str,"attributes":{}}],"relationships":[{"source":name,"relation":str,'
    '"target":name}]}. Use names exactly as they appear. Relations are short verbs '
    "(owns, member_of, located_in, shipped_by, associated_with). Do not invent facts "
    "that are not in the text."
)


async def _run_llm(text: str, token: str, uid: str) -> dict[str, Any]:
    bound = llm.bind_user(uid, token)
    try:
        parsed, res = await llm.chat_json(
            [
                {"role": "system", "content": _PROMPT},
                {"role": "user", "content": text},
            ],
            tier="fast",
            max_tokens=2048,
            label="doc-extract",
        )
    finally:
        llm.reset_user(bound)
    if parsed is None:
        backend = getattr(res, "backend", "") or "none"
        raise HTTPException(status_code=502, detail=f"extraction model unavailable ({backend})")
    return parsed if isinstance(parsed, dict) else {}


def _normalise(parsed: dict[str, Any]) -> tuple[list[ExtractedEntity], list[ExtractedLink]]:
    """Dedup entities by (type, slug(name)); resolve relationship endpoints by name."""
    ents: dict[str, ExtractedEntity] = {}
    name_to_id: dict[str, str] = {}
    for e in parsed.get("entities", []) or []:
        if not isinstance(e, dict):
            continue
        name = str(e.get("name") or "").strip()
        if not name:
            continue
        etype = str(e.get("type") or "Other").strip().title()
        if etype not in _ENTITY_TYPES:
            etype = "Other"
        eid = _entity_id(etype, name)
        name_to_id[name.lower()] = eid
        if eid not in ents:
            attrs = e.get("attributes")
            ents[eid] = ExtractedEntity(
                id=eid,
                entity_type=etype,
                name=name,
                props=dict(attrs) if isinstance(attrs, dict) else {},
            )
    links: list[ExtractedLink] = []
    seen: set[tuple[str, str, str]] = set()
    for r in parsed.get("relationships", []) or []:
        if not isinstance(r, dict):
            continue
        src = name_to_id.get(str(r.get("source") or "").strip().lower())
        dst = name_to_id.get(str(r.get("target") or "").strip().lower())
        rel = (str(r.get("relation") or "associated_with").strip()[:60]) or "associated_with"
        if not src or not dst or src == dst:
            continue
        key = (src, dst, rel)
        if key in seen:
            continue
        seen.add(key)
        links.append(ExtractedLink(src=src, dst=dst, rel=rel))
    return list(ents.values()), links


@router.post("/api/extract", response_model=ExtractResponse)
async def extract(
    req: ExtractRequest, p: Principal = Depends(current_principal)
) -> ExtractResponse:
    s = get_settings()
    level = clf.clamp(req.classification)
    if level > p.clearance:
        raise HTTPException(status_code=403, detail="cannot classify above your clearance")
    if not clf.holds(p.compartments, req.compartments):
        raise HTTPException(status_code=403, detail="cannot use compartments you do not hold")

    parsed = await _run_llm(req.text, p.token, p.user_id)
    entities, links = _normalise(parsed)
    doc_id = f"ext:document:{uuid.uuid4().hex[:12]}"
    marking = clf.marking(level, req.compartments)

    if not req.commit:
        return ExtractResponse(
            document_id=doc_id, marking=marking, entities=entities, links=links, committed=False
        )

    ctx = UserCtx(user_id=p.user_id, token=p.token)
    reg = OntologyRegistry(ctx, s)
    comps = req.compartments

    await reg.upsert(
        Object(
            id=doc_id,
            kind="object",
            props={
                "entity_type": "Document",
                "title": req.title or "Extracted document",
                "preview": req.text[:280],
                "situation_id": req.situation_id,
            },
            classification=level,
            compartments=comps,
            shared=req.shared,
        )
    )
    for e in entities:
        await reg.upsert(
            Object(
                id=e.id,
                kind="object",
                props={"entity_type": e.entity_type, "name": e.name, **e.props},
                classification=level,
                compartments=comps,
                shared=req.shared,
            )
        )
        await reg.link(
            Link(src=doc_id, dst=e.id, rel="mentions",
                 classification=level, compartments=comps, shared=req.shared)
        )
    for lk in links:
        await reg.link(
            Link(src=lk.src, dst=lk.dst, rel=lk.rel,
                 classification=level, compartments=comps, shared=req.shared)
        )

    await audit(
        ctx, "extract", "document", doc_id,
        classification=level,
        detail={"entities": len(entities), "links": len(links), "situation_id": req.situation_id},
    )
    return ExtractResponse(
        document_id=doc_id, marking=marking, entities=entities, links=links, committed=True
    )
