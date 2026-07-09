"""BYOK — bring-your-own-key storage, encrypted per user.

User-supplied upstream API keys (Cesium ion, Google Maps, NASA FIRMS, OpenSky,
AISStream, an LLM key, …) are stored **Fernet-encrypted** in Supabase
``public.user_keys`` and never returned to the browser in plaintext — the GET
route hands back only a masked ``hint`` (last 4 chars).

Storage path is PostgREST with the caller's own Supabase access token, so
row-level security (``auth.uid() = user_id``) scopes every read/write to the
signed-in user. The backend adds a second layer on top: it encrypts before
write and decrypts after read with ``BYOK_ENC_KEY``, so even a DB compromise
(or a Supabase admin) sees only ciphertext.

``resolve_user_key(token, provider)`` is the server-side accessor other modules
use to pull a user's decrypted key for an upstream call.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, Request

from app.auth import _bearer, _jwt_claims, _valid_supabase_token
from app.config import Settings, get_settings

# ── provider catalog ─────────────────────────────────────────────────────────
# The set of keys a user may bring. `wired` marks whether the backend already
# USES the stored key for live upstreams (vs. stored-only, pending wiring) — the
# UI shows this honestly so we never imply coverage we don't have.


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    help: str
    wired: bool


PROVIDERS: dict[str, Provider] = {
    p.id: p
    for p in (
        Provider(
            "cesium_ion",
            "Cesium ion token",
            "Higher-res 3D terrain + imagery in the satellite view.",
            False,
        ),
        Provider(
            "google_maps",
            "Google Maps Platform key",
            "Photorealistic 3D Tiles (global photogrammetry) in 3D-sat mode.",
            False,
        ),
        Provider(
            "firms",
            "NASA FIRMS MAP_KEY",
            "Live wildfire/thermal detections (VIIRS/MODIS).",
            True,
        ),
        Provider(
            "opensky_client",
            "OpenSky client id",
            "Authenticated ADS-B — more daily credits than anonymous.",
            False,
        ),
        Provider(
            "opensky_secret",
            "OpenSky client secret",
            "Pairs with the OpenSky client id (OAuth2).",
            False,
        ),
        Provider(
            "aisstream",
            "AISStream.io API key",
            "Live global AIS vessel push over WebSocket.",
            False,
        ),
        Provider(
            "llm",
            "LLM API key",
            "Bring your own model key for the analysis agent (OpenAI-compatible).",
            False,
        ),
    )
}


# ── Fernet crypto ────────────────────────────────────────────────────────────


def _fernet(s: Settings) -> Fernet:
    if not s.byok_enc_key:
        raise HTTPException(
            status_code=503, detail="BYOK is not configured (BYOK_ENC_KEY unset)"
        )
    try:
        return Fernet(s.byok_enc_key.encode())
    except (ValueError, TypeError) as exc:  # malformed key
        raise HTTPException(status_code=503, detail="BYOK key is malformed") from exc


def encrypt_value(value: str, s: Settings | None = None) -> str:
    s = s or get_settings()
    return _fernet(s).encrypt(value.encode()).decode()


def decrypt_value(ciphertext: str, s: Settings | None = None) -> str | None:
    s = s or get_settings()
    try:
        return _fernet(s).decrypt(ciphertext.encode()).decode()
    except (InvalidToken, ValueError):
        return None


def mask(value: str) -> str:
    """Last-4 hint for display; never the whole key."""
    v = value.strip()
    return v[-4:] if len(v) >= 4 else "•" * len(v)


# ── current-user dependency ──────────────────────────────────────────────────


@dataclass(frozen=True)
class UserCtx:
    user_id: str
    token: str


async def current_user(request: Request) -> UserCtx:
    """Resolve the signed-in Supabase user (id + access token).

    The global ApiKeyMiddleware already proved the request is authorized, but a
    static API_KEY caller has no user identity — BYOK requires a real user, so
    we re-extract + validate the bearer token and pull ``sub``.
    """
    s = get_settings()
    token = (
        _bearer(request.headers)
        or request.query_params.get("key")
        or request.headers.get("x-api-key")
    )
    if not token or not await _valid_supabase_token(token, s):
        raise HTTPException(status_code=401, detail="sign-in required")
    claims = _jwt_claims(token) or {}
    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="token has no subject")
    return UserCtx(user_id=str(sub), token=token)


async def current_user_or_local(request: Request) -> UserCtx:
    """``current_user``, degrading to a local identity on a keyless boot.

    When Supabase is entirely unconfigured (no JWT secret and no url+anon key —
    the exact condition under which ``_valid_supabase_token`` can never return
    True) there is no user identity to resolve, but the request has already
    passed ``ApiKeyMiddleware``; callers that can be served by the LOCAL
    ontology store (ontology / situations / maps routes) get the shared
    ``local`` identity instead of a dead 401. With Supabase configured this is
    exactly ``current_user`` — prod behavior unchanged. Note: static-API_KEY
    deployments share one ``local`` graph (single-operator platform; recorded
    in docs/decisions.md).
    """
    s = get_settings()
    if not (s.supabase_jwt_secret or (s.supabase_url and s.supabase_anon_key)):
        return UserCtx(user_id="local", token="")
    return await current_user(request)


# ── PostgREST access (RLS-scoped via the user's own token) ────────────────────


def _rest_base(s: Settings) -> str:
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    return s.supabase_url.rstrip("/") + "/rest/v1/user_keys"


def _client() -> httpx.AsyncClient:
    # IPv4-pinned: some egress hosts publish broken AAAA (see app.auth / memory).
    return httpx.AsyncClient(
        timeout=httpx.Timeout(8.0, connect=5.0),
        transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=1),
    )


def _headers(ctx: UserCtx, s: Settings, *, write: bool = False) -> dict[str, str]:
    h = {
        "apikey": s.supabase_anon_key,
        "Authorization": f"Bearer {ctx.token}",
        "Accept": "application/json",
    }
    if write:
        h["Content-Type"] = "application/json"
        h["Prefer"] = "resolution=merge-duplicates,return=minimal"
    return h


async def list_keys(ctx: UserCtx, s: Settings | None = None) -> list[dict]:
    """Stored providers for the user, masked (provider, hint, updated_at)."""
    s = s or get_settings()
    url = _rest_base(s)
    async with _client() as c:
        r = await c.get(
            url,
            params={
                "user_id": f"eq.{ctx.user_id}",
                "select": "provider,hint,updated_at",
            },
            headers=_headers(ctx, s),
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="key store unavailable")
    rows = r.json()
    return rows if isinstance(rows, list) else []


async def put_key(ctx: UserCtx, provider: str, value: str, s: Settings | None = None) -> dict:
    s = s or get_settings()
    value = value.strip()
    if not value:
        raise HTTPException(status_code=400, detail="empty key")
    row = {
        "user_id": ctx.user_id,
        "provider": provider,
        "ciphertext": encrypt_value(value, s),
        "hint": mask(value),
        "updated_at": _now_iso(),
    }
    async with _client() as c:
        r = await c.post(_rest_base(s), json=row, headers=_headers(ctx, s, write=True))
    if r.status_code not in (200, 201, 204):
        raise HTTPException(status_code=502, detail="could not save key")
    return {"provider": provider, "hint": row["hint"], "updated_at": row["updated_at"]}


async def delete_key(ctx: UserCtx, provider: str, s: Settings | None = None) -> None:
    s = s or get_settings()
    async with _client() as c:
        r = await c.delete(
            _rest_base(s),
            params={"user_id": f"eq.{ctx.user_id}", "provider": f"eq.{provider}"},
            headers=_headers(ctx, s),
        )
    if r.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail="could not delete key")


async def resolve_user_key(token: str, provider: str, s: Settings | None = None) -> str | None:
    """Server-side: fetch + decrypt a user's key for an upstream call.

    Returns None when unset/unreadable so callers fall back to the env default.
    """
    s = s or get_settings()
    if not (token and s.supabase_url and s.byok_enc_key):
        return None
    claims = _jwt_claims(token) or {}
    sub = claims.get("sub")
    if not sub:
        return None
    ctx = UserCtx(user_id=str(sub), token=token)
    async with _client() as c:
        r = await c.get(
            _rest_base(s),
            params={
                "user_id": f"eq.{sub}",
                "provider": f"eq.{provider}",
                "select": "ciphertext",
                "limit": "1",
            },
            headers=_headers(ctx, s),
        )
    if r.status_code != 200:
        return None
    rows = r.json()
    if not rows:
        return None
    return decrypt_value(rows[0].get("ciphertext", ""), s)


def _now_iso() -> str:
    # UTC ISO-8601; PostgREST stores it into a timestamptz column.
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
