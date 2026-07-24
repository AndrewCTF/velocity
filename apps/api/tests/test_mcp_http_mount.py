"""The MCP server is mounted into the FastAPI app at /mcp (streamable-HTTP).

Proves the hosted endpoint works end-to-end through the real ASGI stack
(CORS + ApiKeyMiddleware + SelectiveGZip): a full initialize -> tools/list
handshake returns every registered tool, the endpoint is auth-gated, it fails
CLOSED when no credential is configured, and the SSE standby GET stream's
headers arrive promptly (the GZip-buffering regression).
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import auth
from app.config import get_settings
from app.main import create_app

_KEY = "s3cret"
_HEADERS = {
    "accept": "application/json, text/event-stream",
    "content-type": "application/json",
}
_AUTH = {**_HEADERS, "x-api-key": _KEY}


def _init_body() -> dict:
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "pytest", "version": "1"},
        },
    }


def _messages(resp) -> list[dict]:  # type: ignore[no-untyped-def]
    """JSON-RPC messages from a streamable-HTTP response (SSE or plain JSON)."""
    if "text/event-stream" in resp.headers.get("content-type", ""):
        out: list[dict] = []
        for line in resp.text.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                try:
                    out.append(json.loads(line[5:].strip()))
                except ValueError:
                    pass
        return out
    try:
        body = resp.json()
    except ValueError:
        return []
    return body if isinstance(body, list) else [body]


@pytest.fixture
def keyed(monkeypatch: pytest.MonkeyPatch) -> str:
    """Configure a static API_KEY so auth is enabled (the hosted posture)."""
    monkeypatch.setenv("API_KEY", _KEY)
    get_settings.cache_clear()
    try:
        yield _KEY
    finally:
        monkeypatch.delenv("API_KEY", raising=False)
        get_settings.cache_clear()


def test_mcp_http_handshake_lists_all_tools(keyed: str) -> None:
    app = create_app()
    with TestClient(app) as c:
        r = c.post("/mcp", json=_init_body(), headers=_AUTH)
        assert r.status_code == 200, r.text
        sid = r.headers.get("mcp-session-id")
        assert sid, "stateful streamable-HTTP must return an Mcp-Session-Id"
        init = next(m for m in _messages(r) if m.get("id") == 1)
        assert init["result"]["serverInfo"]["name"] == "osint-geoint"

        c.post(
            "/mcp",
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            headers={**_AUTH, "mcp-session-id": sid},
        )
        r2 = c.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            headers={**_AUTH, "mcp-session-id": sid},
        )
        assert r2.status_code == 200, r2.text
        listing = next(m for m in _messages(r2) if m.get("id") == 2)
        names = {t["name"] for t in listing["result"]["tools"]}
        # The README/landing advertise this count; keep it in lock-step so a
        # tool added/removed without updating the marketing copy trips a test.
        # 22 core + 12 keyless-feed tools (2026-07-14 data-layers wave)
        # + news_brief (2026-07-21 news wave)
        # + travel_advisories/displacement/nas_status/climate_anomalies/
        #   markets_snapshot/market_stress (2026-07-21 context+markets wave)
        # + quakes_near/track_history/create_watch_rule/list_watch_rules/
        #   delete_watch_rule (2026-07-24 REST-parity wave).
        assert len(names) == 46, sorted(names)
        assert {"get_situation", "intel_brief", "query_aircraft", "deep_analyze"} <= names
        assert {"disaster_alerts", "maritime_chokepoints", "space_weather"} <= names
        assert {
            "quakes_near", "track_history",
            "create_watch_rule", "list_watch_rules", "delete_watch_rule",
        } <= names


def test_mcp_endpoint_rejects_without_token(keyed: str) -> None:
    app = create_app()
    with TestClient(app) as c:
        denied = c.post("/mcp", json=_init_body(), headers=_HEADERS)
        assert denied.status_code == 401, denied.text


def test_mcp_fails_closed_when_auth_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    # The backend origin is publicly resolvable; /mcp must refuse (503), not
    # serve all tools open, when no credential source is configured.
    monkeypatch.setattr(auth, "_auth_enabled", lambda s: False)
    app = create_app()
    with TestClient(app) as c:
        r = c.post("/mcp", json=_init_body(), headers=_HEADERS)
        assert r.status_code == 503, r.text


def test_selective_gzip_skips_mcp_compresses_others() -> None:
    # Regression: GZipMiddleware buffered the SSE response start until the first
    # body chunk, hanging the MCP standby GET stream (POST hid it). /mcp must
    # bypass gzip entirely. Drive the middleware directly so the assertion is
    # deterministic (no long-lived stream to hang the test): a large JSON body
    # is gzipped on a normal path and left untouched on /mcp.
    import asyncio

    from app.main import SelectiveGZipMiddleware

    big = b'{"x":"' + b"a" * 5000 + b'"}'

    async def inner(scope, receive, send):  # type: ignore[no-untyped-def]
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": big})

    mw = SelectiveGZipMiddleware(inner, minimum_size=1024, compresslevel=5)

    async def content_encoding(path: str) -> bytes | None:
        msgs: list[dict] = []

        async def send(m):  # type: ignore[no-untyped-def]
            msgs.append(m)

        async def receive():  # type: ignore[no-untyped-def]
            return {"type": "http.request", "body": b"", "more_body": False}

        await mw(
            {
                "type": "http",
                "method": "GET",
                "path": path,
                "headers": [(b"accept-encoding", b"gzip")],
            },
            receive,
            send,
        )
        start = next(m for m in msgs if m["type"] == "http.response.start")
        return dict(start["headers"]).get(b"content-encoding")

    assert asyncio.run(content_encoding("/api/intel/situation")) == b"gzip"
    assert asyncio.run(content_encoding("/mcp")) is None
