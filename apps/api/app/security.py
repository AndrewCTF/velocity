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

from app import auth as _auth
from app.auth import _jwt_claims, _valid_supabase_token
from app.config import Settings, get_settings
from app.keys import UserCtx, _client, _headers, current_user, current_user_or_local


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


async def current_principal_or_local(
    request: Request, ctx: UserCtx = Depends(current_user_or_local)
) -> Principal:
    """``current_principal``, degrading to a local identity on a keyless boot.

    Mirrors ``app.keys.current_user_or_local`` EXACTLY: when Supabase is
    entirely unconfigured (no JWT secret and no url+anon key — the same
    condition that function checks) there is no user to resolve a profile for,
    so this returns the least-privilege ``Principal`` (clearance 0, role
    ``analyst``, no compartments) for the shared ``local`` identity instead of
    a dead 401. With Supabase configured this is exactly ``current_principal``
    — the token still needs to be a real, valid Supabase session, so an
    authenticated deployment's behavior is unchanged (still 401 without a
    token). Used by routes (e.g. ``POST /api/extract``) that should be usable
    keyless like every other ontology/LLM route, not stranded behind a hard
    sign-in requirement.
    """
    s = get_settings()
    if not (s.supabase_jwt_secret or (s.supabase_url and s.supabase_anon_key)):
        return Principal(user_id=ctx.user_id, token=ctx.token)
    return await current_principal(request, ctx=ctx)


def require_role(role: str):  # type: ignore[no-untyped-def]
    """Depends() factory: 403 unless the principal holds ``role`` (or admin)."""

    async def _dep(p: Principal = Depends(current_principal)) -> Principal:
        if not p.has_role(role):
            raise HTTPException(status_code=403, detail=f"requires {role} role")
        return p

    return _dep


# token -> wall-clock expiry of a positive GoTrue liveness answer. Never longer
# than a minute: this is what makes a ban or deletion bite on operator routes.
_active_until: dict[str, float] = {}
_ACTIVE_TTL = 60.0


def reset_state() -> None:
    _cache.clear()
    _active_until.clear()


def _banned(body: dict) -> bool:
    raw = body.get("banned_until")
    if not raw:
        return False
    try:
        from datetime import UTC, datetime  # noqa: PLC0415

        until = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        return until > datetime.now(UTC)
    except ValueError:
        return True  # unparseable ban marker: treat as banned (fail closed)


async def _session_active(token: str, s: Settings) -> bool:
    """Is the user behind ``token`` still active in GoTrue (not deleted, not
    banned, session not signed out)? Cached per token for at most 60 s.

    A JWT-secret-only deployment has no GoTrue URL to ask, so this answers True
    there and the token's own ``exp`` is the only revocation (documented in
    docs/security/auth-and-sessions.md)."""
    if not (s.supabase_url and s.supabase_anon_key):
        return True
    now = time.time()
    hit = _active_until.get(token)
    if hit and hit > now:
        return True
    status, body = await _auth._gotrue_user(token, s)
    ok = status == 200 and not _banned(body)
    if ok:
        _active_until[token] = now + _ACTIVE_TTL
        if len(_active_until) > 4096:
            for k in [k for k, v in _active_until.items() if v <= now]:
                _active_until.pop(k, None)
    else:
        _active_until.pop(token, None)
    return ok


MFA_REQUIRED_DETAIL = (
    "this endpoint carries operator authority and requires MFA: enrol a TOTP "
    "authenticator (Settings > Security > Two-factor) and sign in with it, so "
    "the session is aal2"
)


async def require_operator(p: Principal = Depends(current_principal_or_local)) -> None:
    """Gate the routes that carry OPERATOR authority, not merely analyst access:
    running arbitrary ``op.python``, dispatching a control/actuation block,
    downloading or deleting a model.

    ``require_role("admin")`` alone cannot do this job. Roles are only ever
    populated from the Supabase ``profiles`` row, and ``Principal`` defaults to
    ``("analyst",)``. So on a static-``API_KEY`` deployment ``current_principal``
    401s (there is no Supabase token to validate) and on a keyless box the
    ``local`` identity is an ``analyst`` — bolting the role check straight on
    would lock the operator out of their own console on every deployment that
    does not run Supabase.

    The rule instead: **a deployment with no multi-user identity has exactly one
    user, and that user is the operator.** With Supabase unconfigured, holding
    the static key (or having deliberately set ``ALLOW_UNAUTHENTICATED=1``) IS
    the operator credential and there is no second person to separate from. With
    Supabase configured there IS a second person, so, in order:

      1. the ``admin`` role (403 otherwise);
      2. an ``aal2`` session, i.e. MFA, unless ``OPERATOR_REQUIRE_MFA=0``
         (403 naming MFA enrolment otherwise; ASVS V6.3.3 / V6.8.4 / V10.3.4);
      3. the account still active in GoTrue, cached at most 60 s, so a banned or
         deleted admin loses operator authority within a minute rather than at
         token expiry (401 otherwise; ASVS V7.4.2 / V7.4.5).

    Deliberately does NOT widen ``current_principal_or_local``'s roles. That
    least-privilege ``analyst`` default is what the clearance-gated routes
    (``/api/audit``, ``/api/extract``, ``/api/collab``, ``/api/intel``) read, and
    granting blanket admin there would relax five surfaces to harden two.

    Composes with, and does not replace, the compute-path gate: ``/api/workflows``
    and ``/api/ai/models`` are already in ``ratelimit._COMPUTE_PREFIXES``, so a
    keyless box refuses them outright until the operator opts in.
    """
    s = get_settings()
    if not _multi_user(s):
        return
    if not p.has_role("admin"):
        raise HTTPException(
            status_code=403,
            detail="this endpoint carries operator authority and requires the admin role",
        )
    if s.operator_require_mfa and (_jwt_claims(p.token) or {}).get("aal") != "aal2":
        raise HTTPException(status_code=403, detail=MFA_REQUIRED_DETAIL)
    if not await _session_active(p.token, s):
        raise HTTPException(
            status_code=401,
            detail=(
                "this session is no longer active (signed out, banned or deleted); "
                "sign in again"
            ),
        )


def _multi_user(s: Settings) -> bool:
    """True when the deployment can tell two humans apart. Supabase is the only
    identity backend here (the ontology's Supabase backend was deleted; this is
    auth, not storage), so its absence means one operator."""
    return bool(s.supabase_jwt_secret or (s.supabase_url and s.supabase_anon_key))
