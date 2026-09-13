"""ASVS 5.0 fixes, backend auth: forged-bearer recon ownership (V6.8.2 / V7.2.1 /
V9.1.1), the /api/config credential oracle (V6.3.1 / V6.3.4), session liveness on
every route (V7.4.1 / V7.4.2), absolute session age (V7.3.2), MFA for all users
(V6.3.3), asymmetric JWKS verification (V11.2.2), the WebSocket subprotocol
credential (V14.2.1) and success logging (V16.3.1)."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import auth
from app.config import Settings, get_settings
from app.main import create_app
from tests._authkit import ALICE, BOB, ISSUER, SECRET, URL, bearer, mint, multi_user

LONG_KEY = "k" * 40


@pytest.fixture(autouse=True)
def _stub_session_liveness() -> None:
    """Overrides conftest's stub: these tests exercise the real liveness hook."""


@pytest.fixture(autouse=True)
def _gotrue_active(monkeypatch):
    """GoTrue answers "active" unless a test says otherwise (never the network)."""

    async def _user(token, s):
        return 200, {"id": ALICE}

    monkeypatch.setattr(auth, "_gotrue_user", _user)


# ── V6.8.2 / V7.2.1 / V9.1.1: recon owner comes from a VERIFIED token ────────


def test_a_forged_bearer_cannot_pick_the_recon_job_owner(monkeypatch):
    from app.routes import recon

    multi_user(monkeypatch, api_key=LONG_KEY)
    recon._JOBS["job-bob"] = recon._new_job_record("job-bob", BOB)
    forged = mint(BOB, secret="not-the-project-secret-0123456789abcdef")
    headers = {"X-API-Key": LONG_KEY, **bearer(forged)}
    try:
        with TestClient(create_app()) as c:
            r = c.get("/api/recon/jobs", headers=headers)
            assert r.status_code == 200, r.text
            assert r.json()["jobs"] == []
            assert c.get("/api/recon/jobs/job-bob", headers=headers).status_code == 404
            # Bob's real session still sees his own job.
            r = c.get("/api/recon/jobs/job-bob", headers=bearer(mint(BOB)))
            assert r.status_code == 200, r.text
    finally:
        recon._JOBS.pop("job-bob", None)


# ── V6.3.1 / V6.3.4: /api/config goes through the lockout ───────────────────


def test_config_counts_bad_credentials_and_honours_the_lockout(monkeypatch):
    monkeypatch.setenv("API_KEY", LONG_KEY)
    monkeypatch.setenv("AUTH_FAILURE_LIMIT_PER_MIN", "3")
    monkeypatch.setenv("CESIUM_ION_TOKEN", "ion-token-for-test")
    get_settings.cache_clear()
    auth.reset_state()
    with TestClient(create_app()) as c:
        assert c.get("/api/config", headers={"X-API-Key": LONG_KEY}).json()["cesiumIonToken"]
        # Anonymous polls are not guesses.
        for _ in range(5):
            assert c.get("/api/config").json()["cesiumIonToken"] == ""
        for _ in range(3):
            r = c.get("/api/config", headers={"X-API-Key": "wrong"})
            assert r.status_code == 200 and r.json()["cesiumIonToken"] == ""
        # Locked: the right key no longer reveals anything, here or elsewhere.
        r = c.get("/api/config", headers={"X-API-Key": LONG_KEY})
        assert r.status_code == 200 and r.json()["cesiumIonToken"] == ""
        assert c.get("/api/watch-officer/status", headers={"X-API-Key": LONG_KEY}).status_code == 429


