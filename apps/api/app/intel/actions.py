"""Governed write-back — the *verbs* layer over the ontology (Track C1).

The ontology (``intel/ontology.py``) is the typed nouns; this is the typed verbs.
An ``ActionSpec`` binds an action name → a Pydantic param model → an async handler
that:

  1. validates the params (the Pydantic model rejects bad input → 400),
  2. mutates the ontology (upserts objects / links through the registry)
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
  - ``writeback``        — write a record OUT to a source system the operator runs:
                           an allow-listed HTTP endpoint (through ``op.http``'s own
                           SSRF classifier, unchanged) or a Foundry ``sql``
                           connection. ``operator_only``, so it travels the HITL
                           proposal queue like every other agent-originated write
                           and an operator signs for it.

The ontology mutation always lands (SQLite, local-first — see
``docs/decisions.md#ontology-local-first-store-2026-07-07``). The audit append and
the ``add_watch`` side effect fall back to a local SQLite store on a keyless boot
(``action_log_local.py`` / ``alert_rules_local.py``); ``nominate_target``'s
supplementary ``target_board`` reflection has no local store yet (deliberately
deferred — see ``_handle_nominate_target``) and is skipped rather than sinking the
whole action. The module imports with no side effects.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, Field, ValidationError, model_validator

from app.config import Settings, get_settings
from app.intel import action_log_local, alert_rules_local
from app.intel.ontology import Link, Object, get_registry
from app.intel.promotion import stable_id
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

    Keyless boot (no ``supabase_url``): there is no PostgREST ``action_log``
    table (the Supabase ontology backend was deleted 2026-07-07 —
    docs/decisions.md), so the row goes to the local-SQLite sink
    (``action_log_local.py``, same idiom as ``ontology_local``/
    ``alert_rules_local``) instead of 503ing. Still fail-hard: a local write
    error is re-raised as the same 502, never swallowed.
    """
    row = audit_row(ctx, action, target_id, params)
    if not s.supabase_url:
        try:
            await action_log_local.append_row(row)
        except Exception as exc:  # noqa: BLE001 — fail-hard, never swallowed
            raise HTTPException(
                status_code=502, detail="could not write audit log"
            ) from exc
        return row
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


# An SQL identifier, and nothing that could be a fragment of a statement. Same
# deliberately-strict stance as ``foundry/connections.valid_dsn_env``: the cost
# of being wrong in the permissive direction is an injection into someone's own
# database, so anything with a quote, a space, a dot or a semicolon is refused
# rather than escaped.
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")

# An env-var NAME, upper case only — the identical stance, and the identical
# pattern, as ``foundry/connections.valid_dsn_env``. Lower case, a slash, a
# space or a scheme is far more likely to be a secret pasted into the wrong
# field than an unusual variable name, and the cost of being wrong in that
# direction is a bearer token stored in the proposal queue.
_ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


