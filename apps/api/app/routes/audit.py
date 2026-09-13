"""GET /api/audit — the read-back for the immutable ``action_log``.

Two stores, because there are two deployments.

With Supabase configured there is more than one human, so the ``auditor``/
``admin`` role gate applies and the same gate is enforced at the DB by the
``action_log_auditor_select`` RLS policy — even a forged request cannot read
another user's actions.

With Supabase unconfigured there is no second person to separate from, and
governed actions are written to a local SQLite log instead
(``intel/action_log_local.py``, ``./data/action_log.db``). That log existed
precisely because a keyless boot used to 502 on the final step of every
governed action, and it had **no reader at all**: this route 503'd on
``supabase_url`` being unset, so the platform dutifully audited every action
into a file nothing could open. "An unaudited action must not silently
succeed" held; "an operator can see what the system did" did not.

The role rule on that path is the one ``security.require_operator`` already
states in full: a deployment with no multi-user identity has exactly one user,
and that user is the operator. So the local log is readable there, and the
dependency degrades with ``current_principal_or_local`` rather than 401ing a
keyless box out of its own audit trail.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import get_settings
from app.intel import action_log_local
from app.keys import _client, _headers
from app.security import Principal, _multi_user, current_principal_or_local

router = APIRouter(tags=["audit"])


@router.get("/api/audit")
async def get_audit(
    since: str | None = Query(None, description="ISO-8601; only rows at/after this ts"),
    limit: int = Query(200, ge=1, le=2000),
    p: Principal = Depends(current_principal_or_local),
) -> list[dict[str, Any]]:
    s = get_settings()

    # The role gate follows WHO CAN BE TOLD APART, not which store is in use.
    # It used to key on supabase_url, so a JWT-secret-only deployment (many
    # users, no URL) served every user's local audit rows to any analyst
    # (ASVS V8.2.2).
    if _multi_user(s) and not (p.has_role("auditor") or p.has_role("admin")):
        raise HTTPException(status_code=403, detail="requires auditor or admin role")

    if not s.supabase_url:
        # No PostgREST: actions are logged locally (single user = the operator,
        # security.require_operator's rule; or an auditor on a JWT-only box).
        # Two local stores, one reader (ASVS V16.2.3): governed actions land in
        # action_log.db, while audit_mutation and the OSINT/extract audits write
        # audit_log.db. This route read only the first, so on a keyless or
        # static-key box no mutation attempt was ever visible here.
        from app.audit import list_local_rows  # noqa: PLC0415

        rows = [
            {**r, "store": "action_log"} for r in await action_log_local.list_rows(limit)
        ] + await list_local_rows(limit)
        rows.sort(key=lambda r: str(r.get("ts", "")), reverse=True)
        rows = rows[:limit]
        if since:
            # ts is stored ISO-8601 UTC, so a lexicographic compare is a
            # chronological one and needs no parsing.
            rows = [r for r in rows if str(r.get("ts", "")) >= since]
        return rows
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


@router.get("/api/audit/verify")
async def verify_audit_chain(
    p: Principal = Depends(current_principal_or_local),
) -> dict[str, Any]:
    """Tamper evidence for the LOCAL ``audit_log`` (ASVS V16.4.2): walks its
    SHA-256 hash chain and names the first row that no longer matches. Same
    role gate as the read. The Supabase ``action_log`` is append-only at the
    database and is not chained here."""
    import asyncio  # noqa: PLC0415

    from app.audit import verify_local_chain_sync  # noqa: PLC0415

    if _multi_user(get_settings()) and not (p.has_role("auditor") or p.has_role("admin")):
        raise HTTPException(status_code=403, detail="requires auditor or admin role")
    return await asyncio.get_running_loop().run_in_executor(None, verify_local_chain_sync)