def test_every_authorized_call_outside_auth_is_behind_the_lockout():
    """Anti-rot (V6.3.4): a new pathway that calls ``_authorized`` must check
    ``_locked`` first in the same function, or it is a lockout-free oracle."""
    app_dir = Path(auth.__file__).parent
    offenders = []
    for path in app_dir.rglob("*.py"):
        if path.name == "auth.py":
            continue
        text = path.read_text(encoding="utf-8")
        for m in re.finditer(r"\b_authorized\(", text):
            if text[: m.start()].rstrip().endswith("import"):
                continue
            fn_start = text.rfind("\ndef ", 0, m.start())
            fn_start = max(fn_start, text.rfind("\nasync def ", 0, m.start()))
            if "_locked(" not in text[fn_start : m.start()]:
                offenders.append(f"{path.relative_to(app_dir)}:{text.count(chr(10), 0, m.start()) + 1}")
    assert offenders == [], offenders


# ── V7.4.1 / V7.4.2: a dead session stops on EVERY route within a minute ────


def test_a_signed_out_user_is_refused_on_a_non_operator_route(monkeypatch):
    multi_user(monkeypatch)
    answers = {"ok": (200, {"id": ALICE})}

    async def _user(token, s):
        return answers["ok"]

    monkeypatch.setattr(auth, "_gotrue_user", _user)
    tok = mint()
    with TestClient(create_app()) as c:
        assert c.get("/api/maps", headers=bearer(tok)).status_code == 200
        answers["ok"] = (401, {})  # signed out / deleted in GoTrue
        auth.reset_state()  # the <=60 s cache has expired
        assert c.get("/api/maps", headers=bearer(tok)).status_code == 401
        assert c.get("/api/watch-officer/status", headers=bearer(tok)).status_code == 401


def test_a_banned_user_is_refused_and_a_gotrue_outage_fails_closed(monkeypatch):
    s = Settings(supabase_jwt_secret=SECRET, supabase_url=URL, supabase_anon_key="anon")
    tok = mint()

    async def _banned(token, settings):
        return 200, {"id": ALICE, "banned_until": "2999-01-01T00:00:00Z"}

    monkeypatch.setattr(auth, "_gotrue_user", _banned)
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(tok, s)) is False

    async def _down(token, settings):
        return 0, {}

    monkeypatch.setattr(auth, "_gotrue_user", _down)
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(tok, s)) is False


def test_liveness_is_cached_per_token_and_can_be_switched_off(monkeypatch):
    calls: list[str] = []

    async def _user(token, settings):
        calls.append(token)
        return 404, {}

    monkeypatch.setattr(auth, "_gotrue_user", _user)
    tok = mint()
    auth.reset_state()
    off = Settings(
        supabase_jwt_secret=SECRET, supabase_url=URL, supabase_anon_key="anon",
        session_liveness_check=False,
    )
    assert asyncio.run(auth._valid_supabase_token(tok, off)) is True
    # JWT-secret-only: no GoTrue to ask (documented residual), no call made.
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(tok, Settings(supabase_jwt_secret=SECRET))) is True
    assert calls == []


# ── V7.3.2: absolute session age ────────────────────────────────────────────


def test_session_max_age_counts_from_sign_in_not_from_refresh():
    now = int(time.time())
    fresh = [{"method": "password", "timestamp": now - 600}]
    old = [{"method": "password", "timestamp": now - 13 * 3600}, {"method": "totp", "timestamp": now - 60}]
    s = Settings(supabase_jwt_secret=SECRET, session_max_age_s=12 * 3600)
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(mint(amr=fresh), s)) is True
    auth.reset_state()
    # Refreshed a minute ago (iat is new) but signed in 13 h ago: refused.
    assert asyncio.run(auth._valid_supabase_token(mint(amr=old), s)) is False
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(mint(), s)) is False  # no amr: fail closed
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(mint(amr=old), Settings(supabase_jwt_secret=SECRET))) is True


# ── V6.3.3: opt-in MFA for every user ───────────────────────────────────────


