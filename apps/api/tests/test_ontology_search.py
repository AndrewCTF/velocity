"""Guards for full-text search over the ontology (SqliteRegistry.search).

Before this the graph could only be reached by exact canonical id, so the
behaviour worth pinning is not "search works" but the three ways it silently
would not: the index drifting out of step with a write, hostile input reaching
FTS5 as syntax, and an existing deployment whose rows predate the index.
"""

from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.intel import ontology_local
from app.intel.ontology import Object, get_registry
from app.keys import UserCtx


@pytest.fixture
def reg(tmp_path):  # type: ignore[no-untyped-def]
    ontology_local.override_db_path(str(tmp_path / "ont.db"))
    try:
        yield get_registry(UserCtx(user_id="u1", token=None))
    finally:
        ontology_local.override_db_path(None)


async def _mint(reg, obj_id: str, props: dict) -> None:  # type: ignore[no-untyped-def]
    await reg.upsert(Object(id=obj_id, props=props))


@pytest.mark.anyio
async def test_finds_an_object_by_a_property_value(reg) -> None:  # type: ignore[no-untyped-def]
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "RYR1234"})
    hits = await reg.search("RYR1234")
    assert [o.id for o in hits] == ["aircraft:4ca7b3"]


@pytest.mark.anyio
async def test_finds_an_object_by_a_property_name(reg) -> None:  # type: ignore[no-untyped-def]
    """The Explorer facet case: which objects report a callsign at all."""
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "RYR1234"})
    await _mint(reg, "vessel:636092000", {"name": "EVER GIVEN"})
    assert [o.id for o in await reg.search("callsign")] == ["aircraft:4ca7b3"]


@pytest.mark.anyio
async def test_finds_an_object_by_its_id_without_the_prefix(reg) -> None:  # type: ignore[no-untyped-def]
    await _mint(reg, "vessel:636092000", {})
    assert [o.id for o in await reg.search("636092000")] == ["vessel:636092000"]


@pytest.mark.anyio
async def test_prefix_match(reg) -> None:  # type: ignore[no-untyped-def]
    await _mint(reg, "vessel:636092000", {"name": "EVER GIVEN"})
    assert [o.id for o in await reg.search("EVERG")] == []
    assert [o.id for o in await reg.search("EVER")] == ["vessel:636092000"]


@pytest.mark.anyio
async def test_nested_values_are_searchable(reg) -> None:  # type: ignore[no-untyped-def]
    await _mint(reg, "incident:abc", {"domains": ["maritime", "aviation"]})
    assert [o.id for o in await reg.search("maritime")] == ["incident:abc"]


@pytest.mark.anyio
async def test_kind_filter(reg) -> None:  # type: ignore[no-untyped-def]
    await _mint(reg, "aircraft:4ca7b3", {"name": "SHARED"})
    await _mint(reg, "vessel:636092000", {"name": "SHARED"})
    hits = await reg.search("SHARED", kinds=["vessel"])
    assert [o.id for o in hits] == ["vessel:636092000"]


@pytest.mark.anyio
async def test_index_follows_an_update(reg) -> None:  # type: ignore[no-untyped-def]
    """upsert replaces props wholesale, so the OLD value must stop matching."""
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "OLDCALL"})
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "NEWCALL"})
    assert await reg.search("OLDCALL") == []
    assert [o.id for o in await reg.search("NEWCALL")] == ["aircraft:4ca7b3"]


@pytest.mark.anyio
async def test_index_follows_assert_props(reg) -> None:  # type: ignore[no-untyped-def]
    """assert_props MERGES, so both the old and the new value stay findable."""
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "RYR1234"})
    await reg.assert_props("aircraft:4ca7b3", {"registration": "EIDPZ"}, source="t")
    assert [o.id for o in await reg.search("EIDPZ")] == ["aircraft:4ca7b3"]
    assert [o.id for o in await reg.search("RYR1234")] == ["aircraft:4ca7b3"]


@pytest.mark.anyio
async def test_index_follows_a_delete(reg) -> None:  # type: ignore[no-untyped-def]
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "RYR1234"})
    await reg.delete("aircraft:4ca7b3")
    assert await reg.search("RYR1234") == []


