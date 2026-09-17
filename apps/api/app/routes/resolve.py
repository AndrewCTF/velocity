"""GET/POST /api/resolve/candidates — the entity-resolution merge review queue.

``intel/resolve.py`` records a conflict the moment two observations disagree
about which real-world object they are (``merge_candidates``), and NEVER
auto-merges it — a false merge is misattribution, the cardinal OSINT sin. That
left every conflict sitting in a table nobody could see or act on. This router
is the queue an operator reviews from the Inbox: list the open candidates,
scored highest-confidence-first, and approve or reject each one.

Approve is the only path that actually merges anything (``resolve.decide``):
it repoints the loser's aliases onto the winner and, when both ids are ontology
object ids (a known ``kind:`` prefix — see ``ontology.kind_of``), also records
a ``same_as`` link and a ``merged_from`` assertion in the ontology so a dossier
or graph walk sees the merge too. A bare ``entity:vessel:imo:...`` id (minted
when no ontology object shares that prefix) skips the ontology write and says
so in the response, rather than writing a link to something that was never a
graph node.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.audit import audit, audit_mutation
from app.intel import resolve
from app.intel.ontology import Link, get_registry, kind_of
from app.keys import UserCtx, current_user_or_local
from app.security import require_operator

router = APIRouter(tags=["resolve"], dependencies=[Depends(audit_mutation)])


@router.get("/api/resolve/candidates")
async def get_candidates(
    status: str = Query("open"),
    limit: int = Query(100, ge=1, le=1000),
) -> list[dict[str, Any]]:
    return resolve.list_candidates(status=status, limit=limit)


async def _decide(a: str, b: str, verdict: str, ctx: UserCtx) -> dict[str, Any]:
    try:
        result = resolve.decide(a, b, verdict, ctx.user_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    ontology_note: str | None = None
    if verdict == "approve":
        if kind_of(a) != "object" and kind_of(b) != "object":
            reg = get_registry(ctx)
            await reg.link(Link(src=a, dst=b, rel="same_as", source="resolve:operator"))
            await reg.assert_props(a, {"merged_from": b}, source="resolve:operator")
            ontology_note = "linked same_as in the ontology"
        else:
            ontology_note = "skipped: not both ontology object ids"

    await audit(
        ctx,
        f"resolve.{verdict}",
        "resolve",
        f"{a}/{b}",
        detail={"id_a": a, "id_b": b},
    )
    return {**result, "ontology": ontology_note}


@router.post(
    "/api/resolve/candidates/{a}/{b}/approve", dependencies=[Depends(require_operator)]
)
async def approve_candidate(
    a: str, b: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    return await _decide(a, b, "approve", ctx)


@router.post(
    "/api/resolve/candidates/{a}/{b}/reject", dependencies=[Depends(require_operator)]
)
async def reject_candidate(
    a: str, b: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    return await _decide(a, b, "reject", ctx)