def test_require_mfa_all_users_refuses_aal1_everywhere(monkeypatch):
    multi_user(monkeypatch, url=False)
    with TestClient(create_app()) as c:
        assert c.get("/api/maps", headers=bearer(mint(aal="aal1"))).status_code == 200
    monkeypatch.setenv("REQUIRE_MFA_ALL_USERS", "1")
    get_settings.cache_clear()
    auth.reset_state()
    with TestClient(create_app()) as c:
        assert c.get("/api/maps", headers=bearer(mint(aal="aal1"))).status_code == 401
        assert c.get("/api/maps", headers=bearer(mint(aal="aal2"))).status_code == 200


# ── V11.2.2: ES256 / RS256 via JWKS ─────────────────────────────────────────


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _ec_key_and_jwk(kid: str = "k1"):
    from cryptography.hazmat.primitives.asymmetric import ec
    from jwt.algorithms import ECAlgorithm

    key = ec.generate_private_key(ec.SECP256R1())
    jwk = json.loads(ECAlgorithm.to_jwk(key.public_key()))
    jwk.update({"kid": kid, "alg": "ES256", "use": "sig"})
    return key, jwk


def _es256(key, kid: str = "k1", alg: str = "ES256", **claims) -> str:
    import jwt

    now = int(time.time())
    body = {
        "sub": ALICE, "role": "authenticated", "aud": "authenticated", "iss": ISSUER,
        "iat": now, "exp": now + 3600, "aal": "aal2", **claims,
    }
    return jwt.encode(body, key, algorithm=alg, headers={"kid": kid})


def test_es256_session_verifies_against_the_project_jwks(monkeypatch):
    key, jwk = _ec_key_and_jwk()
    fetches: list[str] = []

    async def _fetch(url):
        fetches.append(url)
        return {"keys": [jwk]}

    monkeypatch.setattr(auth, "_fetch_jwks", _fetch)
    s = Settings(supabase_url=URL, supabase_anon_key="anon")
    auth.reset_state()
    assert asyncio.run(auth._valid_supabase_token(_es256(key), s)) is True
    assert fetches == [f"{URL}/auth/v1/.well-known/jwks.json"]
    # Claim rules still apply to an asymmetric token.
    assert asyncio.run(auth._valid_supabase_token(_es256(key, role="anon"), s)) is False
    assert asyncio.run(auth._valid_supabase_token(_es256(key, iss="https://evil/auth/v1"), s)) is False
    # JWKS is cached: the checks above fetched once.
    assert len(fetches) == 1


def test_jwks_refuses_foreign_keys_unknown_kids_and_disallowed_algs(monkeypatch):
    key, jwk = _ec_key_and_jwk()
    other, _ = _ec_key_and_jwk()

    async def _fetch(url):
        return {"keys": [jwk]}

    monkeypatch.setattr(auth, "_fetch_jwks", _fetch)
    s = Settings(supabase_url=URL, supabase_anon_key="anon")
    for tok in (_es256(other), _es256(key, kid="unknown")):
        auth.reset_state()
        assert asyncio.run(auth._valid_supabase_token(tok, s)) is False
    # An allowlist without ES256 refuses a genuine ES256 token.
    auth.reset_state()
    narrow = Settings(supabase_url=URL, supabase_anon_key="anon", supabase_jwt_algorithms="HS256")
    assert asyncio.run(auth._valid_supabase_token(_es256(key), narrow)) is False
    # Algorithm confusion: an HS256 token whose header names the JWKS kid is
    # still HMAC-checked against the secret, never against the public key.
    auth.reset_state()
    hs = mint(header={"alg": "HS256", "typ": "JWT", "kid": "k1"}, secret="x" * 40)
    both = Settings(supabase_url=URL, supabase_anon_key="anon", supabase_jwt_secret=SECRET)
    assert asyncio.run(auth._valid_supabase_token(hs, both)) is False
    # HS256 labelled as ES256 with the kid: the EC key refuses the HMAC bytes.
    auth.reset_state()
    confused = mint(header={"alg": "ES256", "typ": "JWT", "kid": "k1"})
    assert asyncio.run(auth._valid_supabase_token(confused, both)) is False


