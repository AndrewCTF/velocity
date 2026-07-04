"""GET /api/audit — auditor-gated read of the immutable ``action_log``.

Only a principal holding the ``auditor`` or ``admin`` role may read the log; the
same gate is enforced at the DB by the ``action_log_auditor_select`` RLS policy,
so even a forged request can't read another user's actions. Returns the most
recent rows (optionally since a timestamp), newest first.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import get_settings
from app.keys import _client, _headers
from app.security import Principal, current_principal

router = APIRouter(tags=["audit"])


@router.get("/api/audit")
async def get_audit(
    since: str | None = Query(None, description="ISO-8601; only rows at/after this ts"),
    limit: int = Query(200, ge=1, le=2000),
    p: Principal = Depends(current_principal),
) -> list[dict[str, Any]]:
    if not (p.has_role("auditor") or p.has_role("admin")):
        raise HTTPException(status_code=403, detail="requires auditor or admin role")
    s = get_settings()
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    url = s.supabase_url.rstrip("/") + "/rest/v1/action_log"
    params: dict[str, str] = {"select": "*", "order": "ts.desc", "limit": str(limit)}
    if since:
        params["ts"] = f"gte.{since}"
    # _headers duck-types on `.token`; Principal carries it (RLS gates the read).
    async with _client() as c:
        r = await c.get(url, params=params, headers=_headers(p, s))  # type: ignore[arg-type]
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="audit store unavailable")
    rows = r.json()
    return rows if isinstance(rows, list) else []
