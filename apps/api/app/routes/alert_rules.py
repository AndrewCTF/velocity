"""Per-user alert rules — /api/alerts/rules.

A rule is a standing watch: an AOI (lat/lon/radius) + the signal kinds to flag +
a minimum severity + a delivery channel. Stored per user in Supabase
``public.alert_rules`` (RLS-scoped via the caller's token, same pattern as BYOK).

v1 persists + manages rules; matching them against the live watch loop and
delivering email is the next increment (the in-app Alerts panel already renders
computed alerts).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.keys import UserCtx, _client, _headers, current_user

router = APIRouter(tags=["alerts"])

# Phase-2 behavioral kinds (ais_gap/rendezvous/loiter) are computed by the watch
# evaluator from the position-history store (intel/detectors.py), not the brief.
KINDS = {
    "jamming", "dark_vessel", "military_air", "military_vessel", "incident",
    "quake", "fire", "ais_gap", "rendezvous", "loiter",
}
CHANNELS = {"inapp", "email"}


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
    enabled: bool = True


class AlertRule(AlertRuleIn):
    id: str
    created_at: str | None = None


def _validate(body: AlertRuleIn) -> None:
    bad = [k for k in body.kinds if k not in KINDS]
    if bad:
        raise HTTPException(status_code=400, detail=f"unknown kinds: {bad}")
    if body.channel not in CHANNELS:
        raise HTTPException(status_code=400, detail="unknown channel")


@router.get("/api/alerts/rules", response_model=list[AlertRule])
async def list_rules(ctx: UserCtx = Depends(current_user)) -> list[AlertRule]:
    s = get_settings()
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
    body: AlertRuleIn, ctx: UserCtx = Depends(current_user)
) -> AlertRule:
    _validate(body)
    s = get_settings()
    row = {**body.model_dump(), "user_id": ctx.user_id}
    headers = {**_headers(ctx, s, write=True), "Prefer": "return=representation"}
    async with _client() as c:
        r = await c.post(_rest(s), json=row, headers=headers)
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="could not save rule")
    created = r.json()
    return AlertRule(**(created[0] if isinstance(created, list) else created))


@router.delete("/api/alerts/rules/{rule_id}", status_code=204)
async def delete_rule(rule_id: str, ctx: UserCtx = Depends(current_user)) -> None:
    s = get_settings()
    async with _client() as c:
        r = await c.delete(
            _rest(s),
            params={"id": f"eq.{rule_id}", "user_id": f"eq.{ctx.user_id}"},
            headers=_headers(ctx, s),
        )
    if r.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail="could not delete rule")
