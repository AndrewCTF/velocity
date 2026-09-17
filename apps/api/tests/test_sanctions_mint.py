"""Phase 2 (roadmap-ontology): a sanctions lookup mints the ontology.

A designation is significance, so the /api/sanctions/lookup handler mints the
matched contact as an ontology object — sourced assertions
(``sanctioned`` / ``sanctions_list`` / ``sanctions_match``) plus a
``designated_by`` reason link at the list's org object
(``org:sanctions-<list-slug>``). Best-effort: a registry failure never fails
the lookup, and a per-process-minute budget caps a hammering client at
MAX_INCIDENT_MINTS_PER_CYCLE mints. All ontology state lives in the per-test
temp DB (the autouse ``_isolate_ontology_db`` fixture in conftest.py), and
the process mint counters are reset around each test.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest

from app.config import Settings
from app.intel import ontology_local, promotion
from app.intel import sanctions as sx
from app.intel.ontology import get_registry
from app.intel.ontology_local import SqliteRegistry
from app.intel.ontology_schema import REL_TYPES, validate_link
from app.keys import UserCtx

_S = Settings(supabase_url="")

# The same fixture shapes test_sanctions.py uses: one hull that carries its
# MMSI in free-text remarks, and an aircraft whose tail number IS the name.
SDN = (
    '11111,"ARTAVIL","vessel","IRAN",-0- ,"EQZC","Crude Oil Tanker",-0- ,-0- ,"Iran",'
    '"NITC","Vessel Registration Identification IMO 9187629; MMSI 572469210."\n'
    '15432,"EP-GOL","aircraft","SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,'
    '"Aircraft Model IL-76TD; Linked To: POUYA AIR."\n'
)


@pytest.fixture(autouse=True)
def _clean_mint_counters():
    """The counters are process-wide; no test may leak a budget into the next."""
    promotion.reset_mint_counters()
    yield
    promotion.reset_mint_counters()


@pytest.fixture()
def idx():
    return sx.parse_sdn_csv(SDN)


@pytest.fixture()
def patched_index(idx):
    async def _get_index() -> sx.SanctionsIndex:
        return idx

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(sx, "get_index", _get_index)
    try:
        yield idx
    finally:
        monkeypatch.undo()


def _reg() -> SqliteRegistry:
    reg = get_registry(UserCtx("local", ""), _S)
    assert isinstance(reg, SqliteRegistry)  # keyless -> local backend
    return reg


def _db() -> sqlite3.Connection:
    """A read connection to the per-test ontology DB, schema applied.

    The mint path creates the schema on its first write, but a lookup that
    mints nothing (a miss, a name-only candidate, a failing registry) never
    opens one — a raw ``sqlite3.connect`` to the tmp path would then read an
    empty file with no ``objects`` table.
    """
    return ontology_local._connect(_S)


# ── the relation itself ───────────────────────────────────────────────────────


def test_designated_by_is_a_declared_relation() -> None:
    rt = REL_TYPES["designated_by"]
    assert rt.forward == "designated by"
    assert rt.inverse == "designates"
    assert rt.src == frozenset({"aircraft", "vessel", "org", "person"})
    assert rt.dst == frozenset({"org"})


def test_designated_by_validates_via_validate_link() -> None:
    # A designated contact at the list's org object is the declared shape.
    assert validate_link("designated_by", "aircraft", "org") == []
    assert validate_link("designated_by", "vessel", "org") == []
    # A target that is not an org is a miswiring the schema makes visible.
    assert validate_link("designated_by", "vessel", "incident")
    # An endpoint kind outside the declared set warns exactly once.
    assert len(validate_link("designated_by", "domain", "org")) == 1


# ── a vessel match mints the object + org + link ──────────────────────────────


def test_vessel_lookup_mints_object_assertions_and_designated_by_link(
    client, patched_index
) -> None:
    r = client.get("/api/sanctions/lookup", params={"mmsi": 572469210})
    assert r.status_code == 200
    assert r.json()["matched"] is True

    con = _db()
    try:
        (kind, props) = con.execute(
            "SELECT kind, props FROM objects WHERE id=?", ("vessel:572469210",)
        ).fetchone()
        (org_kind, org_props) = con.execute(
            "SELECT kind, props FROM objects WHERE id=?", ("org:sanctions-ofac-sdn",)
        ).fetchone()
        (src, dst, rel, source) = con.execute(
            "SELECT src, dst, rel, source FROM links WHERE rel='designated_by'"
        ).fetchone()
        assertions = [
            row
            for row in con.execute(
                "SELECT prop, source FROM assertions WHERE object_id=?",
                ("vessel:572469210",),
            )
        ]
    finally:
        con.close()

    # The matched contact mints as a sourced vessel object.
    assert kind == "vessel"
    props = json.loads(props)
    assert props["sanctioned"] is True
    assert props["sanctions_list"] == "OFAC SDN"
    assert props["sanctions_match"] == "ARTAVIL"

    # The list's org object was upserted with its name.
    assert org_kind == "org"
    assert json.loads(org_props)["name"] == "OFAC SDN"

    # The reason link: contact → list, sourced to the authority.
    assert (src, dst, rel, source) == (
        "vessel:572469210",
        "org:sanctions-ofac-sdn",
        "designated_by",
        "sanctions:OFAC SDN",
    )

    # And every assertion on the contact carries the same source.
    assert {row[0] for row in assertions} == {"sanctioned", "sanctions_list", "sanctions_match"}
    assert all(row[1] == "sanctions:OFAC SDN" for row in assertions)


def test_aircraft_lookup_mints_tail_number_object(client, patched_index) -> None:
    r = client.get("/api/sanctions/lookup", params={"registration": "EP-GOL"})
    assert r.status_code == 200
    assert r.json()["matched"] is True

    con = _db()
    try:
        (kind, props) = con.execute(
            "SELECT kind, props FROM objects WHERE id=?", ("aircraft:EP-GOL",)
        ).fetchone()
        (src, dst, rel) = con.execute(
            "SELECT src, dst, rel FROM links WHERE rel='designated_by' AND src='aircraft:EP-GOL'"
        ).fetchone()
    finally:
        con.close()

    assert kind == "aircraft"
    assert json.loads(props)["sanctioned"] is True
    assert (src, dst, rel) == ("aircraft:EP-GOL", "org:sanctions-ofac-sdn", "designated_by")


# ── only identifiers mint, never candidates ──────────────────────────────────


def test_a_miss_mints_nothing(client, patched_index) -> None:
    r = client.get("/api/sanctions/lookup", params={"mmsi": 123456789})
    assert r.status_code == 200
    assert r.json()["matched"] is False

    con = _db()
    try:
        (n_objects, n_links) = con.execute(
            "SELECT (SELECT COUNT(*) FROM objects), (SELECT COUNT(*) FROM links)"
        ).fetchone()
    finally:
        con.close()
    assert (n_objects, n_links) == (0, 0)


def test_a_name_only_match_is_a_candidate_not_an_identifier(client, patched_index) -> None:
    """A hull name is not an identifier (test_sanctions.py) — minting a
    candidate match would be exactly the firehose junk Phase 2 forbids."""
    r = client.get("/api/sanctions/lookup", params={"name": "ARTAVIL"})
    assert r.status_code == 200
    assert r.json()["matched"] is True  # the screen still answers...

    con = _db()
    try:
        (n,) = con.execute("SELECT COUNT(*) FROM objects").fetchone()
    finally:
        con.close()
    assert n == 0  # ...but it mints nothing.


# ── best-effort: the lookup is the product, the mint the side effect ────────


def test_a_registry_error_never_fails_the_lookup(client, patched_index, monkeypatch) -> None:
    async def _boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("registry down")

    monkeypatch.setattr(promotion, "mint_sanctions_match", _boom)
    r = client.get("/api/sanctions/lookup", params={"mmsi": 572469210})
    assert r.status_code == 200
    assert r.json()["matched"] is True

    con = _db()
    try:
        (n,) = con.execute("SELECT COUNT(*) FROM objects").fetchone()
    finally:
        con.close()
    assert n == 0  # the failed mint minted nothing, but the screen still answered


# ── the per-process-minute cap ───────────────────────────────────────────────


def test_mint_cap_is_max_per_process_minute(patched_index) -> None:
    async def run() -> None:
        reg = _reg()
        for i in range(promotion.MAX_INCIDENT_MINTS_PER_CYCLE):
            oid = await promotion.mint_sanctions_match(
                reg,
                f"vessel:{900000000 + i}",
                list_name="OFAC SDN",
                lists="OFAC SDN",
                matched_name=f"CAPSHIP{i}",
            )
            assert oid is not None
        # The 11th mint inside the same process minute is over budget.
        assert (
            await promotion.mint_sanctions_match(
                reg,
                "vessel:999999999",
                list_name="OFAC SDN",
                lists="OFAC SDN",
                matched_name="OVERBUDGET",
            )
            is None
        )
        # And the capped entity got nothing minted.
        assert await reg.get("vessel:999999999") is None

    asyncio.run(run())


# ── the mint counts into the provenance counters ─────────────────────────────


def test_sanctions_mint_counts_into_the_provenance_counters(patched_index) -> None:
    async def run() -> None:
        reg = _reg()
        assert promotion.mints_state() == {"mints_last_cycle": 0, "mints_total": 0}
        oid = await promotion.mint_sanctions_match(
            reg,
            "vessel:572469210",
            list_name="OFAC SDN",
            lists="OFAC SDN",
            matched_name="ARTAVIL",
        )
        assert oid == "vessel:572469210"
        assert promotion.mints_state() == {"mints_last_cycle": 0, "mints_total": 1}
        # A skipped (over-budget or identifierless) mint counts nothing.
        assert (
            await promotion.mint_sanctions_match(
                reg, "", list_name="X", lists="X", matched_name="Y"
            )
            is None
        )
        assert promotion.mints_state() == {"mints_last_cycle": 0, "mints_total": 1}

    asyncio.run(run())
