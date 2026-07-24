"""MCP wrappers for the REST fix wave that shipped with no MCP tool:
geo-filtered ``/api/eq``, identity-scoped ``/api/history/track``, and
per-identity watch-rule CRUD (``/api/alerts/rules``).

``quakes_near``/``track_history`` follow the same short/long shaping wiring
as every other tool (test_mcp_detail.py's pattern: monkeypatch ``M._get`` and
assert on the params it was called with + the shape passthrough). The
watch-rule tools additionally get a real create -> list -> delete round trip
against an in-process app (httpx ASGI transport over ``app.main.create_app()``
— no real socket, no server process, matching the "never start a server"
rule) so the POST/GET/DELETE wiring is proven against the actual keyless
local SQLite alert_rules store, not just a mock.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app import mcp_server as M
from app.main import create_app


@pytest.fixture(autouse=True)
def _no_autostart(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OSINT_MCP_NO_AUTOSTART", "1")
    M._BACKEND_READY = False
    M._BACKEND_PROC = None


# ── quakes_near ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_quakes_near_calls_eq_with_all_three_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    async def fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        captured["path"] = path
        captured["params"] = params
        return {"type": "FeatureCollection", "features": []}

    monkeypatch.setattr(M, "_get", fake_get)
    out = await M.quakes_near(35.68, 139.69, 500.0)
    assert captured["path"] == "/api/eq"
    assert captured["params"] == {
        "lat": 35.68, "lon": 139.69, "radius_km": 500.0, "range": "day",
    }
    assert out["type"] == "FeatureCollection"


@pytest.mark.asyncio
async def test_quakes_near_range_passthrough(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    async def fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        captured["params"] = params
        return {"features": []}

    monkeypatch.setattr(M, "_get", fake_get)
    await M.quakes_near(1.0, 2.0, 3.0, range="week")
    assert captured["params"]["range"] == "week"


@pytest.mark.asyncio
async def test_quakes_near_short_vs_long(monkeypatch: pytest.MonkeyPatch) -> None:
    big = {
        "type": "FeatureCollection",
        "features": [{"id": i, "properties": {"mag": i}} for i in range(30)],
    }

    async def fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        return big

    monkeypatch.setattr(M, "_get", fake_get)
    short = await M.quakes_near(0.0, 0.0, 100.0)
    assert len(short["features"]) < 30
    assert short["features_total"] == 30

    full = await M.quakes_near(0.0, 0.0, 100.0, detail="long")
    assert full is big
    assert len(full["features"]) == 30


@pytest.mark.asyncio
async def test_quakes_near_surfaces_422_as_structured_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The route 422s on a partial geo param set; the MCP layer's non-raising
    _get contract turns that into a structured error dict, never HTML/a
    crash. This tool's own signature requires lat/lon/radius_km (no
    defaults), so a well-behaved agent can't even construct a partial call —
    but the passthrough must still hold for a backend-side reject."""

    async def fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        return {"error": "backend_422", "detail": "lat, lon, and radius_km must be given together"}

    monkeypatch.setattr(M, "_get", fake_get)
    out = await M.quakes_near(1.0, 2.0, 3.0)
    assert out["error"] == "backend_422"
    assert "together" in out["detail"]


# ── track_history ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_track_history_calls_route_with_id_and_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    async def fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        captured["path"] = path
        captured["params"] = params
        return {"tracks": []}

    monkeypatch.setattr(M, "_get", fake_get)
    out = await M.track_history("aircraft:af351f", from_ts=100.0, to_ts=200.0)
    assert captured["path"] == "/api/history/track"
    assert captured["params"] == {"id": "aircraft:af351f", "from_ts": 100.0, "to_ts": 200.0}
    assert out == {"tracks": []}