# ── V14.2.1: the WS credential travels in Sec-WebSocket-Protocol ────────────


def test_ws_accepts_the_credential_as_a_subprotocol_and_echoes_only_the_version(monkeypatch):
    monkeypatch.setenv("API_KEY", LONG_KEY)
    get_settings.cache_clear()
    auth.reset_state()
    with TestClient(create_app()) as c:
        with c.websocket_connect(
            "/ws/alerts", subprotocols=["velocity.v1", f"key.{LONG_KEY}"]
        ) as ws:
            assert ws.accepted_subprotocol == "velocity.v1"
            assert LONG_KEY not in json.dumps(dict(ws.extra_headers or []), default=str)
        # A wrong key in the subprotocol is refused.
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/ws/alerts", subprotocols=["velocity.v1", "key.wrong"]) as ws:
                ws.receive_text()
        # ?key= still works (back-compat until the client switches).
        with c.websocket_connect(f"/ws/alerts?key={LONG_KEY}") as ws:
            assert ws.accepted_subprotocol is None


def test_ws_subprotocol_carries_a_session_token_to_the_route(monkeypatch):
    multi_user(monkeypatch, url=False)

    class _WS:
        client = None
        query_params: dict[str, str] = {}

        def __init__(self, protocols: str):
            self.headers = {"sec-websocket-protocol": protocols}

    tok = mint()
    assert auth.ws_credential(_WS(f"velocity.v1, key.{tok}")) == tok
    assert asyncio.run(auth.require_ws_key(_WS(f"velocity.v1, key.{tok}"))) is True
    assert asyncio.run(auth.require_ws_key(_WS("velocity.v1"))) is False


# ── V16.3.1: successful authentication is logged, once, without the secret ──


def test_success_is_logged_once_per_cache_miss_with_the_kind(monkeypatch, caplog):
    monkeypatch.setenv("API_KEY", LONG_KEY)
    get_settings.cache_clear()
    auth.reset_state()
    with caplog.at_level(logging.INFO, logger="app.auth"):
        with TestClient(create_app()) as c:
            for _ in range(3):
                assert c.get("/api/watch-officer/status", headers={"X-API-Key": LONG_KEY}).status_code == 200
            c.get("/api/watch-officer/status", headers={"X-API-Key": "wrong-" + "x" * 30})
    text = caplog.text
    assert text.count("auth success") == 1, text
    assert "kind=static" in text
    assert "kind=static" in [ln for ln in text.splitlines() if "auth failure" in ln][0]
    assert LONG_KEY not in text


def test_ws_middleware_hands_the_subprotocol_credential_to_routes_as_a_bearer():
    """Routes resolve the user with ``_bearer(ws.headers)`` (maps, alerts,
    collab); the middleware must put the ``key.`` credential there, never over
    a header the client really sent, and select only ``velocity.v1``."""
    seen: dict = {}

    async def _app(scope, receive, send):
        seen["headers"] = dict(scope["headers"])
        await send({"type": "websocket.accept"})

    sent: list[dict] = []

    async def _send(message):
        sent.append(message)

    def _scope(extra: list[tuple[bytes, bytes]]):
        return {
            "type": "websocket",
            "subprotocols": ["velocity.v1", "key.tok-123"],
            "headers": [(b"sec-websocket-protocol", b"velocity.v1, key.tok-123"), *extra],
        }

    mw = auth.WsSubprotocolMiddleware(_app)
    asyncio.run(mw(_scope([]), None, _send))
    assert seen["headers"][b"authorization"] == b"Bearer tok-123"
    assert sent == [{"type": "websocket.accept", "subprotocol": "velocity.v1"}]
    asyncio.run(mw(_scope([(b"x-api-key", b"real")]), None, _send))
    assert b"authorization" not in seen["headers"]
