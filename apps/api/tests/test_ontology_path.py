"""Ontology path-finding (C4) — pure BFS units + route wiring (hermetic).

Covers ``OntologyRegistry.path_between`` (the shortest UNDIRECTED chain between
two objects) over a mocked PostgREST, the upsert + path routes' auth gate and
503/422 contracts, and the derived-stub behaviour for unpersisted path nodes —
all without a live Supabase or any network (mirrors test_ontology.py).
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.intel import ontology as ont
from app.intel.ontology import OntologyRegistry
from app.keys import UserCtx, current_user

# ── mocked PostgREST (in-memory object + link store) ───────────────────────────
# Reuses the same shape as test_ontology.py's _GraphClient: routes GETs by the
# URL the registry builds (/objects vs /links) and the params it passes.


class _FakeResp:
    def __init__(self, status: int, payload: object) -> None:
        self.status_code = status
        self._payload = payload

    def json(self) -> object:
        return self._payload


class _GraphClient:
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
        # links: match the `in.(...)` filter on src or dst.
        col = "src" if "src" in params else "dst"
        raw = params.get(col, "")
        inner = raw[raw.find("(") + 1 : raw.rfind(")")] if "(" in raw else ""
        wanted = {v.strip().strip('"') for v in inner.split(",") if v.strip()}
        hits = [lk for lk in self._links if lk[col] in wanted]
        return _FakeResp(200, hits)


def _link(src: str, dst: str, rel: str = "correlated") -> dict:
    return {"id": f"{src}->{dst}", "src": src, "dst": dst, "rel": rel, "props": {}}


def _reg(objects: dict[str, dict], links: list[dict], monkeypatch: pytest.MonkeyPatch) -> OntologyRegistry:
    monkeypatch.setattr(ont, "_client", lambda: _GraphClient(objects, links))
    return OntologyRegistry(UserCtx("u1", "tok"), Settings(supabase_url="http://x"))


# ── pure BFS path-finding ───────────────────────────────────────────────────────


def test_path_self_is_zero_hop(monkeypatch: pytest.MonkeyPatch) -> None:
    reg = _reg({"aircraft:a": {"id": "aircraft:a", "kind": "aircraft", "props": {}}}, [], monkeypatch)
    res = asyncio.run(reg.path_between("aircraft:a", "aircraft:a"))
    assert res.found is True
    assert res.hops == 0
    assert res.path == ["aircraft:a"]
    assert {o.id for o in res.objects} == {"aircraft:a"}
    assert res.links == []


def test_path_multi_hop_shortest(monkeypatch: pytest.MonkeyPatch) -> None:
    # a -> i -> v is the only chain (2 hops). BFS must find it in order.
    objects = {
        "incident:i": {"id": "incident:i", "kind": "incident", "props": {"sev": 4}},
    }
    links = [_link("aircraft:a", "incident:i", "evidence_of"), _link("incident:i", "vessel:v", "correlated")]
    reg = _reg(objects, links, monkeypatch)
    res = asyncio.run(reg.path_between("aircraft:a", "vessel:v"))
    assert res.found is True
    assert res.hops == 2
    assert res.path == ["aircraft:a", "incident:i", "vessel:v"]
    # the chain carries exactly the two edges, in a→b order
    rels = [(lk.src, lk.dst) for lk in res.links]
    assert rels == [("aircraft:a", "incident:i"), ("incident:i", "vessel:v")]
    # unpersisted endpoints come back as derived stubs with kind from the prefix
    endpoints = {o.id: o.kind for o in res.objects}
    assert endpoints["aircraft:a"] == "aircraft"
    assert endpoints["vessel:v"] == "vessel"
    # the persisted middle node keeps its stored props
    mid = next(o for o in res.objects if o.id == "incident:i")
    assert mid.props == {"sev": 4}


def test_path_is_undirected(monkeypatch: pytest.MonkeyPatch) -> None:
    # Edge stored a -> i only; asking i -> a must still find it (undirected walk).
    links = [_link("aircraft:a", "incident:i", "evidence_of")]
    reg = _reg({}, links, monkeypatch)
    res = asyncio.run(reg.path_between("incident:i", "aircraft:a"))
    assert res.found is True
    assert res.path == ["incident:i", "aircraft:a"]
    assert res.hops == 1


def test_path_prefers_shorter_of_two_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    # Two routes a→b: direct (1 hop) and via m (2 hops). BFS returns the 1-hop one.
    links = [
        _link("aircraft:a", "vessel:b"),
        _link("aircraft:a", "incident:m"),
        _link("incident:m", "vessel:b"),
    ]
    reg = _reg({}, links, monkeypatch)
    res = asyncio.run(reg.path_between("aircraft:a", "vessel:b"))
    assert res.found is True
    assert res.hops == 1
    assert res.path == ["aircraft:a", "vessel:b"]


def test_path_unreachable_within_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    # a—i and v—w are two disconnected components: no chain a↔v.
    links = [_link("aircraft:a", "incident:i"), _link("vessel:v", "vessel:w")]
    reg = _reg({}, links, monkeypatch)
    res = asyncio.run(reg.path_between("aircraft:a", "vessel:v"))
    assert res.found is False
    assert res.path == []
    assert res.objects == []
    assert res.links == []


def test_path_respects_max_depth(monkeypatch: pytest.MonkeyPatch) -> None:
    # Chain of length 3 (a-1-2-b); max_depth=2 can't reach b, max_depth=3 can.
    links = [
        _link("aircraft:a", "object:1"),
        _link("object:1", "object:2"),
        _link("object:2", "vessel:b"),
    ]
    reg = _reg({}, links, monkeypatch)
    short = asyncio.run(reg.path_between("aircraft:a", "vessel:b", max_depth=2))
    assert short.found is False
    full = asyncio.run(reg.path_between("aircraft:a", "vessel:b", max_depth=3))
    assert full.found is True
    assert full.hops == 3


def test_path_max_depth_is_clamped(monkeypatch: pytest.MonkeyPatch) -> None:
    # max_depth=99 is clamped to the 1..6 ceiling; an unreachable target over an
    # empty store just reports found=False (and never fans out unbounded).
    reg = _reg({}, [], monkeypatch)
    res = asyncio.run(reg.path_between("aircraft:a", "vessel:b", max_depth=99))
    assert res.found is False


# ── route wiring ─────────────────────────────────────────────────────────────────


def _fake_user() -> UserCtx:
    return UserCtx("u1", "tok")


def test_path_route_requires_auth(client: TestClient) -> None:
    assert client.get("/api/ontology/path?a=aircraft:a&b=vessel:b").status_code == 401


def test_upsert_object_route_requires_auth(client: TestClient) -> None:
    r = client.post("/api/ontology/object", json={"id": "investigation:x"})
    assert r.status_code == 401


def test_path_route_validates_max_depth(client: TestClient) -> None:
    # max_depth=9 is outside Query(ge=1, le=6) → 422 before any store call.
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        r = client.get("/api/ontology/path?a=aircraft:a&b=vessel:b&max_depth=9")
        assert r.status_code == 422
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_path_route_requires_both_ends(client: TestClient) -> None:
    # `b` missing → 422 (Query(...) is required).
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        assert client.get("/api/ontology/path?a=aircraft:a").status_code == 422
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_path_route_503_when_supabase_unconfigured(client: TestClient) -> None:
    # The test Settings carry no supabase_url, so the registry raises 503 — the
    # same store-not-configured contract the rest of /api/ontology exposes.
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        r = client.get("/api/ontology/path?a=aircraft:a&b=vessel:b")
        assert r.status_code == 503
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_upsert_object_503_when_supabase_unconfigured(client: TestClient) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        r = client.post("/api/ontology/object", json={"id": "investigation:x"})
        assert r.status_code == 503
    finally:
        client.app.dependency_overrides.pop(current_user, None)