@pytest.mark.asyncio
async def test_track_history_bare_id_default_window(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    async def fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        captured["params"] = params
        return {"tracks": []}

    monkeypatch.setattr(M, "_get", fake_get)
    await M.track_history("422000000")
    assert captured["params"]["id"] == "422000000"
    assert captured["params"]["from_ts"] is None
    assert captured["params"]["to_ts"] is None


@pytest.mark.asyncio
async def test_track_history_short_vs_long(monkeypatch: pytest.MonkeyPatch) -> None:
    big = {"tracks": [{"id": "aircraft:af351f", "points": list(range(60))}]}

    async def fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        return big

    monkeypatch.setattr(M, "_get", fake_get)
    short = await M.track_history("af351f")
    assert short["tracks"][0]["points_total"] == 60
    full = await M.track_history("af351f", detail="long")
    assert full is big


@pytest.mark.asyncio
async def test_track_history_surfaces_ambiguous_id_422(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        return {
            "error": "backend_422",
            "detail": "id 'not-a-real-id' has no 'kind:' prefix and kind= was not supplied",
        }

    monkeypatch.setattr(M, "_get", fake_get)
    out = await M.track_history("not-a-real-id")
    assert out["error"] == "backend_422"
    assert "kind" in out["detail"]


# ── watch-rule CRUD: unit (mocked _post/_delete wiring) ─────────────────────


@pytest.mark.asyncio
async def test_create_watch_rule_drops_none_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    async def fake_post(path: str, body: dict):  # type: ignore[no-untyped-def]
        captured["path"] = path
        captured["body"] = body
        return {"id": "abc123", "label": "test", "icao24": "ab1234"}

    monkeypatch.setattr(M, "_post", fake_post)
    out = await M.create_watch_rule(label="test", icao24="AB1234")
    assert captured["path"] == "/api/alerts/rules"
    # identity-only rule: no AOI fields required in the call, all still passed
    # through (None-stripping happens inside _post, not the tool wrapper).
    assert captured["body"]["label"] == "test"
    assert captured["body"]["icao24"] == "AB1234"
    assert captured["body"]["lat"] is None and captured["body"]["radius_nm"] is None
    assert out["id"] == "abc123"


@pytest.mark.asyncio
async def test_delete_watch_rule_quotes_id(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    async def fake_delete(path: str):  # type: ignore[no-untyped-def]
        captured["path"] = path
        return {"ok": True}

    monkeypatch.setattr(M, "_delete", fake_delete)
    out = await M.delete_watch_rule("rule/../123")
    assert captured["path"] == "/api/alerts/rules/rule%2F..%2F123"
    assert out == {"ok": True}


@pytest.mark.asyncio
async def test_post_and_delete_report_structured_error_on_unreachable_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("API_BASE", "http://127.0.0.1:9")  # discard port
    out = await M._post("/api/alerts/rules", {"label": "x"})
    assert out["error"] == "backend_unreachable"
    out2 = await M._delete("/api/alerts/rules/x")
    assert out2["error"] == "backend_unreachable"


# ── watch-rule CRUD: real round trip against the app ─────────────────────


@pytest.mark.asyncio
async def test_watch_rule_create_list_delete_round_trip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end through the real keyless local SQLite alert_rules store
    (routes/alert_rules.py), driven entirely in-process: httpx's ASGI
    transport calls app.main.create_app() directly, so there is no real
    socket/server and nothing to start or kill."""
    app = create_app()

    class _InProcessClient(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs["transport"] = httpx.ASGITransport(app=app)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(M.httpx, "AsyncClient", _InProcessClient)
    M._BACKEND_READY = True  # this in-process app IS the backend; skip the health probe

    with TestClient(app):
        created = await M.create_watch_rule(label="mcp round trip", icao24="AB1234")
        assert "error" not in created, created
        assert created["label"] == "mcp round trip"
        assert created["icao24"] == "ab1234"  # route lower-normalizes identity fields
        rule_id = created["id"]

        listing = await M.list_watch_rules()
        assert "error" not in listing, listing
        rules = listing.get("rules", listing.get("result", listing))
        assert any(r["id"] == rule_id for r in rules)

        deleted = await M.delete_watch_rule(rule_id)
        assert deleted == {"ok": True}

        listing2 = await M.list_watch_rules()
        rules2 = listing2.get("rules", listing2.get("result", listing2))
        assert not any(r["id"] == rule_id for r in rules2)


@pytest.mark.asyncio
async def test_create_watch_rule_no_gate_returns_structured_422(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No identity pin and no AOI is a real validation failure the route
    422s on — the wrapper must surface it as structured JSON, not raise."""
    app = create_app()

    class _InProcessClient(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs["transport"] = httpx.ASGITransport(app=app)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(M.httpx, "AsyncClient", _InProcessClient)
    M._BACKEND_READY = True

    with TestClient(app):
        out = await M.create_watch_rule(label="no gate at all")
        assert out["error"] == "backend_422"
        assert "identity pin" in out["detail"] or "AOI" in out["detail"]
