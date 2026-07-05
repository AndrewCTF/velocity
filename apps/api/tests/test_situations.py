"""Situations — Gotham aggregate object over a mocked PostgREST + the events lane.

Hermetic (no live Supabase / network). Covers:
- Object coercion round-trips (a situation is a `situation:` ontology object,
  semantic kind in props.kind).
- Route auth gate (401) + 503-when-Supabase-unconfigured contract.
- Namespace defence (a non-`situation:` id is rejected 400).
- create → link child → get-detail folding (the NEW logic vs maps: the /link
  write + traverse-folded neighbourhood) over an in-memory objects+links stand-in.
- The /api/timeline/events lane shaping (public route, two discrete lanes).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.intel.ontology import Object
from app.keys import UserCtx, current_user
from app.routes import situations as sit_mod
from app.routes.situations import SituationIn, _from_object, _to_object

# ── pure coercion ─────────────────────────────────────────────────────────────


def test_to_object_carries_situation_kind_in_props() -> None:
    body = SituationIn(
        name="South China Sea",
        severity="high",
        status="active",
        centroid={"lat": 20.0, "lon": 115.0},
        radius_km=300,
        summary="PLA exercise growing in scope.",
    )
    obj = _to_object("situation:abc123", body, "2026-06-22T00:00:00Z")
    assert obj.kind == "object"  # structural kind stays catch-all
    assert obj.props["kind"] == "situation"
    assert obj.props["name"] == "South China Sea"
    assert obj.props["severity"] == "high"
    assert obj.props["centroid"] == {"lat": 20.0, "lon": 115.0}


def test_round_trip_object_to_situation() -> None:
    body = SituationIn(name="Hormuz", severity="critical", centroid={"lat": 26.5, "lon": 56.3})
    obj = _to_object("situation:h1", body, "2026-06-22T00:00:00Z")
    obj.created_at = "2026-06-21T00:00:00Z"
    sit = _from_object(obj)
    assert sit is not None
    assert sit.id == "situation:h1" and sit.name == "Hormuz"
    assert sit.severity == "critical"
    assert sit.centroid is not None and sit.centroid.lat == 26.5
    assert sit.created_at == "2026-06-21T00:00:00Z"


def test_from_object_skips_non_situation_and_clamps_bad_enum() -> None:
    assert _from_object(Object(id="aircraft:abc", props={})) is None
    # A situation row with a junk severity falls back to a safe default (never 500).
    sit = _from_object(Object(id="situation:x", props={"kind": "situation", "severity": "bogus"}))
    assert sit is not None and sit.severity == "med" and sit.status == "active"


# ── auth + 503 contract ─────────────────────────────────────────────────────────


def test_situation_routes_require_auth(client: TestClient) -> None:
    assert client.get("/api/situations").status_code == 401
    assert client.post("/api/situations", json={"name": "x"}).status_code == 401
    assert client.get("/api/situations/situation:abc").status_code == 401


def _fake_user() -> UserCtx:
    return UserCtx("u1", "tok")


def test_list_503_when_supabase_unconfigured(client: TestClient) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        assert client.get("/api/situations").status_code == 503
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_create_rejects_foreign_namespace(client: TestClient) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        r = client.post("/api/situations", json={"name": "x", "id": "aircraft:pwn"})
        assert r.status_code == 400
    finally:
        client.app.dependency_overrides.pop(current_user, None)


# ── create → link → detail over an in-memory objects+links PostgREST stand-in ────


class _FakeResp:
    def __init__(self, status: int, payload: object) -> None:
        self.status_code = status
        self._payload = payload

    def json(self) -> object:
        return self._payload


class _Store:
    """In-memory objects + links tables — enough to exercise upsert/get/list/link
    and the traverse the detail route folds in."""

    OBJ: dict[tuple[str, str], dict] = {}
    LINKS: list[dict] = []

    async def __aenter__(self) -> _Store:
        return self

    async def __aexit__(self, *a: object) -> bool:
        return False

    async def post(self, url: str, json: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        if url.endswith("/links"):
            type(self).LINKS.append({**json, "created_at": "2026-06-22T00:00:00Z"})
            return _FakeResp(201, [type(self).LINKS[-1]])
        key = (json["user_id"], json["id"])
        row = {**json, "created_at": "2026-06-22T00:00:00Z"}
        type(self).OBJ[key] = row
        return _FakeResp(201, [row])

    async def get(self, url: str, params: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        uid = params.get("user_id", "").removeprefix("eq.")
        if url.endswith("/links"):
            rows = []
            for col in ("src", "dst"):
                f = params.get(col)
                if f and f.startswith("in."):
                    inside = f[len("in.(") : -1]
                    ids = {v.strip('"') for v in inside.split(",")}
                    rows += [lk for lk in type(self).LINKS if lk.get(col) in ids and lk["user_id"] == uid]
            return _FakeResp(200, rows)
        if "id" in params:
            oid = params["id"].removeprefix("eq.")
            row = type(self).OBJ.get((uid, oid))
            return _FakeResp(200, [row] if row else [])
        rows = [r for (u, _), r in type(self).OBJ.items() if u == uid and (r.get("props") or {}).get("kind") == "situation"]
        return _FakeResp(200, rows)

    async def delete(self, url: str, params: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        return _FakeResp(204, None)


def _supa_settings() -> Settings:
    return Settings(supabase_url="http://x", supabase_anon_key="anon")


def test_create_link_detail_round_trip(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _Store.OBJ.clear()
    _Store.LINKS.clear()
    from app.intel import ontology as ont

    monkeypatch.setattr(ont, "_client", lambda: _Store())
    monkeypatch.setattr(ont, "get_settings", _supa_settings)
    monkeypatch.setattr(sit_mod, "get_settings", _supa_settings)
    monkeypatch.setattr(sit_mod, "_client", lambda: _Store())
    client.app.dependency_overrides[current_user] = _fake_user
    client.app.dependency_overrides[get_settings] = _supa_settings
    try:
        r = client.post("/api/situations", json={"name": "SCS", "severity": "high"})
        assert r.status_code == 201, r.text
        sid = r.json()["id"]
        assert sid.startswith("situation:")

        # LINK an incident as a child.
        r = client.post(f"/api/situations/{sid}/link", json={"dst": "incident:xyz", "rel": "contains"})
        assert r.status_code == 200, r.text

        # DETAIL folds the child in (derived stub) + the contains edge.
        r = client.get(f"/api/situations/{sid}")
        assert r.status_code == 200, r.text
        detail = r.json()
        assert detail["situation"]["name"] == "SCS"
        child_ids = [o["id"] for o in detail["objects"]]
        assert "incident:xyz" in child_ids
        assert any(lk["rel"] == "contains" and lk["dst"] == "incident:xyz" for lk in detail["links"])

        # LIST shows the situation.
        assert sid in [s["id"] for s in client.get("/api/situations").json()]
    finally:
        client.app.dependency_overrides.pop(current_user, None)
        client.app.dependency_overrides.pop(get_settings, None)


# ── timeline events lanes (public route) ──────────────────────────────────────


def test_timeline_events_returns_two_lanes(client: TestClient) -> None:
    r = client.get("/api/timeline/events")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "window" in body and "from" in body["window"]
    lane_ids = {ln["id"] for ln in body["lanes"]}
    assert lane_ids == {"incidents", "signals"}
    for ln in body["lanes"]:
        assert "color" in ln and isinstance(ln["events"], list)
