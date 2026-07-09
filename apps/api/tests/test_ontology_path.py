"""Ontology path-finding (C4) — pure BFS units + route wiring (hermetic).

Covers ``path_between`` (the shortest UNDIRECTED chain between two objects,
implemented once in the ``_GraphWalk`` mixin) over the real SQLite registry on
a per-test temp DB, the upsert + path routes' keyless-local contract and 422
validation, and the derived-stub behaviour for unpersisted path nodes — all
without any network (mirrors test_ontology.py).
"""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from app.config import Settings
from app.intel.ontology import Link, Object
from app.intel.ontology_local import SqliteRegistry
from app.keys import UserCtx


def _link(src: str, dst: str, rel: str = "correlated") -> dict:
    return {"src": src, "dst": dst, "rel": rel}


def _reg(objects: dict[str, dict], links: list[dict]) -> SqliteRegistry:
    """A local registry seeded with the given persisted objects + links.

    (The BFS matrix predates the SQLite backend — it originally ran against a
    mocked PostgREST. Seeding the real local store keeps every assertion
    identical while exercising the shipping storage layer.)
    """
    reg = SqliteRegistry(UserCtx("u1", ""), Settings(supabase_url=""))

    async def seed() -> None:
        for row in objects.values():
            await reg.upsert(
                Object(
                    id=row["id"],
                    kind=row.get("kind", "object"),
                    props=row.get("props", {}),
                )
            )
        for lk in links:
            await reg.link(Link(src=lk["src"], dst=lk["dst"], rel=lk["rel"]))

    asyncio.run(seed())
    return reg


# ── pure BFS path-finding ───────────────────────────────────────────────────────


def test_path_self_is_zero_hop() -> None:
    reg = _reg({"aircraft:a": {"id": "aircraft:a", "kind": "aircraft", "props": {}}}, [])
    res = asyncio.run(reg.path_between("aircraft:a", "aircraft:a"))
    assert res.found is True
    assert res.hops == 0
    assert res.path == ["aircraft:a"]
    assert {o.id for o in res.objects} == {"aircraft:a"}
    assert res.links == []


def test_path_multi_hop_shortest() -> None:
    # a -> i -> v is the only chain (2 hops). BFS must find it in order.
    objects = {
        "incident:i": {"id": "incident:i", "kind": "incident", "props": {"sev": 4}},
    }
    links = [_link("aircraft:a", "incident:i", "evidence_of"), _link("incident:i", "vessel:v", "correlated")]
    reg = _reg(objects, links)
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


def test_path_is_undirected() -> None:
    # Edge stored a -> i only; asking i -> a must still find it (undirected walk).
    links = [_link("aircraft:a", "incident:i", "evidence_of")]
    reg = _reg({}, links)
    res = asyncio.run(reg.path_between("incident:i", "aircraft:a"))
    assert res.found is True
    assert res.path == ["incident:i", "aircraft:a"]
    assert res.hops == 1


def test_path_prefers_shorter_of_two_routes() -> None:
    # Two routes a→b: direct (1 hop) and via m (2 hops). BFS returns the 1-hop one.
    links = [
        _link("aircraft:a", "vessel:b"),
        _link("aircraft:a", "incident:m"),
        _link("incident:m", "vessel:b"),
    ]
    reg = _reg({}, links)
    res = asyncio.run(reg.path_between("aircraft:a", "vessel:b"))
    assert res.found is True
    assert res.hops == 1
    assert res.path == ["aircraft:a", "vessel:b"]


def test_path_unreachable_within_budget() -> None:
    # a—i and v—w are two disconnected components: no chain a↔v.
    links = [_link("aircraft:a", "incident:i"), _link("vessel:v", "vessel:w")]
    reg = _reg({}, links)
    res = asyncio.run(reg.path_between("aircraft:a", "vessel:v"))
    assert res.found is False
    assert res.path == []
    assert res.objects == []
    assert res.links == []


def test_path_respects_max_depth() -> None:
    # Chain of length 3 (a-1-2-b); max_depth=2 can't reach b, max_depth=3 can.
    links = [
        _link("aircraft:a", "object:1"),
        _link("object:1", "object:2"),
        _link("object:2", "vessel:b"),
    ]
    reg = _reg({}, links)
    short = asyncio.run(reg.path_between("aircraft:a", "vessel:b", max_depth=2))
    assert short.found is False
    full = asyncio.run(reg.path_between("aircraft:a", "vessel:b", max_depth=3))
    assert full.found is True
    assert full.hops == 3


def test_path_max_depth_is_clamped() -> None:
    # max_depth=99 is clamped to the 1..6 ceiling; an unreachable target over an
    # empty store just reports found=False (and never fans out unbounded).
    reg = _reg({}, [])
    res = asyncio.run(reg.path_between("aircraft:a", "vessel:b", max_depth=99))
    assert res.found is False


# ── route wiring ─────────────────────────────────────────────────────────────────
# 2026-07-07: keyless boots are served by the LOCAL SQLite store (deliberate
# revoke of the old 401/503 contract — docs/decisions.md), so route wiring is
# exercised directly with no auth override.


def test_path_route_validates_max_depth(client: TestClient) -> None:
    # max_depth=9 is outside Query(ge=1, le=6) → 422 before any store call.
    r = client.get("/api/ontology/path?a=aircraft:a&b=vessel:b&max_depth=9")
    assert r.status_code == 422


def test_path_route_requires_both_ends(client: TestClient) -> None:
    # `b` missing → 422 (Query(...) is required).
    assert client.get("/api/ontology/path?a=aircraft:a").status_code == 422


def test_path_route_local_when_keyless(client: TestClient) -> None:
    # No Supabase → the local store answers: two unconnected ids are an honest
    # found=False, not a dead 401/503.
    r = client.get("/api/ontology/path?a=aircraft:a&b=vessel:b")
    assert r.status_code == 200
    assert r.json()["found"] is False


def test_upsert_object_local_when_keyless(client: TestClient) -> None:
    r = client.post("/api/ontology/object", json={"id": "investigation:x"})
    assert r.status_code == 200
    assert r.json()["id"] == "investigation:x"
