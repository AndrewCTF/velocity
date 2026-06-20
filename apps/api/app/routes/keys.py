"""BYOK key management — /api/keys.

All routes require a signed-in Supabase user (``current_user``). Keys are
returned only as masked hints; the plaintext is write-only from the client's
perspective.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app import keys as byok
from app.auth import _jwt_claims
from app.keys import UserCtx, current_user

router = APIRouter(tags=["keys"])


class ProviderInfo(BaseModel):
    id: str
    label: str
    help: str
    wired: bool


class StoredKey(BaseModel):
    provider: str
    hint: str
    updated_at: str | None = None


class KeysResponse(BaseModel):
    providers: list[ProviderInfo]
    keys: list[StoredKey]


class MeResponse(BaseModel):
    user_id: str
    email: str | None = None
    tier: str | None = None
    status: str | None = None


class PutKeyBody(BaseModel):
    value: str = Field(..., min_length=1, max_length=8192)


@router.get("/api/me", response_model=MeResponse)
async def get_me(ctx: UserCtx = Depends(current_user)) -> MeResponse:
    """Signed-in user's profile, derived from the Supabase JWT claims.

    The frontend (SettingsModal) calls this to render the account row. On a
    keyless local box ``current_user`` returns 401 (same as ``/api/keys``) and
    the caller's ``r.ok`` guard quietly skips. ``tier``/``status`` are not yet
    sourced from the subscriptions table, so they are reported as unknown
    (``None``) rather than fabricated — the UI already renders a fallback.
    """
    claims = _jwt_claims(ctx.token) or {}
    email = claims.get("email")
    if not email:
        # Supabase stashes user fields under user_metadata for some grants.
        meta = claims.get("user_metadata") or {}
        if isinstance(meta, dict):
            email = meta.get("email")
    return MeResponse(user_id=ctx.user_id, email=email, tier=None, status=None)


@router.get("/api/keys", response_model=KeysResponse)
async def get_keys(ctx: UserCtx = Depends(current_user)) -> KeysResponse:
    rows = await byok.list_keys(ctx)
    return KeysResponse(
        providers=[ProviderInfo(**p.__dict__) for p in byok.PROVIDERS.values()],
        keys=[StoredKey(**r) for r in rows],
    )


@router.put("/api/keys/{provider}", response_model=StoredKey)
async def put_key(
    provider: str, body: PutKeyBody, ctx: UserCtx = Depends(current_user)
) -> StoredKey:
    if provider not in byok.PROVIDERS:
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail="unknown provider")
    saved = await byok.put_key(ctx, provider, body.value)
    return StoredKey(**saved)


@router.delete("/api/keys/{provider}", status_code=204)
async def delete_key(provider: str, ctx: UserCtx = Depends(current_user)) -> None:
    await byok.delete_key(ctx, provider)
