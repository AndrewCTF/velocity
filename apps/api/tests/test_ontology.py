"""Ontology spine — pure-logic units + route wiring (hermetic, no live Supabase).

Covers: canonical-id → kind mapping, Object normalisation, the route auth gate +
503-when-unconfigured contract, and a traverse over a mocked PostgREST so the
breadth-first walk + derived-stub behaviour is exercised without a network.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.intel import ontology as ont
from app.intel.ontology import Object, OntologyRegistry, kind_of
from app.keys import UserCtx, current_user

# ── pure logic: kind_of + normalisation ───────────────────────────────────────


def test_kind_of_known_prefixes() -> None:
    assert kind_of("aircraft:4ca7b3") == "aircraft"
    assert kind_of("vessel:636092000") == "vessel"
    assert kind_of("incident:8f1c-uuid") == "incident"
    assert kind_of("sim:uav-12") == "sim"


def test_kind_of_unknown_is_object() -> None:
    assert kind_of("widget:1") == "object"
    assert kind_of("noprefix") == "object"
    assert kind_of("") == "object"


def test_object_normalised_fixes_kind_from_id() -> None:
    # Caller left kind at the default; it should be reconciled to the id prefix.
    obj = Object(id="aircraft:abc").normalised()
    assert obj.kind == "aircraft"
    # An explicit wrong kind on a known prefix is corrected to the prefix.
    obj2 = Object(id="vessel:123", kind="aircraft").normalised()
    assert obj2.kind == "vessel"
    # Unknown prefix stays object.
    obj3 = Object(id="thing:1").normalised()
    assert obj3.kind == "object"


# ── route auth + 503 contract ─────────────────────────────────────────────────


def test_object_route_requires_auth(client: TestClient) -> None:
    assert client.get("/api/ontology/object/aircraft:abc").status_code == 401


def test_search_around_requires_auth(client: TestClient) -> None:
    assert client.get("/api/ontology/search-around/aircraft:abc").status_code == 401


def _fake_user() -> UserCtx:
    return UserCtx("u1", "tok")


def test_object_503_when_supabase_unconfigured(client: TestClient) -> None:
    # The test Settings carry no supabase_url, so _objects_url() raises 503 — the
    # same store-not-configured contract targets.py / alert_rules expose.
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        assert client.get("/api/ontology/object/aircraft:abc").status_code == 503
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_search_around_clamps_depth(client: TestClient) -> None:
    # depth=9 is out of the Query(ge=1, le=3) bound → 422 (validation), proving
    # the bound is enforced at the route before any store call.
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        r = client.get("/api/ontology/search-around/aircraft:abc?depth=9")
        assert r.status_code == 422
    finally:
        client.app.dependency_overrides.pop(current_user, None)


# ── traverse over a mocked PostgREST ───────────────────────────────────────────


class _FakeResp:
    def __init__(self, status: int, payload: object) -> None:
        self.status_code = status
        self._payload = payload

    def json(self) -> object:
        return self._payload


class _GraphClient:
    """Minimal PostgREST stand-in backed by an in-memory object + link store.

    Routes GETs by the URL the registry builds (`/objects` vs `/links`) and the
    params it passes, so we can assert traverse's breadth-first behaviour.
    """

    def __init__(self, objects: dict[str, dict], links: list[dict]) -> None:
        self._objects = objects
        self._links = links

    async def __aenter__(self) -> _GraphClient:
        return self

    async def __aexit__(self, *a: object) -> bool:
        return False

    async def get(self, url: str, params: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        if url.endswith("/objects"):
            oid = params.get("id", "").removeprefix("eq.")
            row = self._objects.get(oid)
            return _FakeResp(200, [row] if row else [])
        # links: match the `in.(...)` filter on src or dst
        col = "src" if "src" in params else "dst"
        raw = params.get(col, "")
        inner = raw[raw.find("(") + 1 : raw.rfind(")")] if "(" in raw else ""
        wanted = {v.strip().strip('"') for v in inner.split(",") if v.strip()}
        hits = [lk for lk in self._links if lk[col] in wanted]
        return _FakeResp(200, hits)


def test_traverse_walks_links_and_derives_stubs(monkeypatch: pytest.MonkeyPatch) -> None:
    # aircraft:a --evidence_of--> incident:i ; incident:i is persisted, the
    # aircraft is NOT (so it must come back as a derived stub). depth=1 reaches i.
    objects = {
        "incident:i": {"id": "incident:i", "kind": "incident", "props": {"sev": 4}},
    }
    links = [
        {"id": "l1", "src": "aircraft:a", "dst": "incident:i", "rel": "evidence_of", "props": {}}
    ]
    monkeypatch.setattr(ont, "_client", lambda: _GraphClient(objects, links))

    reg = OntologyRegistry(UserCtx("u1", "tok"), Settings(supabase_url="http://x"))
    result = asyncio.run(reg.traverse("aircraft:a", depth=1))

    ids = {o.id for o in result.objects}
    assert ids == {"aircraft:a", "incident:i"}
    # center was unpersisted → derived stub with kind from prefix
    center = next(o for o in result.objects if o.id == "aircraft:a")
    assert center.kind == "aircraft"
    # persisted neighbour carries its stored props + kind
    neighbour = next(o for o in result.objects if o.id == "incident:i")
    assert neighbour.kind == "incident"
    assert neighbour.props == {"sev": 4}
    # the edge is present
    assert len(result.links) == 1
    assert result.links[0].rel == "evidence_of"
    assert result.depth == 1


def test_traverse_depth_is_clamped(monkeypatch: pytest.MonkeyPatch) -> None:
    # traverse clamps depth to 1..3 before walking. An empty store + depth=99
    # must report depth 3, not 99.
    monkeypatch.setattr(ont, "_client", lambda: _GraphClient({}, []))
    reg = OntologyRegistry(UserCtx("u1", "tok"), Settings(supabase_url="http://x"))
    res = asyncio.run(reg.traverse("aircraft:a", depth=99))
    assert res.depth == 3
