"""Shared helpers for the multi-user (Supabase) auth tests.

Not a test module. ``mint`` signs HS256 tokens with any claim set, including a
wrong header ``alg``; ``multi_user`` switches the whole process into multi-user
mode through the ENVIRONMENT plus ``get_settings.cache_clear()``, because
``auth``, ``security``, ``keys`` and the routes each import ``get_settings`` by
name and patching one module's copy leaves the others single-user.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

import pytest

from app.config import get_settings

SECRET = "multi-user-test-jwt-secret-0123456789abcdef"
URL = "https://example.supabase.co"
ISSUER = f"{URL}/auth/v1"
ALICE = "11111111-1111-4111-8111-111111111111"
BOB = "22222222-2222-4222-8222-222222222222"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def mint(
    sub: str | None = ALICE,
    *,
    secret: str = SECRET,
    alg: str = "HS256",
    header: dict[str, Any] | None = None,
    **claims: Any,
) -> str:
    """A signed token. Claims default to a valid Supabase aal2 session; pass a
    claim as ``None`` to drop it."""
    now = int(time.time())
    base: dict[str, Any] = {
        "sub": sub,
        "role": "authenticated",
        "aud": "authenticated",
        "iss": ISSUER,
        "iat": now,
        "exp": now + 3600,
        "aal": "aal2",
    }
    base.update(claims)
    body = {k: v for k, v in base.items() if v is not None}
    head = header if header is not None else {"alg": alg, "typ": "JWT"}
    h, p = _b64(json.dumps(head).encode()), _b64(json.dumps(body).encode())
    sig = hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}.{_b64(sig)}"


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def multi_user(
    monkeypatch: pytest.MonkeyPatch,
    *,
    url: bool = True,
    api_key: str = "",
    roles: dict[str, list[str]] | None = None,
    active: bool = True,
) -> None:
    """Multi-user mode. ``url=False`` is the JWT-secret-only shape (no GoTrue,
    no PostgREST). ``roles`` maps sub -> profile roles (default analyst), served
    without HTTP; ``active`` is what the GoTrue liveness check answers."""
    from app import auth, security  # noqa: PLC0415

    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("SUPABASE_URL", URL if url else "")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key" if url else "")
    monkeypatch.setenv("API_KEY", api_key)
    get_settings.cache_clear()
    auth.reset_state()
    security.reset_state()
    table = roles or {}

    async def _profile(ctx: Any, s: Any) -> dict[str, Any]:
        return {"roles": table.get(ctx.user_id, ["analyst"]), "clearance": 0, "compartments": []}

    async def _active(token: str, s: Any) -> bool:
        return active

    monkeypatch.setattr(security, "_fetch_profile", _profile)
    monkeypatch.setattr(security, "_session_active", _active)
