"""Ontology spine — pure-logic units + route wiring (hermetic, local store).

Covers: canonical-id → kind mapping, Object normalisation, the keyless-local
route contract (2026-07-07 revoke of the old 401/503 contract — see
docs/decisions.md), the ``current_user_or_local`` auth fallback, and traverse
over the real SQLite registry so the breadth-first walk + derived-stub
behaviour is exercised without a network.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.config import Settings
from app.intel.ontology import Link, Object, kind_of
from app.intel.ontology_local import SqliteRegistry
from app.keys import UserCtx

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


# ── route contract: keyless boots are served by the LOCAL store ───────────────
# 2026-07-07 deliberate revoke (docs/decisions.md): these routes used to 401
# (no Supabase user) / 503 (store unconfigured). The roadmap's Phase-1
# acceptance is the opposite — every /api/ontology/* route returns data with
# no Supabase configured, backed by SQLite.


def test_object_route_local_404_when_keyless(client: TestClient) -> None:
    # No Supabase → the shared "local" identity + SQLite store: an unknown id
    # is an honest 404 (the route WORKS), not a dead 401/503.
    assert client.get("/api/ontology/object/aircraft:abc").status_code == 404


def test_search_around_local_when_keyless(client: TestClient) -> None:
    r = client.get("/api/ontology/search-around/aircraft:abc")
    assert r.status_code == 200
    assert r.json()["center"] == "aircraft:abc"


def _bare_request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [],
            "query_string": b"",
        }
    )


def test_current_user_or_local_grants_local_identity_keyless(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app import keys

    monkeypatch.setattr(keys, "get_settings", lambda: Settings(supabase_url=""))
    ctx = asyncio.run(keys.current_user_or_local(_bare_request()))
    assert ctx.user_id == "local" and ctx.token == ""


def test_current_user_or_local_still_401s_when_supabase_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # With Supabase configured the fallback is exactly current_user — an
    # unauthenticated request stays a 401 (prod behavior unchanged).
    from app import keys

    monkeypatch.setattr(
        keys,
        "get_settings",
        lambda: Settings(supabase_url="http://x", supabase_anon_key="k"),
    )
    with pytest.raises(HTTPException) as ei:
        asyncio.run(keys.current_user_or_local(_bare_request()))
    assert ei.value.status_code == 401


def test_search_around_clamps_depth(client: TestClient) -> None:
    # depth=9 is out of the Query(ge=1, le=3) bound → 422 (validation), proving
    # the bound is enforced at the route before any store call.
    r = client.get("/api/ontology/search-around/aircraft:abc?depth=9")
    assert r.status_code == 422


# ── traverse over the local store ─────────────────────────────────────────────


def _seeded_reg(objects: dict[str, dict], links: list[dict]) -> SqliteRegistry:
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


def test_traverse_walks_links_and_derives_stubs() -> None:
    # aircraft:a --evidence_of--> incident:i ; incident:i is persisted, the
    # aircraft is NOT (so it must come back as a derived stub). depth=1 reaches i.
    objects = {
        "incident:i": {"id": "incident:i", "kind": "incident", "props": {"sev": 4}},
    }
    links = [{"src": "aircraft:a", "dst": "incident:i", "rel": "evidence_of"}]
    reg = _seeded_reg(objects, links)
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


def test_traverse_depth_is_clamped() -> None:
    # traverse clamps depth to 1..3 before walking. An empty store + depth=99
    # must report depth 3, not 99.
    reg = _seeded_reg({}, [])
    res = asyncio.run(reg.traverse("aircraft:a", depth=99))
    assert res.depth == 3
