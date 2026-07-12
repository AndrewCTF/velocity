"""Guard: the ontology works on a keyless boot, with provenance (Phase 1).

The roadmap acceptance (docs/roadmap-ontology-2026-07.md §Phase 1): every
/api/ontology/* route returns data with NO Supabase configured, and the local
store records properties as evidenced assertions — two assertions from two
sources coexist with distinct provenance. A failure here means the local spine
regressed to the remote-only 401/503 world the 2026-07-07 decision revoked.

All tests run against the real SqliteRegistry on a per-test temp DB (the
autouse ``_isolate_ontology_db`` fixture in conftest).
"""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from app.config import Settings
from app.intel.ontology import Link, Object, get_registry
from app.intel.ontology_local import SqliteRegistry
from app.keys import UserCtx

_S = Settings(supabase_url="")


def _reg(user: str = "local") -> SqliteRegistry:
    reg = get_registry(UserCtx(user, ""), _S)
    assert isinstance(reg, SqliteRegistry)  # keyless → local backend
    return reg


# ── THE roadmap guard: two sources, distinct provenance ───────────────────────


def test_two_assertions_from_two_sources_coexist() -> None:
    async def run() -> None:
        reg = _reg()
        await reg.upsert(Object(id="vessel:636092000", props={"flag": "LR"}))
        await reg.assert_props(
            "vessel:636092000", {"name": "KILO"}, source="feed:ais"
        )
        await reg.assert_props(
            "vessel:636092000",
            {"name": "KILO II"},
            source="analyst",
            confidence=0.8,
            derivation={"note": "renamed per port record"},
        )
        rows = await reg.get_assertions("vessel:636092000", prop="name")
        assert len(rows) == 2
        by_source = {a.source: a for a in rows}
        assert by_source["feed:ais"].value == "KILO"
        assert by_source["feed:ais"].confidence == 1.0
        assert by_source["analyst"].value == "KILO II"
        assert by_source["analyst"].confidence == 0.8
        assert by_source["analyst"].derivation == {
            "note": "renamed per port record"
        }
        assert all(a.observed_at for a in rows)
        # Materialized blob shows the latest write.
        obj = await reg.get("vessel:636092000")
        assert obj is not None and obj.props["name"] == "KILO II"

    asyncio.run(run())


def test_size_cap_prune_preserves_custody() -> None:
    """The soft byte-cap prune (_maybe_enforce_size_cap) must never delete
    prop='custody' rows — the evidence locker's append-only legal record — even
    though evidence is captured once and its custody rows carry the OLDEST
    observed_at, so an unguarded oldest-10% prune would drop them first. Mirrors
    the per-object cap exclusion proven by test_custody_survives_assertion_cap."""
    from app.intel import ontology_local as OL

    async def run() -> None:
        # max_bytes=1 forces the size check to always fire a drop.
        reg = SqliteRegistry(
            UserCtx("local", ""),
            Settings(supabase_url="", ontology_db_max_bytes=1),
        )
        oid = "evidence:sizecap"
        await reg.upsert(Object(id=oid, props={"kind": "evidence"}))
        for i in range(6):  # custody: oldest timestamps
            await reg.assert_props(
                oid, {"custody": {"n": i}}, source=f"custody:x{i}",
                observed_at="2000-01-01T00:00:00Z",
            )
        for i in range(40):  # newer noisy non-custody assertions
            await reg.assert_props(
                oid, {"noise": i}, source="feed",
                observed_at="2026-01-01T00:00:00Z",
            )
        assert len(await reg.get_assertions(oid, prop="custody", limit=100)) == 6

        OL._next_size_check = 0.0  # bypass the once-an-hour / 500-write gate
        con = OL._connect(reg.s)
        try:
            reg._maybe_enforce_size_cap(con)
        finally:
            con.close()

        assert len(await reg.get_assertions(oid, prop="custody", limit=100)) == 6
        assert len(await reg.get_assertions(oid, prop="noise", limit=100)) < 40

    asyncio.run(run())


# ── upsert semantics: wholesale blob + assertion diff ─────────────────────────


def test_upsert_roundtrips_blob_and_diffs_assertions() -> None:
    async def run() -> None:
        reg = _reg()
        await reg.upsert(
            Object(id="aircraft:abc", props={"callsign": "X1", "alt": 1000})
        )
        # Wholesale replace: alt removed, callsign changed.
        await reg.upsert(Object(id="aircraft:abc", props={"callsign": "X2"}))
        obj = await reg.get("aircraft:abc")
        assert obj is not None
        assert obj.props == {"callsign": "X2"}  # removal round-trips
        assert obj.kind == "aircraft"
        # History: X1, X2 for callsign; 1000 then a tombstone for alt.
        cs = await reg.get_assertions("aircraft:abc", prop="callsign")
        assert [a.value for a in cs] == ["X2", "X1"]  # newest first
        alt = await reg.get_assertions("aircraft:abc", prop="alt")
        assert alt[0].value is None
        assert alt[0].derivation == {"op": "remove"}
        assert alt[1].value == 1000

    asyncio.run(run())


def test_identical_value_same_source_dedups() -> None:
    async def run() -> None:
        reg = _reg()
        for _ in range(3):
            await reg.assert_props("domain:x.com", {"ns": "a.dns"}, source="osint:whois")
        rows = await reg.get_assertions("domain:x.com", prop="ns")
        assert len(rows) == 1
        # …but a second SOURCE stating the same value is corroboration — kept.
        await reg.assert_props("domain:x.com", {"ns": "a.dns"}, source="analyst")
        rows = await reg.get_assertions("domain:x.com", prop="ns")
        assert len(rows) == 2

    asyncio.run(run())


