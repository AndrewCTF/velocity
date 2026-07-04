"""Governed write-back — the *verbs* layer over the ontology (Track C1).

The ontology (``intel/ontology.py``) is the typed nouns; this is the typed verbs.
An ``ActionSpec`` binds an action name → a Pydantic param model → an async handler
that:

  1. validates the params (the Pydantic model rejects bad input → 400),
  2. mutates the ontology (upserts objects / links through ``OntologyRegistry``)
     and fires the relevant side effect (a ``target_board`` POST, an
     ``alert_rules`` POST, …), reusing the existing PostgREST patterns, and
  3. appends an **audit row** to ``public.action_log`` recording WHO
     (``ctx.user_id``), WHAT (action name), the TARGET id, and the params.

**Audit-of-who, not RBAC.** ``keys.py:UserCtx`` is ``{user_id, token}`` — there is
no role field. v1 records *who* performed each action (``user_id``); true
role-gating ("only an approver may execute") is deliberately deferred until a
multi-authority requirement is confirmed. We do NOT invent an RBAC model here.

First actions:
  - ``flag_entity``      — flag an object with a note + severity (ontology only).
  - ``promote_incident`` — promote an object to a tracked incident node + edge.
  - ``nominate_target``  — add the object to the F2T2EA ``target_board`` (wraps the
                           same POST as ``routes/targets.py``).
  - ``add_watch``        — create a standing geofence ``alert_rules`` row (wraps the
                           same POST as ``routes/alert_rules.py``).

Everything degrades gracefully when Supabase is unconfigured (the registry / REST
calls raise 503 with the "store not configured" contract). The module imports with
no side effects.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field, ValidationError

from app.config import Settings, get_settings
from app.intel.ontology import Link, Object, OntologyRegistry
from app.keys import UserCtx, _client, _headers

# ── audit log ─────────────────────────────────────────────────────────────────


def _action_log_url(s: Settings) -> str:
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    return s.supabase_url.rstrip("/") + "/rest/v1/action_log"


def audit_row(ctx: UserCtx, action: str, target_id: str, params: dict[str, Any]) -> dict[str, Any]:
    """Shape one ``action_log`` row. Pure (no I/O) so tests can assert on it.

    ``ts`` is a server-side UTC ISO-8601 stamp; the DB column also defaults to
    ``now()`` but we set it here so the returned receipt carries it without a
    round trip.
    """
    return {
        "user_id": ctx.user_id,
        "action": action,
        "target_id": target_id,
        "params": params,
        "ts": _now_iso(),
    }


async def _append_audit(
    ctx: UserCtx, s: Settings, action: str, target_id: str, params: dict[str, Any]
) -> dict[str, Any]:
    """Write one audit row and return it (so the handler echoes the EXACT row).

    A failed audit is a 502, NOT a swallowed error — an unaudited action must not
    silently 'succeed' (C1 is on the critical path, per the plan). The audit is
    the LAST step of every handler, so a 502 here means the mutation landed but
    the receipt didn't, which the caller can retry.
    """
    row = audit_row(ctx, action, target_id, params)
    async with _client() as c:
        r = await c.post(
            _action_log_url(s),
            json=row,
            headers={**_headers(ctx, s, write=True), "Prefer": "return=minimal"},
        )
    if r.status_code not in (200, 201, 204):
        raise HTTPException(status_code=502, detail="could not write audit log")
    return row


# ── action result ─────────────────────────────────────────────────────────────


class ActionResult(BaseModel):
    """Uniform receipt for any dispatched action."""

    ok: bool = True
    action: str
    target_id: str
    audit: dict[str, Any]
    detail: dict[str, Any] = Field(default_factory=dict)


# ── typed param models ─────────────────────────────────────────────────────────
# One model per action. The route hands raw JSON to ``dispatch``, which validates
# against the registered model (bad input → 400) before the handler runs.


class FlagEntityParams(BaseModel):
    target_id: str = Field(..., min_length=1, max_length=200)
    note: str = Field("", max_length=2000)
    severity: int = Field(3, ge=1, le=5)


class PromoteIncidentParams(BaseModel):
    target_id: str = Field(..., min_length=1, max_length=200)
    title: str = Field("", max_length=200)
    note: str = Field("", max_length=2000)


class NominateTargetParams(BaseModel):
    target_id: str = Field(..., min_length=1, max_length=200)
    priority: int = Field(3, ge=1, le=5)
    note: str = Field("", max_length=2000)


class AddWatchParams(BaseModel):
    target_id: str = Field(..., min_length=1, max_length=200)
    label: str = Field(..., min_length=1, max_length=120)
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    radius_nm: float = Field(50, gt=0, le=5000)
    kinds: list[str] = Field(default_factory=list)
    min_severity: int = Field(1, ge=1, le=5)


# ── handlers ────────────────────────────────────────────────────────────────────
# Each handler: mutate the ontology (+ any side effect), THEN append the audit row,
# THEN return an ActionResult. Handlers take already-validated params.


async def _handle_flag_entity(
    ctx: UserCtx, s: Settings, p: FlagEntityParams
) -> ActionResult:
    reg = OntologyRegistry(ctx, s)
    # Stamp the flag onto the object's props (creating the node if new) and add a
    # self-edge so a graph traversal surfaces the flag.
    existing = await reg.get(p.target_id)
    props = dict(existing.props) if existing else {}
    props["flag"] = {"note": p.note, "severity": p.severity, "at": _now_iso()}
    obj = await reg.upsert(Object(id=p.target_id, props=props))
    await reg.link(
        Link(
            src=p.target_id,
            dst=p.target_id,
            rel="flagged",
            props={"note": p.note, "severity": p.severity},
        )
    )
    audit = await _append_audit(ctx, s, "flag_entity", p.target_id, p.model_dump())
    return ActionResult(
        action="flag_entity",
        target_id=p.target_id,
        audit=audit,
        detail={"object": obj.model_dump()},
    )


async def _handle_promote_incident(
    ctx: UserCtx, s: Settings, p: PromoteIncidentParams
) -> ActionResult:
    reg = OntologyRegistry(ctx, s)
    incident_id = f"incident:{uuid.uuid4()}"
    # Ensure the source object exists, create the incident node, and wire the
    # promotion edge so the incident is reachable from the source and vice-versa.
    await reg.upsert(Object(id=p.target_id))
    incident = await reg.upsert(
        Object(
            id=incident_id,
            props={
                "title": p.title or f"Incident from {p.target_id}",
                "note": p.note,
                "source": p.target_id,
                "promoted_at": _now_iso(),
            },
        )
    )
    await reg.link(Link(src=p.target_id, dst=incident_id, rel="promoted_to"))
    await reg.link(Link(src=incident_id, dst=p.target_id, rel="evidence_of"))
    audit = await _append_audit(ctx, s, "promote_incident", incident_id, p.model_dump())
    return ActionResult(
        action="promote_incident",
        target_id=incident_id,
        audit=audit,
        detail={"incident": incident.model_dump(), "source": p.target_id},
    )


async def _handle_nominate_target(
    ctx: UserCtx, s: Settings, p: NominateTargetParams
) -> ActionResult:
    # Side effect: POST to the SAME target_board table routes/targets.py owns
    # (unique(user_id, entity_id) upserts, so re-nominating moves nothing). We
    # POST directly rather than calling the route handler to avoid the in-process
    # FastAPI dependency machinery.
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    board_url = s.supabase_url.rstrip("/") + "/rest/v1/target_board"
    row = {
        "user_id": ctx.user_id,
        "entity_id": p.target_id,
        "stage": "confirm",
        "priority": p.priority,
        "note": p.note,
    }
    headers = {
        **_headers(ctx, s, write=True),
        "Prefer": "resolution=merge-duplicates,return=representation",
    }
    async with _client() as c:
        r = await c.post(board_url, json=row, headers=headers)
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="could not nominate target")
    created = r.json()
    target = created[0] if isinstance(created, list) and created else created

    # Reflect the nomination into the ontology so the board entry is a graph node.
    reg = OntologyRegistry(ctx, s)
    await reg.upsert(Object(id=p.target_id))
    board_id = (target or {}).get("id")
    if board_id:
        node_id = f"target:{board_id}"
        await reg.upsert(
            Object(id=node_id, props={"stage": "confirm", "priority": p.priority})
        )
        await reg.link(Link(src=p.target_id, dst=node_id, rel="nominated"))

    audit = await _append_audit(ctx, s, "nominate_target", p.target_id, p.model_dump())
    return ActionResult(
        action="nominate_target",
        target_id=p.target_id,
        audit=audit,
        detail={"target_board_entry": target},
    )


async def _handle_add_watch(
    ctx: UserCtx, s: Settings, p: AddWatchParams
) -> ActionResult:
    # Side effect: POST to the SAME alert_rules table routes/alert_rules.py owns.
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    rules_url = s.supabase_url.rstrip("/") + "/rest/v1/alert_rules"
    row = {
        "user_id": ctx.user_id,
        "label": p.label,
        "lat": p.lat,
        "lon": p.lon,
        "radius_nm": p.radius_nm,
        "kinds": p.kinds,
        "min_severity": p.min_severity,
        "channel": "inapp",
        "enabled": True,
    }
    headers = {**_headers(ctx, s, write=True), "Prefer": "return=representation"}
    async with _client() as c:
        r = await c.post(rules_url, json=row, headers=headers)
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="could not add watch")
    created = r.json()
    rule = created[0] if isinstance(created, list) and created else created

    reg = OntologyRegistry(ctx, s)
    await reg.upsert(Object(id=p.target_id))
    rule_id = (rule or {}).get("id")
    if rule_id:
        node_id = f"watch:{rule_id}"
        await reg.upsert(
            Object(id=node_id, props={"label": p.label, "lat": p.lat, "lon": p.lon})
        )
        await reg.link(Link(src=p.target_id, dst=node_id, rel="watched_by"))

    audit = await _append_audit(ctx, s, "add_watch", p.target_id, p.model_dump())
    return ActionResult(
        action="add_watch",
        target_id=p.target_id,
        audit=audit,
        detail={"alert_rule": rule},
    )


# ── registry + dispatch ──────────────────────────────────────────────────────────


class ActionSpec(BaseModel):
    """A registered action: name + summary + the param model + its handler."""

    model_config = {"arbitrary_types_allowed": True}

    name: str
    summary: str
    params_model: type[BaseModel]
    handler: Callable[[UserCtx, Settings, Any], Awaitable[ActionResult]]


_REGISTRY: dict[str, ActionSpec] = {
    spec.name: spec
    for spec in (
        ActionSpec(
            name="flag_entity",
            summary="Flag an object with an analyst note + severity.",
            params_model=FlagEntityParams,
            handler=_handle_flag_entity,
        ),
        ActionSpec(
            name="promote_incident",
            summary="Promote an object to a tracked incident node.",
            params_model=PromoteIncidentParams,
            handler=_handle_promote_incident,
        ),
        ActionSpec(
            name="nominate_target",
            summary="Add an object to the F2T2EA target board.",
            params_model=NominateTargetParams,
            handler=_handle_nominate_target,
        ),
        ActionSpec(
            name="add_watch",
            summary="Create a standing geofence alert rule for an area.",
            params_model=AddWatchParams,
            handler=_handle_add_watch,
        ),
    )
}


def list_actions() -> list[dict[str, Any]]:
    """Catalog of registered actions + their param schema (for the UI / agent)."""
    return [
        {
            "name": spec.name,
            "summary": spec.summary,
            "params": spec.params_model.model_json_schema().get("properties", {}),
            "required": spec.params_model.model_json_schema().get("required", []),
        }
        for spec in _REGISTRY.values()
    ]


def get_action(name: str) -> ActionSpec | None:
    return _REGISTRY.get(name)


async def dispatch(
    name: str, raw_params: dict[str, Any], ctx: UserCtx, settings: Settings | None = None
) -> ActionResult:
    """Validate ``raw_params`` against the registered action and run its handler.

    Raises 404 for an unknown action, 400 for invalid params (the Pydantic
    ValidationError is surfaced as the 400 detail), and propagates the handler's
    502/503 (store unavailable / not configured).
    """
    spec = _REGISTRY.get(name)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"unknown action: {name}")
    try:
        params = spec.params_model(**raw_params)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc
    s = settings or get_settings()
    return await spec.handler(ctx, s, params)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