class WritebackParams(BaseModel):
    """Write one record OUT to a system the operator runs.

    Two targets, both of them things the platform already knows how to reach:

    ``http``
        an endpoint of theirs, dispatched through ``workflows/control.request``
        — the SAME classifier ``op.http`` uses, reused unchanged, so the host
        allowlist (``WORKFLOWS_HTTP_ALLOW_HOSTS``), the link-local / cloud
        metadata refusal, the DNS-rebinding pin and the kill switch
        (``WORKFLOWS_CONTROL_ENABLED``) all apply here without a second copy.
    ``connection``
        a Foundry ``sql`` connection: the DSN is resolved from the environment
        variable NAME the connection row stores (never a DSN in the row), and
        the statement is a parameterised ``sqlalchemy.insert`` — the table and
        every payload key validated as an identifier first.

    ``dry_run`` builds and validates everything, including the SSRF checks, and
    stops before the request/statement. It still writes an audit row: a rehearsal
    an operator approved is a fact worth keeping.
    """

    target: Literal["http", "connection"]
    # http
    url: str = Field("", max_length=2000)
    method: Literal["POST", "PUT", "PATCH"] = "POST"
    # The NAME of an env var holding a bearer token, never the token (same rule
    # as a sql connection's dsn_env, enforced by control.auth_headers).
    auth_env: str = Field("", max_length=64)
    # connection
    connection_id: str = Field("", max_length=64)
    table: str = Field("", max_length=63)
    # The record itself. Never stored in an audit row or logged — only its
    # sha256 is, so the receipt proves WHAT was sent without keeping a copy of
    # it in a second store.
    payload: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = False

    # An "after" model validator, not ``model_post_init``: pydantic wraps a
    # ValueError raised here into a ValidationError, which ``dispatch`` turns
    # into a 400. A raise from ``model_post_init`` propagates unwrapped and
    # would surface as a 500.
    @model_validator(mode="after")
    def _check_target_shape(self) -> WritebackParams:
        if self.target == "http":
            if not self.url.strip():
                raise ValueError("target 'http' needs a url")
            if self.auth_env and not _ENV_NAME_RE.match(self.auth_env):
                raise ValueError(
                    "auth_env must be the NAME of an environment variable holding "
                    "the bearer token, never the token itself"
                )
        else:
            if not self.connection_id.strip():
                raise ValueError("target 'connection' needs a connection_id")
            if not _IDENT_RE.match(self.table):
                raise ValueError(f"table must be a plain SQL identifier, got {self.table!r}")
            if not self.payload:
                raise ValueError("target 'connection' needs a non-empty payload")
            bad = [k for k in self.payload if not _IDENT_RE.match(str(k))]
            if bad:
                raise ValueError(f"payload keys must be plain SQL identifiers: {bad}")
        return self


# ── handlers ────────────────────────────────────────────────────────────────────
# Each handler: mutate the ontology (+ any side effect), THEN append the audit row,
# THEN return an ActionResult. Handlers take already-validated params.


async def _handle_flag_entity(
    ctx: UserCtx, s: Settings, p: FlagEntityParams
) -> ActionResult:
    reg = get_registry(ctx, s)
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
    reg = get_registry(ctx, s)
    # Stable, deterministic id (promotion.py's helper, shared with the
    # auto-promotion path) so approving the SAME target twice UPDATES one
    # incident node instead of minting a duplicate — a fresh uuid4 per call
    # cannot do that. See docs/decisions.md.
    incident_id = stable_id("incident", p.target_id)
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
    # Canonical direction per ontology.py KNOWN_RELS ("signal/track → incident
    # it supports"): member entity → incident, matching promotion.py's
    # auto-promote path. Was inverted here (incident → target) — fixed.
    await reg.link(Link(src=p.target_id, dst=incident_id, rel="evidence_of"))
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
    #
    # Unlike alert_rules/action_log, target_board has NO local-SQLite fallback
    # yet — routes/targets.py's own docstring documents this as deliberate
    # ("the route answers 503, the store stays local": the frontend Kanban
    # already keeps a working copy) and docs/decisions.md lists it as still-
    # deferred Phase-4 territory. So on a keyless boot we skip this
    # supplementary remote persistence rather than 503ing the WHOLE governed
    # action — the ontology reflection + audit trail below are what's actually
    # load-bearing for C1's "no unaudited action" contract.
    target: dict[str, Any] | None = None
    if s.supabase_url:
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
    reg = get_registry(ctx, s)
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
    # Side effect: create a standing geofence rule in the SAME store
    # routes/alert_rules.py owns — local SQLite on a keyless boot (the exact
    # ``_use_local`` predicate that route already uses), Supabase otherwise.
    rule_body = {
        "label": p.label,
        "lat": p.lat,
        "lon": p.lon,
        "radius_nm": p.radius_nm,
        "kinds": p.kinds,
        "min_severity": p.min_severity,
        "channel": "inapp",
        "enabled": True,
    }
    if not s.supabase_url:
        rule = await alert_rules_local.create_rule(ctx.user_id, rule_body, settings=s)
    else:
        rules_url = s.supabase_url.rstrip("/") + "/rest/v1/alert_rules"
        row = {**rule_body, "user_id": ctx.user_id}
        headers = {**_headers(ctx, s, write=True), "Prefer": "return=representation"}
        async with _client() as c:
            r = await c.post(rules_url, json=row, headers=headers)
        if r.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail="could not add watch")
        created = r.json()
        rule = created[0] if isinstance(created, list) and created else created

    reg = get_registry(ctx, s)
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


