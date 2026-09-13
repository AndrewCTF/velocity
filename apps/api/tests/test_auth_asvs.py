"""ASVS 5.0 L2 authentication: token strictness (V9), the internal MCP token's
boundary (V9.2.4 / V6.8.1), failed-credential throttling (V6.3.1), minimum
secret length, revocation (V7.4.x) and operator MFA (V6.3.3 / V6.8.4 / V10.3.4).

Every multi-user case goes through ``_authkit.multi_user``, which drives the
environment so all modules see the same Settings.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import auth, security
from app.config import Settings, get_settings
from app.main import create_app
from app.security import Principal
from tests._authkit import ALICE, ISSUER, SECRET, URL, bearer, mint, multi_user

LONG_KEY = "k" * 40



# ── V9.1.2 / V9.2.1 / V9.2.3: what a session token must carry ───────────────


def test_a_valid_session_token_passes():
    assert auth._verify_hs256(mint(), SECRET, issuer=ISSUER) is True


def test_header_alg_must_be_hs256():
    # Signed with HMAC-SHA256 but labelled RS256: the audit's live run accepted it.
    assert auth._verify_hs256(mint(alg="RS256"), SECRET, issuer=ISSUER) is False
    assert auth._verify_hs256(mint(alg="none"), SECRET, issuer=ISSUER) is False
    assert auth._verify_hs256(mint(header={"typ": "JWT"}), SECRET, issuer=ISSUER) is False
    assert auth._verify_hs256(
        mint(header={"alg": "HS256", "typ": "at+jwt-other"}), SECRET, issuer=ISSUER
    ) is False


def test_exp_and_sub_are_required():
    assert auth._verify_hs256(mint(exp=None), SECRET, issuer=ISSUER) is False
    assert auth._verify_hs256(mint(sub=None), SECRET, issuer=ISSUER) is False
    assert auth._verify_hs256(mint(sub=""), SECRET, issuer=ISSUER) is False


def test_an_implausibly_long_lived_token_is_refused():
    now = int(time.time())
    assert auth._verify_hs256(mint(iat=now, exp=now + 30 * 86_400), SECRET, issuer=ISSUER) is False
    # No iat: the remaining lifetime is what is capped.
    assert auth._verify_hs256(mint(iat=None, exp=now + 30 * 86_400), SECRET, issuer=ISSUER) is False
    assert auth._verify_hs256(mint(iat=None, exp=now + 600), SECRET, issuer=ISSUER) is True


def test_issuer_is_checked_when_supabase_url_is_known():
    assert auth._verify_hs256(mint(iss="https://evil.supabase.co/auth/v1"), SECRET, issuer=ISSUER) is False
    assert auth._verify_hs256(mint(iss=None), SECRET, issuer=ISSUER) is False
    # JWT-secret-only deployment: nothing to compare against.
    assert auth._verify_hs256(mint(iss="anything"), SECRET, issuer="") is True


def test_expected_issuer_derives_from_url_and_can_be_overridden():
    assert auth.expected_issuer(Settings(supabase_url=URL + "/")) == ISSUER
    assert auth.expected_issuer(Settings(supabase_url=URL, supabase_jwt_issuer="https://auth.x/v1")) == "https://auth.x/v1"
    assert auth.expected_issuer(Settings(supabase_url="")) == ""


def test_gotrue_path_applies_role_aud_and_issuer_after_a_200(monkeypatch):
    """Without a JWT secret the backend asks GoTrue; a 200 used to be the whole
    check, so an anon-role or foreign-audience token that GoTrue answered passed."""
    s = Settings(supabase_url=URL, supabase_anon_key="anon", supabase_jwt_secret="")

    async def _ok(token, settings):
        return 200

    monkeypatch.setattr(auth, "_gotrue_status", _ok)
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(mint(), s)) is True
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(mint(role="anon"), s)) is False
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(mint(aud="service"), s)) is False
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(mint(iss="https://x/auth/v1"), s)) is False
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(mint(exp=None), s)) is False


# ── V9.2.4 / V6.8.1: the internal MCP token is not a user session ───────────


def test_internal_token_has_its_own_audience_and_issuer(monkeypatch):
    from app import mcp_server as M

    M._minted_jwt = None
    token = M._mint_internal_jwt(SECRET)
    claims = auth._jwt_claims(token) or {}
    assert claims["aud"] == auth.INTERNAL_AUDIENCE
    assert claims["iss"] == auth.INTERNAL_ISSUER
    assert claims["role"] != "authenticated"
    assert auth._verify_internal(token, SECRET) is True
    assert auth._verify_internal(token, "other-secret-" + "x" * 32) is False
    # Never a user session, with or without a configured issuer.
    assert auth._verify_hs256(token, SECRET, issuer="") is False
    assert auth._verify_hs256(token, SECRET, issuer=ISSUER) is False
    # And a user session is not an internal token.
    assert auth._verify_internal(mint(), SECRET) is False
    M._minted_jwt = None


def test_internal_token_opens_the_api_hop_but_never_a_user_route(monkeypatch):
    from app import mcp_server as M

    multi_user(monkeypatch, url=False)
    M._minted_jwt = None
    headers = M._headers()
    assert "Authorization" in headers
    with TestClient(create_app()) as c:
        # The hop the MCP tools make: a data route behind ApiKeyMiddleware only.
        assert c.get("/api/watch-officer/status", headers=headers).status_code == 200
        assert c.get("/api/watch-officer/status", headers=bearer("junk.junk.junk")).status_code == 401
        # A route that resolves a USER refuses it: it has no human behind it.
        assert c.get("/api/maps", headers=headers).status_code == 401
        assert c.get("/api/maps", headers=bearer(mint())).status_code == 200
    M._minted_jwt = None


def test_internal_token_is_not_accepted_on_a_websocket(monkeypatch):
    from app import mcp_server as M

    multi_user(monkeypatch, url=False)
    M._minted_jwt = None
    token = M._mint_internal_jwt(SECRET)

    class _WS:
        headers: dict[str, str] = {}
        client = None

        def __init__(self, q):
            self.query_params = q

    assert asyncio.run(auth.require_ws_key(_WS({"key": token}))) is False
    assert asyncio.run(auth.require_ws_key(_WS({"key": mint()}))) is True
    M._minted_jwt = None


# ── V6.3.1: failed-credential throttling ────────────────────────────────────


def test_failed_api_keys_lock_the_client_out_then_429_with_retry_after(monkeypatch):
    monkeypatch.setenv("API_KEY", LONG_KEY)
    monkeypatch.setenv("AUTH_FAILURE_LIMIT_PER_MIN", "5")
    get_settings.cache_clear()
    auth.reset_state()
    with TestClient(create_app()) as c:
        for _ in range(5):
            assert c.get("/api/watch-officer/status", headers={"X-API-Key": "wrong"}).status_code == 401
        r = c.get("/api/watch-officer/status", headers={"X-API-Key": "wrong"})
        assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1
        # Locked means locked: the right key does not reveal itself as right.
        assert c.get("/api/watch-officer/status", headers={"X-API-Key": LONG_KEY}).status_code == 429


def test_a_missing_credential_is_not_a_failed_guess(monkeypatch):
    monkeypatch.setenv("API_KEY", LONG_KEY)
    monkeypatch.setenv("AUTH_FAILURE_LIMIT_PER_MIN", "3")
    get_settings.cache_clear()
    auth.reset_state()
    with TestClient(create_app()) as c:
        for _ in range(10):
            assert c.get("/api/watch-officer/status").status_code == 401
        assert c.get("/api/watch-officer/status", headers={"X-API-Key": LONG_KEY}).status_code == 200


def test_the_lockout_is_per_client():
    auth.reset_state()
    lim = auth.failure_limiter()
    for _ in range(3):
        lim.record("198.51.100.1", limit=3)
    assert lim.retry_after("198.51.100.1", limit=3) is not None
    assert lim.retry_after("198.51.100.2", limit=3) is None


def test_ws_and_route_dependency_are_throttled_too(monkeypatch):
    monkeypatch.setenv("API_KEY", LONG_KEY)
    monkeypatch.setenv("AUTH_FAILURE_LIMIT_PER_MIN", "2")
    get_settings.cache_clear()
    auth.reset_state()

    class _Client:
        host = "203.0.113.9"

    class _WS:
        client = _Client()
        headers: dict[str, str] = {}

        def __init__(self, q):
            self.query_params = q

    assert asyncio.run(auth.require_ws_key(_WS({"key": "bad"}))) is False
    assert asyncio.run(auth.require_ws_key(_WS({"key": "bad"}))) is False
    assert asyncio.run(auth.require_ws_key(_WS({"key": LONG_KEY}))) is False  # locked

    class _Req:
        client = _Client()
        headers: dict[str, str] = {}

    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth.require_api_key(_Req(), x_api_key=LONG_KEY))  # type: ignore[arg-type]
    assert exc.value.status_code == 429


# ── secret length ───────────────────────────────────────────────────────────


def test_short_api_key_is_refused_at_startup(monkeypatch):
    with pytest.raises(RuntimeError, match="API_KEY"):
        auth.check_credential_strength(Settings(api_key="short-key"))
    with pytest.raises(RuntimeError, match="SUPABASE_JWT_SECRET"):
        auth.check_credential_strength(Settings(supabase_jwt_secret="short"))
    auth.check_credential_strength(Settings(api_key=LONG_KEY, supabase_jwt_secret=SECRET))
    auth.check_credential_strength(Settings(api_key="", supabase_jwt_secret=""))

    monkeypatch.setenv("API_KEY", "secret-test-key")
    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="API_KEY"):
        with TestClient(create_app()):
            pass


# ── V7.4.1: positive cache TTL ──────────────────────────────────────────────


def test_token_cache_holds_a_validation_for_at_most_a_minute(monkeypatch):
    s = Settings(supabase_jwt_secret=SECRET, supabase_url=URL, supabase_anon_key="anon")
    auth.reset_state()
    tok = mint(exp=int(time.time()) + 3000)
    assert asyncio.run(auth._valid_supabase_token(tok, s)) is True
    assert auth._token_ok_until[tok] - time.time() <= 60.5


# ── V7.4.2 / V7.4.5: a banned or deleted admin stops at once ────────────────


def _admin(token: str) -> Principal:
    return Principal(user_id=ALICE, token=token, roles=("admin",))


def test_operator_route_refuses_an_admin_gotrue_no_longer_knows(monkeypatch):
    multi_user(monkeypatch, active=False)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(security.require_operator(_admin(mint())))
    assert exc.value.status_code == 401


def test_session_liveness_asks_gotrue_and_caches_for_a_minute(monkeypatch):
    s = Settings(supabase_url=URL, supabase_anon_key="anon", supabase_jwt_secret=SECRET)
    calls: list[str] = []
    answers = {"ok": (200, {"id": ALICE}), "banned": (200, {"id": ALICE, "banned_until": "2999-01-01T00:00:00Z"}), "gone": (404, {})}

    async def _user(token, settings):
        calls.append(token)
        return answers[token]

    monkeypatch.setattr(auth, "_gotrue_user", _user)
    security.reset_state()
    assert asyncio.run(security._session_active("ok", s)) is True
    assert asyncio.run(security._session_active("ok", s)) is True
    assert calls == ["ok"]
    assert security._active_until["ok"] - time.time() <= 60.5
    assert asyncio.run(security._session_active("banned", s)) is False
    assert asyncio.run(security._session_active("gone", s)) is False
    # A JWT-secret-only deployment has no GoTrue to ask: documented residual.
    assert asyncio.run(security._session_active("x", Settings(supabase_jwt_secret=SECRET))) is True


# ── V6.3.3 / V6.8.4 / V10.3.4: operator authority needs MFA ─────────────────


def test_aal1_admin_is_refused_with_an_mfa_message(monkeypatch):
    multi_user(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(security.require_operator(_admin(mint(aal="aal1"))))
    assert exc.value.status_code == 403
    assert "MFA" in exc.value.detail and "enrol" in exc.value.detail


def test_aal2_admin_passes(monkeypatch):
    multi_user(monkeypatch)
    asyncio.run(security.require_operator(_admin(mint(aal="aal2"))))


def test_mfa_requirement_can_be_switched_off(monkeypatch):
    multi_user(monkeypatch)
    monkeypatch.setenv("OPERATOR_REQUIRE_MFA", "0")
    get_settings.cache_clear()
    asyncio.run(security.require_operator(_admin(mint(aal="aal1"))))


def test_single_user_modes_need_no_mfa(monkeypatch):
    monkeypatch.setenv("API_KEY", LONG_KEY)
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "")
    monkeypatch.setenv("SUPABASE_URL", "")
    get_settings.cache_clear()
    asyncio.run(security.require_operator(Principal(user_id="local", token="")))


def test_operator_mfa_end_to_end_over_http(monkeypatch):
    multi_user(monkeypatch, roles={ALICE: ["admin"]})
    with TestClient(create_app()) as c:
        body = {"name": "w", "spec": {"nodes": [], "edges": []}}
        r = c.post("/api/workflows", json=body, headers=bearer(mint(aal="aal1")))
        assert r.status_code == 403 and "MFA" in r.json()["detail"]
        r = c.post("/api/workflows", json=body, headers=bearer(mint(aal="aal2")))
        assert r.status_code != 403, r.text
