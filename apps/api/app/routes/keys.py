"""BYOK key management — /api/keys.

All routes require a signed-in Supabase user (``current_user``). Keys are
returned only as masked hints; the plaintext is write-only from the client's
perspective.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app import keys as byok
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


class PutKeyBody(BaseModel):
    value: str = Field(..., min_length=1, max_length=8192)


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
