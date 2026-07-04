"""MCP self-hop auth: internal Supabase-JWT minting (B1) + mmsi coercion (B13).

In prod the backend's auth gate is Supabase-JWT-only (no static ``API_KEY``),
so the MCP's localhost hop to ``/api/intel/*`` must carry a credential it can
mint itself. ``_headers()`` signs a short-lived HS256 token; these tests prove
it is accepted by the REAL validator (``app.auth._verify_hs256``) and that the
static-key / open-box behaviour is unchanged.
"""

from __future__ import annotations

import pytest

from app import auth
from app import mcp_server as M
from app.config import get_settings

_SECRET = "test-supabase-jwt-secret-zzzz-0987654321"


@pytest.fixture(autouse=True)
def _isolate(monkeypatch: pytest.MonkeyPatch):
    """No static key from the env, and reset the mint cache between tests."""
    monkeypatch.delenv("API_KEY", raising=False)
    M._minted_jwt = None
    s = get_settings()
    api_key0 = s.api_key
    secret0 = s.supabase_jwt_secret
    object.__setattr__(s, "api_key", "")
    object.__setattr__(s, "supabase_jwt_secret", "")
    yield
    object.__setattr__(s, "api_key", api_key0)
    object.__setattr__(s, "supabase_jwt_secret", secret0)
    M._minted_jwt = None


def test_minted_token_passes_real_validator() -> None:
    s = get_settings()
    object.__setattr__(s, "supabase_jwt_secret", _SECRET)

    headers = M._headers()
    assert set(headers) == {"Authorization"}
    token = headers["Authorization"].removeprefix("Bearer ")

    # The actual backend gate must accept it...
    assert auth._verify_hs256(token, _SECRET) is True
    # ...and reject it under any other secret (signature is real).
    assert auth._verify_hs256(token, "some-other-secret") is False

    claims = auth._jwt_claims(token) or {}
    assert claims.get("role") == "authenticated"  # the claim the gate demands
    assert claims.get("aud") == "authenticated"
    assert claims.get("exp", 0) > claims.get("iat", 0)


def test_token_is_cached_within_ttl() -> None:
    s = get_settings()
    object.__setattr__(s, "supabase_jwt_secret", _SECRET)
    first = M._headers()["Authorization"]
    second = M._headers()["Authorization"]
    assert first == second  # re-signs at most once per TTL, not per call


def test_static_api_key_still_wins() -> None:
    s = get_settings()
    object.__setattr__(s, "api_key", "STATIC-KEY-123")
    object.__setattr__(s, "supabase_jwt_secret", _SECRET)
    # Static key path is unchanged and takes precedence over minting.
    assert M._headers() == {"X-API-Key": "STATIC-KEY-123"}


def test_open_box_sends_no_auth() -> None:
    # Neither api_key nor supabase_jwt_secret set -> behave as before (no header).
    assert M._headers() == {}


@pytest.mark.asyncio
async def test_vessel_dossier_accepts_int_mmsi(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """B13: an integer MMSI must be coerced to the path, not rejected/leaked."""
    captured: dict[str, str] = {}

    async def _fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        captured["path"] = path
        return {"ok": True}

    monkeypatch.setattr(M, "_get", _fake_get)
    out = await M.vessel_dossier(422000000)
    assert out == {"ok": True}
    assert captured["path"] == "/api/intel/dossier/vessel/422000000"