# ── write-back to a source system ────────────────────────────────────────────


def _payload_sha256(payload: dict[str, Any]) -> str:
    """Digest of the record, canonicalised so the same record always hashes the
    same. The audit row carries this INSTEAD of the payload: an audit store is
    not the place for a second copy of someone's business data, and a hash still
    answers "is this the record that was sent?"."""
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _endpoint_label(url: str) -> str:
    """``scheme://host[:port]/path`` — the query string dropped.

    A query string is where an API key ends up (``?token=…``), and this string
    goes in the audit row's ``target_id`` and in the receipt.
    """
    parts = urlsplit(url.strip())
    netloc = parts.netloc.split("@")[-1]  # drop userinfo (credentials in the URL)
    return f"{parts.scheme}://{netloc}{parts.path}"


async def _writeback_http(p: WritebackParams) -> tuple[str, dict[str, Any]]:
    """Dispatch through ``op.http``'s guarded entry point, unchanged.

    ``control.request`` runs ``check_url`` on every path (dry-run included), so
    an allow-list miss or a link-local/metadata host is refused BEFORE anything
    is sent, and ``preview=dry_run`` reuses its existing dry-run branch rather
    than adding a second one here. Its ``WorkflowError`` (403 refused host, 422
    malformed URL) is mapped to the same HTTP status so a refusal reads as a
    refusal and not as a 500.
    """
    from app.workflows import control  # noqa: PLC0415 — avoid an import cycle
    from app.workflows.store import WorkflowError  # noqa: PLC0415

    headers = {"content-type": "application/json", **control.auth_headers(p.auth_env)}
    try:
        out = await control.request(
            p.method,
            p.url,
            headers=headers,
            json_body=p.payload,
            budget=[1],
            preview=p.dry_run,
            timeout_s=15.0,
        )
    except WorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    # Scrubbed on purpose: control.request echoes the request body back on a
    # dry run and the whole response text on a live one. Neither belongs in a
    # receipt that is about to be persisted.
    detail: dict[str, Any] = {
        "target": "http",
        "endpoint": _endpoint_label(p.url),
        "method": p.method,
        "dry_run": bool(out.get("dry_run")),
        "status": out.get("status"),
        "ok": bool(out.get("ok")),
        "payload_sha256": _payload_sha256(p.payload),
    }
    if out.get("reason"):
        detail["reason"] = out["reason"]
    if out.get("error"):
        detail["error"] = str(out["error"])[:200]
    return detail["endpoint"], detail


