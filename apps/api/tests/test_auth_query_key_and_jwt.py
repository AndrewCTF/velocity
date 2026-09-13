"""G8: ``?key=`` authenticates WebSocket upgrades only, never an HTTP request,
and the access log never records it. G9: HS256 sessions must carry
``aud=authenticated`` and must not be used before ``nbf``."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time

from fastapi.testclient import TestClient

from app import auth
from app.config import Settings
from app.main import create_app

_KEY = "static-test-key-123"


def _keyed(monkeypatch) -> TestClient:
    s = Settings(api_key=_KEY, supabase_url="", supabase_anon_key="", supabase_jwt_secret="")
    monkeypatch.setattr(auth, "get_settings", lambda: s)
    return TestClient(create_app())


def test_http_query_key_is_refused(monkeypatch) -> None:
    with _keyed(monkeypatch) as c:
        assert c.get(f"/api/alerts/deliveries?key={_KEY}").status_code == 401


def test_http_header_key_still_works(monkeypatch) -> None:
    with _keyed(monkeypatch) as c:
        assert c.get("/api/alerts/deliveries", headers={"X-API-Key": _KEY}).status_code == 200


def test_ws_query_key_still_works(monkeypatch) -> None:
    s = Settings(api_key=_KEY, supabase_url="", supabase_anon_key="", supabase_jwt_secret="")
    monkeypatch.setattr(auth, "get_settings", lambda: s)

    class _WS:
        headers: dict[str, str] = {}

        def __init__(self, q: dict[str, str]) -> None:
            self.query_params = q

    assert asyncio.run(auth.require_ws_key(_WS({"key": _KEY}))) is True  # type: ignore[arg-type]
    assert asyncio.run(auth.require_ws_key(_WS({"key": "wrong"}))) is False  # type: ignore[arg-type]


def test_access_log_redacts_key_query_value() -> None:
    rec = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:5", "GET", "/ws/adsb?map=a&key=s3cr3t.tok&x=1", "1.1", 101),
        None,
    )
    assert auth.RedactKeyFilter().filter(rec) is True
    msg = rec.getMessage()
    assert "s3cr3t" not in msg
    assert "key=[redacted]" in msg and "map=a" in msg and "x=1" in msg
    create_app()
    # uvicorn logs the WS handshake (the one path that carries ?key=) on
    # uvicorn.error, HTTP requests on uvicorn.access; filters do not inherit.
    for name in ("uvicorn.access", "uvicorn.error"):
        assert any(isinstance(f, auth.RedactKeyFilter)
                   for f in logging.getLogger(name).filters), name


# ── G9 ───────────────────────────────────────────────────────────────────────

_SECRET = "jwt-secret-for-tests"


def _b64(d: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()


def _tok(**claims: object) -> str:
    base = {"role": "authenticated", "aud": "authenticated", "sub": "u1",
            "exp": int(time.time()) + 600}
    base.update(claims)
    base = {k: v for k, v in base.items() if v is not None}
    head = _b64({"alg": "HS256", "typ": "JWT"})
    body = _b64(base)
    sig = hmac.new(_SECRET.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


def test_jwt_requires_authenticated_audience() -> None:
    assert auth._verify_hs256(_tok(), _SECRET) is True
    assert auth._verify_hs256(_tok(aud=["other", "authenticated"]), _SECRET) is True
    assert auth._verify_hs256(_tok(aud=None), _SECRET) is False
    assert auth._verify_hs256(_tok(aud="service"), _SECRET) is False
    assert auth._verify_hs256(_tok(aud=["service"]), _SECRET) is False


def test_jwt_rejects_future_nbf() -> None:
    assert auth._verify_hs256(_tok(nbf=int(time.time()) + 3600), _SECRET) is False
    assert auth._verify_hs256(_tok(nbf=int(time.time()) - 5), _SECRET) is True
