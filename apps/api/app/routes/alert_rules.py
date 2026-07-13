"""Per-user alert rules — /api/alerts/rules.

A rule is a standing watch: an AOI (lat/lon/radius) + the signal kinds to flag +
a minimum severity + a delivery channel. Two backends, selected by the same
``not settings.supabase_url`` predicate ``intel/watch.py`` uses to decide
"keyless":

  * Supabase (RLS-scoped via the caller's token, same pattern as BYOK) when
    configured — unchanged multi-tenant behavior.
  * ``intel/alert_rules_local.py`` (local SQLite, same idiom as
    ``ontology_local.py``) on a keyless boot, so a self-hosted operator with no
    cloud project can still define + persist a watch rule (W3, 2026-07-11:
    docs/decisions.md).

``channel`` is ``inapp`` / ``discord`` / ``webhook`` (the latter two take a
``sink_url`` — a Discord webhook URL or a generic endpoint); delivery is
performed by the watch evaluator (``intel/watch.py``), not this route — this
module is CRUD-only. ``email`` is rejected at creation until a sender exists.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.keys import UserCtx, _client, _headers, current_user_or_local
from app.workflows.control import check_url
from app.workflows.store import WorkflowError

router = APIRouter(tags=["alerts"])

# Phase-2 behavioral kinds (ais_gap/rendezvous/loiter) are computed by the watch
# evaluator from the position-history store (intel/detectors.py), not the brief.
KINDS = {
    "jamming", "dark_vessel", "military_air", "military_vessel", "incident",
    "quake", "fire", "ais_gap", "rendezvous", "loiter",
}
# discord/webhook deliver a firing to a sink_url; the watch evaluator does the
# actual POST (see intel/watch.py::_deliver_sinks) reusing the Workflows
# control.py HTTP primitive — no new client, no new dependency.
# "email" is deliberately absent: nothing sends email yet, and a rule that
# silently never delivers is worse than a 400 at creation (2026-07-12).
CHANNELS = {"inapp", "discord", "webhook"}


def _use_local(s: Settings) -> bool:
    """Same predicate ``intel/watch.py::_list_enabled_rules`` already uses to
    detect a keyless boot — kept identical so routes and evaluator never
    disagree about which store a rule lives in."""
    return not s.supabase_url


def _rest(s: Settings) -> str:
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    return s.supabase_url.rstrip("/") + "/rest/v1/alert_rules"


class AlertRuleIn(BaseModel):
    label: str = Field(..., min_length=1, max_length=120)
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    radius_nm: float = Field(50, gt=0, le=5000)
    kinds: list[str] = Field(default_factory=list)
    min_severity: int = Field(1, ge=1, le=5)
    channel: str = "inapp"
    sink_url: str | None = None
    enabled: bool = True


class AlertRule(AlertRuleIn):
    id: str
    created_at: str | None = None


def _validate(body: AlertRuleIn) -> None:
    bad = [k for k in body.kinds if k not in KINDS]
    if bad:
        raise HTTPException(status_code=400, detail=f"unknown kinds: {bad}")
    if body.channel == "email":
        raise HTTPException(
            status_code=400,
            detail="email delivery is not implemented yet — use 'discord' or 'webhook'",
        )
    if body.channel not in CHANNELS:
        raise HTTPException(status_code=400, detail="unknown channel")
    if body.channel in ("discord", "webhook"):
        if not body.sink_url:
            raise HTTPException(
                status_code=400,
                detail=f"channel {body.channel!r} requires sink_url",
            )
        try:
            check_url(body.sink_url)
        except WorkflowError as exc:
            raise HTTPException(status_code=400, detail=exc.detail) from exc


@router.get("/api/alerts/rules", response_model=list[AlertRule])
async def list_rules(ctx: UserCtx = Depends(current_user_or_local)) -> list[AlertRule]:
    s = get_settings()
    if _use_local(s):
        from app.intel import alert_rules_local  # noqa: PLC0415

        rows = await alert_rules_local.list_rules(ctx.user_id, settings=s)
        return [AlertRule(**row) for row in rows]
    async with _client() as c:
        r = await c.get(
            _rest(s),
            params={"user_id": f"eq.{ctx.user_id}", "select": "*", "order": "created_at.desc"},
            headers=_headers(ctx, s),
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="rule store unavailable")
    return [AlertRule(**row) for row in r.json()]


@router.post("/api/alerts/rules", response_model=AlertRule, status_code=201)
async def create_rule(
    body: AlertRuleIn, ctx: UserCtx = Depends(current_user_or_local)
) -> AlertRule:
    _validate(body)
    s = get_settings()
    if _use_local(s):
        from app.intel import alert_rules_local  # noqa: PLC0415

        row = await alert_rules_local.create_rule(ctx.user_id, body.model_dump(), settings=s)
        return AlertRule(**row)
    row = {**body.model_dump(), "user_id": ctx.user_id}
    headers = {**_headers(ctx, s, write=True), "Prefer": "return=representation"}
    async with _client() as c:
        r = await c.post(_rest(s), json=row, headers=headers)
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="could not save rule")
    created = r.json()
    return AlertRule(**(created[0] if isinstance(created, list) else created))


@router.delete("/api/alerts/rules/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> None:
    s = get_settings()
    if _use_local(s):
        from app.intel import alert_rules_local  # noqa: PLC0415

        await alert_rules_local.delete_rule(ctx.user_id, rule_id, settings=s)
        return
    async with _client() as c:
        r = await c.delete(
            _rest(s),
            params={"id": f"eq.{rule_id}", "user_id": f"eq.{ctx.user_id}"},
            headers=_headers(ctx, s),
        )
    if r.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail="could not delete rule")


@router.get("/api/alerts/deliveries")
async def list_deliveries(limit: int = 50) -> dict[str, object]:
    """Recent sink-delivery attempts (Discord/webhook) — the durable proof a
    firing actually reached an operator's endpoint, readable with no browser
    attached to the evaluator (e.g. ``curl`` on the box itself)."""
    from app.intel import alert_rules_local  # noqa: PLC0415

    rows = await alert_rules_local.recent_deliveries(limit)
    return {"deliveries": rows}
