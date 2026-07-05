"""Target lifecycle board — /api/targets/board (F2T2EA Kanban).

A target entry tracks ONE live entity (aircraft / vessel / sim object) through
the find-fix-track-target-engage-assess kill chain, expressed as a Kanban stage.
Stored per user in Supabase ``public.target_board`` (RLS-scoped via the caller's
token, the exact same pattern as ``alert_rules``/BYOK).

This persists + manages entries; the frontend Kanban owns drag/drop UX and keeps
a working copy in memory so it functions with no Supabase configured (the route
answers 503, the store stays local). One entry per (user, entity) — moving an
entity across stages PATCHes the existing row.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.intel.actions import audit_row
from app.keys import UserCtx, _client, _headers, current_user

router = APIRouter(tags=["targets"])

# F2T2EA kill-chain stages, in board order. `confirm` = find/fix the object,
# `attach_intel` = enrich it, `approvals` = authority to act, `weaponeer` =
# match effect to target, `execute` = engage, `assess` = BDA, `complete` = done.
STAGES = (
    "confirm",
    "attach_intel",
    "approvals",
    "weaponeer",
    "execute",
    "assess",
    "complete",
)
STAGE_SET = frozenset(STAGES)
STAGE_INDEX = {name: i for i, name in enumerate(STAGES)}

# A target may move at most this many stages per transition. F2T2EA is a strict
# ordered chain: you advance one stage at a time (no skipping confirm→execute)
# and may step back one (e.g. re-attack: assess→execute, or pull approvals
# back to weaponeer). Anything beyond ±1 is rejected as an illegal transition.
_MAX_STAGE_STEP = 1

# F2T2EA confirmation checklist. A target carries a boolean per requirement; a
# stage may not be ENTERED until the requirements gating it are all met (unless
# the caller forces it, which is audited). This mirrors the Gotham target-detail
# "Confirmation checklist" — you cannot move to Approvals without a confirmed
# identity + verified location, nor Execute without an authority sign-off.
REQUIREMENT_KEYS = (
    "target_identity",     # the object is positively identified
    "location_verified",   # its geolocation is confirmed
    "collateral_estimate", # collateral-damage estimate done
    "authority_signoff",   # engagement authority has signed off
)
REQUIREMENT_SET = frozenset(REQUIREMENT_KEYS)

# Which requirements must be TRUE to advance INTO each stage. Stages not listed
# gate on nothing (e.g. confirm/attach_intel/assess/complete).
STAGE_REQUIREMENTS: dict[str, tuple[str, ...]] = {
    "approvals": ("target_identity", "location_verified"),
    "weaponeer": ("target_identity", "location_verified"),
    "execute": ("target_identity", "location_verified", "collateral_estimate", "authority_signoff"),
}


def _next_stage(stage: str | None) -> str | None:
    i = STAGE_INDEX.get(str(stage))
    return STAGES[i + 1] if i is not None and i + 1 < len(STAGES) else None


def _unmet_for(stage: str | None, requirements: dict) -> list[str]:
    """Requirement keys still unmet for ENTERING ``stage`` (in order)."""
    req = requirements if isinstance(requirements, dict) else {}
    return [k for k in STAGE_REQUIREMENTS.get(str(stage), ()) if not req.get(k)]


def _is_locked(stage: str | None, requirements: dict) -> bool:
    """A target is locked when advancing to its NEXT stage is currently blocked
    by an unmet requirement — drives the lock badge + the drag refusal."""
    nxt = _next_stage(stage)
    return bool(nxt and _unmet_for(nxt, requirements))


def _to_target(row: dict) -> Target:
    """Build a Target from a stored row, computing the derived ``locked`` flag.
    Tolerant of legacy rows missing the requirements/classification columns."""
    req = row.get("requirements") or {}
    return Target(
        id=str(row["id"]),
        entity_id=str(row["entity_id"]),
        stage=str(row.get("stage", "confirm")),
        priority=int(row.get("priority", 3)),
        note=str(row.get("note") or ""),
        requirements={k: bool(req.get(k)) for k in REQUIREMENT_KEYS},
        classification=str(row.get("classification") or "UNCLAS//FOUO"),
        locked=_is_locked(row.get("stage"), req),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


def _rest(s: Settings) -> str:
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    return s.supabase_url.rstrip("/") + "/rest/v1/target_board"


class TargetIn(BaseModel):
    entity_id: str = Field(..., min_length=1, max_length=200)
    stage: str = "confirm"
    priority: int = Field(3, ge=1, le=5)
    note: str = Field("", max_length=2000)
    requirements: dict[str, bool] = Field(default_factory=dict)
    classification: str = Field("UNCLAS//FOUO", max_length=120)


class TargetPatch(BaseModel):
    # All optional — a move sends only `stage`, a re-prioritise only `priority`,
    # a checklist toggle only `requirements`. `force` is a control flag (NOT a
    # column): advance past an unmet checklist, audited as a forced move.
    stage: str | None = None
    priority: int | None = Field(None, ge=1, le=5)
    note: str | None = Field(None, max_length=2000)
    requirements: dict[str, bool] | None = None
    classification: str | None = Field(None, max_length=120)
    force: bool = False


class Target(BaseModel):
    id: str
    entity_id: str
    stage: str
    priority: int
    note: str = ""
    requirements: dict[str, bool] = Field(default_factory=dict)
    classification: str = "UNCLAS//FOUO"
    locked: bool = False  # derived: advancing to the next stage is gated
    created_at: str | None = None
    updated_at: str | None = None


def _validate_stage(stage: str | None) -> None:
    if stage is not None and stage not in STAGE_SET:
        raise HTTPException(status_code=400, detail=f"unknown stage: {stage}")


def _validate_transition(frm: str, to: str) -> None:
    """Gate a stage move against the ordered F2T2EA chain.

    Both ends must be known stages; a move is legal only when it advances or
    retreats by at most ``_MAX_STAGE_STEP`` step in ``STAGES`` order. A move to
    the same stage is a no-op and never reaches here. Rejects with 409 (the
    transition conflicts with the chain) carrying the from/to so the UI can
    explain the block.
    """
    if frm not in STAGE_INDEX or to not in STAGE_INDEX:
        # An unknown stored stage (older row, manual DB edit) — fall back to
        # plain enum membership on the target only; don't 500 on legacy data.
        _validate_stage(to)
        return
    delta = STAGE_INDEX[to] - STAGE_INDEX[frm]
    if abs(delta) > _MAX_STAGE_STEP:
        raise HTTPException(
            status_code=409,
            detail=(
                f"illegal stage transition {frm} → {to}: F2T2EA advances one "
                f"stage at a time (allowed step ±{_MAX_STAGE_STEP})"
            ),
        )


async def _fetch_target(
    c, s: Settings, ctx: UserCtx, target_id: str
) -> dict | None:  # type: ignore[no-untyped-def]
    """Read one board row (own rows only, RLS-scoped) so the PATCH can gate the
    transition against the CURRENT stage. Returns the row dict or None (404)."""
    r = await c.get(
        _rest(s),
        params={
            "id": f"eq.{target_id}",
            "user_id": f"eq.{ctx.user_id}",
            "select": "*",
            "limit": "1",
        },
        headers=_headers(ctx, s),
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="target store unavailable")
    rows = r.json()
    return rows[0] if isinstance(rows, list) and rows else None


async def _append_transition_audit(
    c, s: Settings, ctx: UserCtx, target_id: str, frm: str, to: str, forced: bool = False
) -> dict | None:  # type: ignore[no-untyped-def]
    """Append one ``action_log`` row recording WHO moved a target and the
    from→to stages, reusing ``actions.audit_row`` for the shape.

    Best-effort: the stage move has already landed, so a failed audit must NOT
    flip the operator-visible move to an error. We return the row on success and
    None on any failure (logged by absence — the receipt simply isn't echoed).
    The action name ``advance_stage`` joins the same governed-write-back log the
    EntityPanel verbs write to, so the kill-chain history is one trail.
    """
    row = audit_row(
        ctx,
        "advance_stage",
        target_id,
        {"from": frm, "to": to, "forced": forced},
    )
    try:
        url = s.supabase_url.rstrip("/") + "/rest/v1/action_log"
        r = await c.post(
            url,
            json=row,
            headers={**_headers(ctx, s, write=True), "Prefer": "return=minimal"},
        )
        if r.status_code not in (200, 201, 204):
            return None
    except Exception:
        return None
    return row


@router.get("/api/targets/board", response_model=list[Target])
async def list_targets(ctx: UserCtx = Depends(current_user)) -> list[Target]:
    s = get_settings()
    async with _client() as c:
        r = await c.get(
            _rest(s),
            params={
                "user_id": f"eq.{ctx.user_id}",
                "select": "*",
                "order": "created_at.desc",
            },
            headers=_headers(ctx, s),
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="target store unavailable")
    return [_to_target(row) for row in r.json()]


@router.post("/api/targets/board", response_model=Target, status_code=201)
async def create_target(
    body: TargetIn, ctx: UserCtx = Depends(current_user)
) -> Target:
    _validate_stage(body.stage)
    s = get_settings()
    row = {**body.model_dump(), "user_id": ctx.user_id}
    # unique(user_id, entity_id): re-adding the same entity upserts instead of
    # erroring, so the board never duplicates a track. return=representation so
    # we hand back the stored row (with its id + timestamps).
    headers = {
        **_headers(ctx, s, write=True),
        "Prefer": "resolution=merge-duplicates,return=representation",
    }
    async with _client() as c:
        r = await c.post(_rest(s), json=row, headers=headers)
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="could not save target")
    created = r.json()
    return _to_target(created[0] if isinstance(created, list) else created)


@router.patch("/api/targets/board/{target_id}", response_model=Target)
async def update_target(
    target_id: str, body: TargetPatch, ctx: UserCtx = Depends(current_user)
) -> Target:
    _validate_stage(body.stage)
    s = get_settings()
    headers = {**_headers(ctx, s, write=True), "Prefer": "return=representation"}
    # We need the current row to (a) gate a stage move against the chain, and (b)
    # MERGE a partial checklist toggle into the stored requirements — a jsonb
    # PATCH replaces the whole column, so a partial dict would wipe the other
    # gates. Fetch once when either is in play.
    need_current = body.stage is not None or body.requirements is not None
    async with _client() as c:
        current = await _fetch_target(c, s, ctx, target_id) if need_current else None
        if need_current and current is None:
            raise HTTPException(status_code=404, detail="target not found")
        cur_req = (current or {}).get("requirements") if current else {}
        cur_req = cur_req if isinstance(cur_req, dict) else {}
        merged_req = {**cur_req, **(body.requirements or {})}

        # Build the persisted patch. `force` is a control flag, never a column;
        # `requirements` is sent MERGED (full dict) so a toggle keeps the others.
        patch: dict = {}
        if body.stage is not None:
            patch["stage"] = body.stage
        if body.priority is not None:
            patch["priority"] = body.priority
        if body.note is not None:
            patch["note"] = body.note
        if body.classification is not None:
            patch["classification"] = body.classification
        if body.requirements is not None:
            patch["requirements"] = merged_req
        if not patch:
            raise HTTPException(status_code=400, detail="empty update")

        # Gate a real stage move: legal ±1 step AND, when ADVANCING, the entered
        # stage's checklist must be complete — unless the caller forces it.
        prev_stage: str | None = current.get("stage") if current else None
        forced = False
        if body.stage is not None and prev_stage != body.stage:
            _validate_transition(str(prev_stage), str(body.stage))
            advancing = STAGE_INDEX.get(str(body.stage), 0) > STAGE_INDEX.get(str(prev_stage), 0)
            if advancing:
                unmet = _unmet_for(body.stage, merged_req)
                if unmet and not body.force:
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"checklist incomplete to enter {body.stage}: "
                            f"{', '.join(unmet)} not met"
                        ),
                    )
                forced = bool(unmet)  # advanced past an unmet gate = forced move

        r = await c.patch(
            _rest(s),
            params={"id": f"eq.{target_id}", "user_id": f"eq.{ctx.user_id}"},
            json=patch,
            headers=headers,
        )
        if r.status_code not in (200, 204):
            raise HTTPException(status_code=502, detail="could not update target")
        updated = r.json()
        if not updated:
            raise HTTPException(status_code=404, detail="target not found")

        if body.stage is not None and prev_stage is not None and prev_stage != body.stage:
            await _append_transition_audit(
                c, s, ctx, target_id, str(prev_stage), str(body.stage), forced=forced
            )

    return _to_target(updated[0] if isinstance(updated, list) else updated)


@router.get("/api/targets/board/{target_id}/audit")
async def target_audit(
    target_id: str, ctx: UserCtx = Depends(current_user)
) -> list[dict]:
    """Stage-transition history for one target (own rows only, newest first).

    Reads the shared ``action_log`` filtered to this target's ``advance_stage``
    rows so the Kanban can show WHO moved a card and WHEN. Returns ``[]`` (not a
    404/500) when the log is empty or the table is absent — the audit trail is a
    best-effort overlay, never a hard dependency of the board."""
    s = get_settings()
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    url = s.supabase_url.rstrip("/") + "/rest/v1/action_log"
    async with _client() as c:
        r = await c.get(
            url,
            params={
                "user_id": f"eq.{ctx.user_id}",
                "target_id": f"eq.{target_id}",
                "action": "eq.advance_stage",
                "select": "action,target_id,params,ts",
                "order": "ts.desc",
                "limit": "20",
            },
            headers=_headers(ctx, s),
        )
    if r.status_code != 200:
        return []
    rows = r.json()
    return rows if isinstance(rows, list) else []


@router.delete("/api/targets/board/{target_id}", status_code=204)
async def delete_target(target_id: str, ctx: UserCtx = Depends(current_user)) -> None:
    s = get_settings()
    async with _client() as c:
        r = await c.delete(
            _rest(s),
            params={"id": f"eq.{target_id}", "user_id": f"eq.{ctx.user_id}"},
            headers=_headers(ctx, s),
        )
    if r.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail="could not delete target")
