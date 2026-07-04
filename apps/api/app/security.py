"""Request principal — identity + clearance/roles for the ACL + audit substrate.

``UserCtx`` (``app.keys``) carries only id + token. A classified/audited route
also needs the signed-in user's clearance, compartments, and roles. Those live in
``public.profiles`` (the "own profile" RLS policy lets a user read their own row),
so ``current_principal`` fetches them once with the user's own token and caches
per-uid for a minute. When the profile is unreachable the principal degrades to
least privilege (clearance 0, role ``analyst``) — never elevated by accident.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request

from app.auth import _jwt_claims, _valid_supabase_token
from app.config import Settings, get_settings
from app.keys import UserCtx, _client, _headers, current_user


@dataclass(frozen=True)
class Principal:
    user_id: str
    token: str
    email: str = ""
    clearance: int = 0
    compartments: tuple[str, ...] = ()
    roles: tuple[str, ...] = ("analyst",)

    def has_role(self, role: str) -> bool:
        # admin is a superset — it implies every role.
        return role in self.roles or "admin" in self.roles


# uid -> (expiry, profile-dict). Short TTL: clearance changes take effect within a minute.
_cache: dict[str, tuple[float, dict]] = {}
_TTL = 60.0


def _profiles_url(s: Settings) -> str:
    return (s.supabase_url.rstrip("/") + "/rest/v1/profiles") if s.supabase_url else ""


async def _fetch_profile(ctx: UserCtx, s: Settings) -> dict:
    now = time.time()
    hit = _cache.get(ctx.user_id)
    if hit and hit[0] > now:
        return hit[1]
    prof: dict = {}
    url = _profiles_url(s)
    if url:
        try:
            async with _client() as c:
                r = await c.get(
                    url,
                    params={
                        "id": f"eq.{ctx.user_id}",
                        "select": "email,clearance,compartments,roles",
                        "limit": "1",
                    },
                    headers=_headers(ctx, s),
                )
            if r.status_code == 200:
                rows = r.json()
                if rows:
                    prof = rows[0]
        except Exception:  # noqa: BLE001 — profile store down → least privilege
            prof = {}
    _cache[ctx.user_id] = (now + _TTL, prof)
    if len(_cache) > 4096:  # bound: drop expired
        for k in [k for k, v in _cache.items() if v[0] <= now]:
            _cache.pop(k, None)
    return prof


async def current_principal(
    request: Request, ctx: UserCtx = Depends(current_user)
) -> Principal:
    s = get_settings()
    claims = _jwt_claims(ctx.token) or {}
    prof = await _fetch_profile(ctx, s)
    roles = prof.get("roles") or ["analyst"]
    return Principal(
        user_id=ctx.user_id,
        token=ctx.token,
        email=str(prof.get("email") or claims.get("email") or ""),
        clearance=int(prof.get("clearance") or 0),
        compartments=tuple(str(c) for c in (prof.get("compartments") or ())),
        roles=tuple(str(r) for r in roles),
    )


async def principal_for_token(token: str) -> Principal | None:
    """Resolve a Principal from a raw bearer token (no Request) — for WS handlers.

    Returns None when the token is missing/invalid, so a caller can reject the
    upgrade. Same least-privilege profile read as ``current_principal``.
    """
    s = get_settings()
    if not token or not await _valid_supabase_token(token, s):
        return None
    claims = _jwt_claims(token) or {}
    sub = claims.get("sub")
    if not sub:
        return None
    ctx = UserCtx(user_id=str(sub), token=token)
    prof = await _fetch_profile(ctx, s)
    roles = prof.get("roles") or ["analyst"]
    return Principal(
        user_id=str(sub),
        token=token,
        email=str(prof.get("email") or claims.get("email") or ""),
        clearance=int(prof.get("clearance") or 0),
        compartments=tuple(str(c) for c in (prof.get("compartments") or ())),
        roles=tuple(str(r) for r in roles),
    )


def require_role(role: str):  # type: ignore[no-untyped-def]
    """Depends() factory: 403 unless the principal holds ``role`` (or admin)."""

    async def _dep(p: Principal = Depends(current_principal)) -> Principal:
        if not p.has_role(role):
            raise HTTPException(status_code=403, detail=f"requires {role} role")
        return p

    return _dep