def test_per_object_assertion_cap_keeps_newest() -> None:
    async def run() -> None:
        s = Settings(supabase_url="", ontology_max_assertions_per_object=5)
        reg = SqliteRegistry(UserCtx("local", ""), s)
        for i in range(10):
            await reg.assert_props(
                "aircraft:cap", {"alt": i}, source="feed:adsb"
            )
        rows = await reg.get_assertions("aircraft:cap")
        assert len(rows) == 5
        assert [a.value for a in rows] == [9, 8, 7, 6, 5]

    asyncio.run(run())


# ── links carry provenance; user scoping holds ────────────────────────────────


def test_link_provenance_roundtrip_and_user_scoping() -> None:
    async def run() -> None:
        reg = _reg("u1")
        await reg.upsert(Object(id="aircraft:a", props={}))
        lk = await reg.link(
            Link(
                src="aircraft:a",
                dst="incident:i",
                rel="evidence_of",
                source="detector:ais_gap",
                confidence=0.7,
            )
        )
        assert lk.source == "detector:ais_gap"
        assert lk.confidence == 0.7
        assert lk.observed_at is not None
        # u2 sees none of u1's graph.
        other = _reg("u2")
        assert await other.get("aircraft:a") is None
        sa = await other.traverse("aircraft:a")
        assert len(sa.links) == 0
        # u1's traverse walks the edge.
        sa1 = await reg.traverse("aircraft:a")
        assert {o.id for o in sa1.objects} == {"aircraft:a", "incident:i"}

    asyncio.run(run())


def test_delete_removes_object_history_and_edges() -> None:
    async def run() -> None:
        reg = _reg()
        await reg.upsert(Object(id="aircraft:del", props={"callsign": "D"}))
        await reg.link(Link(src="aircraft:del", dst="incident:i", rel="evidence_of"))
        await reg.delete("aircraft:del")
        assert await reg.get("aircraft:del") is None
        assert await reg.get_assertions("aircraft:del") == []
        assert await reg._links_touching(["aircraft:del"]) == []

    asyncio.run(run())


# ── the keyless ROUTE contract (acceptance) ───────────────────────────────────


def test_all_ontology_routes_serve_data_keyless(client: TestClient) -> None:
    # POST → GET round-trips the exact blob.
    r = client.post(
        "/api/ontology/object",
        json={"id": "investigation:x", "props": {"nodes": ["aircraft:a"], "n": 1}},
    )
    assert r.status_code == 200, r.text
    r = client.get("/api/ontology/object/investigation:x")
    assert r.status_code == 200
    assert r.json()["props"] == {"nodes": ["aircraft:a"], "n": 1}

    # Re-POST with a prop removed → removal visible (wholesale replace).
    client.post(
        "/api/ontology/object",
        json={"id": "investigation:x", "props": {"nodes": []}},
    )
    assert client.get("/api/ontology/object/investigation:x").json()["props"] == {
        "nodes": []
    }

    # search-around / analytics / path / assertions all answer.
    assert (
        client.get("/api/ontology/search-around/investigation:x").status_code
        == 200
    )
    assert client.get("/api/ontology/analytics/investigation:x").status_code == 200
    r = client.get("/api/ontology/path?a=investigation:x&b=aircraft:a")
    assert r.status_code == 200

    r = client.get("/api/ontology/assertions/investigation:x")
    assert r.status_code == 200
    body = r.json()
    assert any(a["prop"] == "nodes" for a in body)
    assert all(a["source"] for a in body)

    # prop filter narrows.
    r = client.get("/api/ontology/assertions/investigation:x?prop=n")
    assert {a["prop"] for a in r.json()} == {"n"}


# ── Move 1: the promotion endpoint (mint feed entities into the graph) ─────────


def test_promote_mints_object_with_server_stamped_source(client: TestClient) -> None:
    # A live aircraft the analyst flags → durable object with evidenced props,
    # on a keyless boot (the whole point: the graph is non-empty by decision).
    r = client.post(
        "/api/ontology/promote",
        json={
            "id": "aircraft:abc123",
            "props": {"callsign": "RCH1", "track_deg": 90},
            "trigger": "flag",
            # A forged source in the body must be IGNORED — the server owns it.
            "source": "feed:adsb",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "aircraft"

    # The object is now queryable, and the assertion trail records the SERVER
    # source (analyst:flag), not the forged body source.
    obj = client.get("/api/ontology/object/aircraft:abc123")
    assert obj.status_code == 200
    assert obj.json()["props"]["callsign"] == "RCH1"
    rows = client.get("/api/ontology/assertions/aircraft:abc123?prop=callsign").json()
    assert rows and rows[0]["source"] == "analyst:flag"
    assert rows[0]["confidence"] == 0.8  # honest about client-supplied values
    assert rows[0]["derivation"] == {"trigger": "flag"}


def test_promote_rejects_unknown_kind_prefix(client: TestClient) -> None:
    # A junk / prefix-less id can't mint a garbage-kinded stub.
    assert client.post("/api/ontology/promote", json={"id": "junk:1"}).status_code == 400
    assert client.post("/api/ontology/promote", json={"id": "noprefix"}).status_code == 400


def test_promote_empty_props_still_mints_existence(client: TestClient) -> None:
    # A situation-linked child (no props) still becomes a real row, not a stub.
    r = client.post(
        "/api/ontology/promote",
        json={"id": "incident:i1", "trigger": "situation"},
    )
    assert r.status_code == 200
    assert client.get("/api/ontology/object/incident:i1").status_code == 200