@pytest.mark.anyio
async def test_search_is_scoped_to_the_caller(reg, tmp_path) -> None:  # type: ignore[no-untyped-def]
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "PRIVATE"})
    other = get_registry(UserCtx(user_id="u2", token=None))
    assert await other.search("PRIVATE") == []


@pytest.mark.anyio
@pytest.mark.parametrize(
    "q",
    [
        'unbalanced "quote',
        "AAL-123",
        "NEAR(a b)",
        "col:umn",
        "*",
        "^caret",
        "   ",
        "()",
        "a AND OR b",
    ],
)
async def test_hostile_queries_never_raise(reg, q: str) -> None:  # type: ignore[no-untyped-def]
    """FTS5 treats quotes, hyphens, colons, carets and NEAR as syntax. A search
    box must answer, not 500."""
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "RYR1234"})
    assert isinstance(await reg.search(q), list)


@pytest.mark.anyio
async def test_hyphenated_input_still_matches(reg) -> None:  # type: ignore[no-untyped-def]
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "AAL123"})
    assert [o.id for o in await reg.search("AAL123-")] == ["aircraft:4ca7b3"]


@pytest.mark.anyio
async def test_backfills_rows_written_before_the_index_existed(reg, tmp_path) -> None:  # type: ignore[no-untyped-def]
    """Simulates an upgraded deployment: object rows present, index empty."""
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "LEGACY1"})
    con = sqlite3.connect(str(tmp_path / "ont.db"))
    con.execute("DELETE FROM objects_fts")
    con.commit()
    con.close()
    ontology_local._fts_backfilled.clear()

    assert [o.id for o in await reg.search("LEGACY1")] == ["aircraft:4ca7b3"]


@pytest.mark.anyio
async def test_backfill_keeps_each_user_separate(reg, tmp_path) -> None:  # type: ignore[no-untyped-def]
    await _mint(reg, "aircraft:4ca7b3", {"callsign": "MINE"})
    other = get_registry(UserCtx(user_id="u2", token=None))
    await other.upsert(Object(id="aircraft:beef01", props={"callsign": "THEIRS"}))
    con = sqlite3.connect(str(tmp_path / "ont.db"))
    con.execute("DELETE FROM objects_fts")
    con.commit()
    con.close()
    ontology_local._fts_backfilled.clear()

    assert [o.id for o in await reg.search("MINE")] == ["aircraft:4ca7b3"]
    assert await reg.search("THEIRS") == []


@pytest.mark.anyio
async def test_a_large_blob_cannot_dominate_the_index(reg) -> None:  # type: ignore[no-untyped-def]
    """One prop is truncated, so a saved investigation's node list does not put
    a megabyte of ids into the index."""
    await _mint(reg, "investigation:big", {"nodes": ["x" * 50_000]})
    con = sqlite3.connect(ontology_local._resolved_db_path())
    (text,) = con.execute("SELECT text FROM objects_fts").fetchone()
    con.close()
    assert len(text) < 1_000


def test_route_finds_a_promoted_object(client: TestClient) -> None:
    client.post(
        "/api/ontology/object",
        json={"id": "vessel:636092099", "props": {"name": "SEARCHABLE"}},
    )
    r = client.get("/api/ontology/search", params={"q": "SEARCHABLE"})
    assert r.status_code == 200
    assert [o["id"] for o in r.json()] == ["vessel:636092099"]


def test_route_rejects_an_empty_query(client: TestClient) -> None:
    assert client.get("/api/ontology/search", params={"q": ""}).status_code == 422


def test_route_answers_empty_for_punctuation_only(client: TestClient) -> None:
    r = client.get("/api/ontology/search", params={"q": "***"})
    assert r.status_code == 200
    assert r.json() == []


def test_props_survive_a_round_trip_through_the_index(client: TestClient) -> None:
    """The index must not touch the props blob the frontend round-trips."""
    props = {"name": "EVER GIVEN", "nested": {"a": [1, 2]}, "none": None}
    client.post("/api/ontology/object", json={"id": "vessel:9811000", "props": props})
    got = client.get("/api/ontology/object/vessel:9811000").json()
    assert got["props"] == json.loads(json.dumps(props))
