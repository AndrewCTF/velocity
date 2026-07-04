"""Immutable audit — append a who/what/when/where row to ``action_log``.

The database makes the table append-only (a ``BEFORE UPDATE/DELETE`` trigger plus
revoked grants — see the gotham-substrate migration). This writes one row per
audited action with the caller's own token: the ``action_log_self_insert`` RLS
policy lets a user record their OWN actions, and they can neither alter nor delete
them afterwards. Best-effort by design — an audit write failure is logged but never
blocks the user's action, so audit can't take the app down — but every mutating
intel route SHOULD call ``audit(...)``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Request

from app.config import get_settings
from app.keys import UserCtx, _client, _headers

log = logging.getLogger("velocity.audit")


def _url() -> str:
    s = get_settings()
    return (s.supabase_url.rstrip("/") + "/rest/v1/action_log") if s.supabase_url else ""


async def audit(
    ctx: UserCtx,
    action: str,
    resource_type: str,
    resource_id: str = "",
    *,
    classification: int = 0,
    detail: dict[str, Any] | None = None,
    request: Request | None = None,
    actor_email: str = "",
) -> bool:
    """Append one immutable audit row. Returns True on success, False otherwise.

    Never raises — callers should not have to wrap this; a failed audit is logged.
    """
    s = get_settings()
    url = _url()
    if not url:
        return False
    row: dict[str, Any] = {
        "user_id": ctx.user_id,
        "action": action,
        "resource_type": resource_type,
        "target_id": resource_id or None,
        "classification": int(classification),
        "params": detail or {},
        "actor_email": actor_email or None,
    }
    if request is not None:
        client = request.client
        row["ip"] = client.host if client else None
        row["user_agent"] = request.headers.get("user-agent")
    headers = {**_headers(ctx, s, write=True), "Prefer": "return=minimal"}
    try:
        async with _client() as c:
            r = await c.post(url, json=row, headers=headers)
        if r.status_code in (200, 201, 204):
            return True
        log.warning("audit write rejected: %s %s", r.status_code, (r.text or "")[:200])
        return False
    except Exception as exc:  # noqa: BLE001 — audit must never break the action
        log.warning("audit write error: %s", exc)
        return False