async def _writeback_connection(s: Settings, p: WritebackParams) -> tuple[str, dict[str, Any]]:
    """INSERT one row into the table behind a Foundry ``sql`` connection.

    The connection row holds the NAME of the env var holding the DSN and never
    the DSN itself (``foundry/connections._resolve_dsn`` enforces that), so this
    path cannot be pointed at an arbitrary database by whoever wrote the
    proposal — only at one the operator has already configured on this box.
    """
    import asyncio  # noqa: PLC0415

    from app.foundry.connections import _resolve_dsn  # noqa: PLC0415
    from app.foundry.store import FoundryStore  # noqa: PLC0415

    conn = await FoundryStore(s).get_connection(p.connection_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="unknown connection")
    if conn.get("kind") != "sql":
        raise HTTPException(
            status_code=400,
            detail=f"writeback needs a 'sql' connection, {p.connection_id} is {conn.get('kind')!r}",
        )
    try:
        dsn = _resolve_dsn(conn.get("config") or {})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    target_id = f"connection:{p.connection_id}/{p.table}"
    detail: dict[str, Any] = {
        "target": "connection",
        "connection_id": p.connection_id,
        "table": p.table,
        "dry_run": p.dry_run,
        "rows": 0,
        "payload_sha256": _payload_sha256(p.payload),
    }
    if p.dry_run:
        return target_id, detail

    try:
        import sqlalchemy  # noqa: PLC0415 — optional dependency
    except Exception as exc:  # noqa: BLE001 — a broken install is also unavailable
        raise HTTPException(
            status_code=503,
            detail="writeback to a sql connection needs sqlalchemy: pip install sqlalchemy",
        ) from exc

    payload = dict(p.payload)

    def _insert() -> None:
        # Fresh engine per write, disposed after — the same stance ``_run_sql``
        # takes: a governed one-row write does not justify holding a pool open
        # against someone else's database.
        engine = sqlalchemy.create_engine(dsn)
        try:
            tbl = sqlalchemy.table(p.table, *[sqlalchemy.column(k) for k in payload])
            with engine.begin() as c:
                c.execute(sqlalchemy.insert(tbl).values(**payload))
        finally:
            engine.dispose()

    try:
        await asyncio.get_running_loop().run_in_executor(None, _insert)
    except Exception as exc:  # noqa: BLE001 — a driver error is a 502, not a crash
        # Never echo the exception text: SQLAlchemy puts the DSN in it, and the
        # DSN carries the password. Same scrub rule as connections.py.
        raise HTTPException(
            status_code=502, detail=f"writeback insert failed: {type(exc).__name__}"
        ) from exc
    detail["rows"] = 1
    return target_id, detail


async def _handle_writeback(ctx: UserCtx, s: Settings, p: WritebackParams) -> ActionResult:
    if p.target == "http":
        target_id, detail = await _writeback_http(p)
    else:
        target_id, detail = await _writeback_connection(s, p)
    # The audit row records the shape of the write, never the record itself.
    audit = await _append_audit(ctx, s, "writeback", target_id, dict(detail))
    return ActionResult(action="writeback", target_id=target_id, audit=audit, detail=detail)


# ── registry + dispatch ──────────────────────────────────────────────────────────


class ActionSpec(BaseModel):
    """A registered action: name + summary + the param model + its handler.

    ``operator_only`` marks an action that carries OPERATOR authority rather
    than analyst authority — ``routes/actions.py`` puts ``require_operator`` in
    front of it, on the direct path AND on proposal approval. It is a property
    of the action, not of the route, so a new one cannot be registered without
    deciding which side of that line it is on.
    """

    model_config = {"arbitrary_types_allowed": True}

    name: str
    summary: str
    params_model: type[BaseModel]
    handler: Callable[[UserCtx, Settings, Any], Awaitable[ActionResult]]
    operator_only: bool = False


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
        ActionSpec(
            name="writeback",
            summary=(
                "Write a record OUT to a source system you run: an allow-listed "
                "HTTP endpoint or a Foundry sql connection. Operator-only, audited, "
                "dry_run supported."
            ),
            params_model=WritebackParams,
            handler=_handle_writeback,
            operator_only=True,
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
            "operator_only": spec.operator_only,
        }
        for spec in _REGISTRY.values()
    ]


def get_action(name: str) -> ActionSpec | None:
    return _REGISTRY.get(name)


def _jsonable_errors(exc: ValidationError) -> list[dict[str, Any]]:
    """``exc.errors()`` with the un-serialisable bits of ``ctx`` stringified.

    A constraint failure puts a plain value in ``ctx`` (``{"ge": 1}``) and
    serialises fine, but a validator that raises ``ValueError`` puts the
    exception OBJECT in ``ctx["error"]`` — and FastAPI then 500s while encoding
    the 400 it meant to send. Stringify rather than drop: the message is the
    part that tells the caller what was wrong.
    """
    out: list[dict[str, Any]] = []
    for err in exc.errors():
        e = dict(err)
        ctx = e.get("ctx")
        if isinstance(ctx, dict):
            e["ctx"] = {
                k: (v if isinstance(v, str | int | float | bool | type(None)) else str(v))
                for k, v in ctx.items()
            }
        out.append(e)
    return out


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
        raise HTTPException(status_code=400, detail=_jsonable_errors(exc)) from exc
    s = settings or get_settings()
    return await spec.handler(ctx, s, params)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
