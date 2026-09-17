"""Guard: incidents auto-promote into the ontology graph (W4 slice 1).

Covers docs/ontology-autopopulation-plan.md §C. All tests run against the
real SqliteRegistry on a per-test temp DB (the autouse ``_isolate_ontology_db``
fixture in conftest.py) — keyless, no Supabase config anywhere, mirroring
test_ontology_local.py's ``_reg()`` idiom.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.intel import ontology_local, promotion
from app.intel.ontology import get_registry
from app.intel.ontology_local import SqliteRegistry
from app.keys import UserCtx
from app.routes import adsb as adsb_routes

_S = Settings(supabase_url="")


def _reg(user: str = "local") -> SqliteRegistry:
    reg = get_registry(UserCtx(user, ""), _S)
    assert isinstance(reg, SqliteRegistry)  # keyless -> local backend
    return reg


def _db() -> sqlite3.Connection:
    """A read connection to the per-test ontology DB, schema applied.

    The registry creates the schema lazily on its first write, so a raw
    ``sqlite3.connect`` to the tmp path reads an empty file (no ``objects``
    table) whenever the test ahead of it minted nothing. Go through the same
    connect the registry uses instead.
    """
    return ontology_local._connect(_S)


def _incident(
    *,
    lon: float,
    lat: float,
    threat_level: str = "high",
    score: float = 90.0,
    domains: list[str] | None = None,
    icao24: str | None = "4ca7b3",
    mmsi: str | None = "636092000",
) -> dict:
    evidence = []
    doms = domains if domains is not None else ["air-emergency", "dark-vessel"]
    if icao24:
        evidence.append({"domain": "air-emergency", "ref": {"icao24": icao24, "squawk": "7700"}})
    if mmsi:
        evidence.append({"domain": "dark-vessel", "ref": {"mmsi": mmsi}})
    return {
        "id": "brief-id-does-not-matter",
        "threat_level": threat_level,
        "score": score,
        "domains": doms,
        "narrative": f"convergence near {lon},{lat}",
        "centroid": {"lon": lon, "lat": lat},
        "evidence": evidence,
    }


def _quake_only_incident(lon: float, lat: float) -> dict:
    return {
        "id": "brief-id-quake",
        "threat_level": "high",
        "score": 80.0,
        "domains": ["quake"],
        "narrative": "quake near here",
        "centroid": {"lon": lon, "lat": lat},
        "evidence": [{"domain": "quake", "ref": {"mag": 6.1}}],
    }


# ── case 1/2/3/4: mint one incident, object + assertion + link ────────────────


def test_promote_incident_mints_object_with_sourced_assertion_and_evidence_link() -> None:
    async def run() -> None:
        reg = _reg()
        inc = _incident(lon=10.0, lat=20.0)

        incident_id = await promotion.promote_incident(reg, inc, source="agent:watch_officer")

        assert incident_id is not None
        assert incident_id.startswith("incident:")

        obj = await reg.get(incident_id)
        assert obj is not None
        assert obj.kind == "incident"

        rows = await reg.get_assertions(incident_id)
        assert any(r.source == "agent:watch_officer" for r in rows)
        # Never defaulted to the generic "analyst" source for this pipeline.
        assert not any(r.source == "analyst" and r.prop == "threat_level" for r in rows)

        links = await reg._links_touching(["aircraft:4ca7b3"])
        evidence_links = [
            lk
            for lk in links
            if lk.src == "aircraft:4ca7b3" and lk.dst == incident_id and lk.rel == "evidence_of"
        ]
        assert len(evidence_links) == 1

        vessel_links = await reg._links_touching(["vessel:636092000"])
        assert any(
            lk.src == "vessel:636092000" and lk.dst == incident_id and lk.rel == "evidence_of"
            for lk in vessel_links
        )

    asyncio.run(run())


# ── case 6: determinism / no duplication ──────────────────────────────────────


def test_repeated_promotion_is_idempotent_no_dup_object_or_assertion() -> None:
    async def run() -> None:
        reg = _reg()
        inc = _incident(lon=30.0, lat=40.0)

        first_id = await promotion.promote_incident(reg, inc, source="agent:watch_officer")
        first_assertions = await reg.get_assertions(first_id)

        second_id = await promotion.promote_incident(reg, inc, source="agent:watch_officer")
        second_assertions = await reg.get_assertions(second_id)

        assert first_id == second_id
        # Identical (value, source) re-assert is deduped -- no new rows.
        assert len(second_assertions) == len(first_assertions)

        # Direct count query: no duplicate object row was minted. The
        # objects table's PRIMARY KEY(user_id, id) makes a second row
        # structurally impossible for the same id, but assert the observable
        # count anyway (per plan §C case 6).
        con = _db()
        try:
            (count,) = con.execute(
                "SELECT COUNT(*) FROM objects WHERE id=?", (first_id,)
            ).fetchone()
        finally:
            con.close()
        assert count == 1

    asyncio.run(run())


# ── case 7: per-cycle cap drops the lowest-threat tail, and logs it ───────────


def test_per_cycle_cap_drops_lowest_threat_tail_and_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def run() -> None:
        reg = _reg()
        total = promotion.MAX_INCIDENT_MINTS_PER_CYCLE + 3
        # Best-first order (as incidents.brief() already returns): descending
        # score. Distinct centroids -> distinct incident_key/id each.
        incidents_in = [
            _incident(
                lon=float(i),
                lat=float(i),
                score=100.0 - i,
                threat_level="high",
            )
            for i in range(total)
        ]

        with caplog.at_level(logging.INFO, logger="app.intel.promotion"):
            minted = await promotion.promote_incidents(
                reg, incidents_in, source="agent:watch_officer"
            )

        assert len(minted) == promotion.MAX_INCIDENT_MINTS_PER_CYCLE

        # Best-first retention: the minted ids correspond exactly to the
        # leading (highest-score) slice of the input, and the dropped tail is
        # specifically the lowest-threat 3 -- not an arbitrary subset.
        budget = promotion.MAX_INCIDENT_MINTS_PER_CYCLE
        expected_kept = incidents_in[:budget]
        expected_dropped = incidents_in[budget:]
        expected_kept_ids = {promotion._stable_incident_id(inc) for inc in expected_kept}
        expected_dropped_ids = {promotion._stable_incident_id(inc) for inc in expected_dropped}

        assert set(minted) == expected_kept_ids
        assert set(minted).isdisjoint(expected_dropped_ids)

        assert any(
            "dropped" in rec.message and "3" in rec.message
            for rec in caplog.records
            if rec.name == "app.intel.promotion"
        )

    asyncio.run(run())


# ── case 8: zero-translatable-member incident is skipped, not orphan-minted ───


def test_zero_translatable_member_incident_is_skipped() -> None:
    async def run() -> None:
        reg = _reg()
        inc = _quake_only_incident(lon=50.0, lat=60.0)

        result = await promotion.promote_incident(reg, inc, source="agent:watch_officer")

        assert result is None

        would_be_id = promotion._stable_incident_id(inc)
        assert await reg.get(would_be_id) is None

    asyncio.run(run())


# ── case 9: all keyless (no Supabase config anywhere in this file) ────────────


def test_keyless_settings_used_throughout() -> None:
    assert _S.supabase_url == ""


# ── Phase 2: promote_alert (exported for the correlation-bus slice) ──────────


def _alert(over: dict[str, Any] | None = None) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "alert-uuid-1",
        "rule_id": "proximity_mil_vessel",
        "severity": "high",
        "lon": 10.0,
        "lat": 20.0,
        "confidence": 0.9,
        "message": "vessel within 10 nm of a military vessel",
        "entity_id": "vessel:636092000",
    }
    if over:
        base.update(over)
    return base


def test_promote_alert_mints_object_assertion_and_evidence_link() -> None:
    async def run() -> None:
        reg = _reg()
        alert = _alert()

        oid = await promotion.promote_alert(reg, alert)

        assert oid == "vessel:636092000"
        obj = await reg.get(oid)
        assert obj is not None
        assert obj.kind == "vessel"

        # The assertion carries the alert itself, sourced to the rule — never
        # the generic "analyst" default.
        rows = await reg.get_assertions(oid)
        assert any(r.source == "alert:proximity_mil_vessel" for r in rows)
        assert any(r.prop == "rule" and r.value == "proximity_mil_vessel" for r in rows)

        # The same relation promote_incident uses, in its documented canonical
        # direction: the fired alert (evidence) → the entity it is evidence about.
        links = await reg._links_touching([oid])
        assert any(
            lk.src == "alert-uuid-1" and lk.dst == oid and lk.rel == "evidence_of" for lk in links
        )

    asyncio.run(run())


def test_promote_alert_is_idempotent_on_a_second_call() -> None:
    async def run() -> None:
        reg = _reg()
        alert = _alert()

        first_id = await promotion.promote_alert(reg, alert)
        first_assertions = await reg.get_assertions(first_id)
        second_id = await promotion.promote_alert(reg, alert)

        assert first_id == second_id
        # Identical (value, source) re-assert is deduped — no new rows.
        assert len(await reg.get_assertions(second_id)) == len(first_assertions)

        # One object row and ONE evidence_of link, after two calls.
        con = _db()
        try:
            (objects,) = con.execute(
                "SELECT COUNT(*) FROM objects WHERE id=?", (first_id,)
            ).fetchone()
            (links,) = con.execute(
                "SELECT COUNT(*) FROM links WHERE src=? AND dst=? AND rel='evidence_of'",
                ("alert-uuid-1", first_id),
            ).fetchone()
        finally:
            con.close()
        assert objects == 1
        assert links == 1

    asyncio.run(run())


def test_promote_alert_without_entity_id_stands_alone() -> None:
    async def run() -> None:
        reg = _reg()
        alert = _alert()
        alert.pop("entity_id")  # today's bus alerts carry no entity id yet

        oid = await promotion.promote_alert(reg, alert)

        # No usable entity id: the alert's own id is the object, and a
        # self-link is junk, so no link is minted.
        assert oid == "alert-uuid-1"
        assert await reg.get(oid) is not None
        links = await reg._links_touching([oid])
        assert not any(lk.src == oid and lk.dst == oid for lk in links)

    asyncio.run(run())


def test_promote_alert_with_no_usable_id_mints_nothing() -> None:
    async def run() -> None:
        reg = _reg()
        assert await promotion.promote_alert(reg, {"rule_id": "major_quake"}) is None

        con = _db()
        try:
            (n,) = con.execute("SELECT COUNT(*) FROM objects").fetchone()
        finally:
            con.close()
        assert n == 0

    asyncio.run(run())


# ── mint counters (/api/status/provenance "ontology") ─────────────────────────


def test_mint_counters_count_and_roll_per_cycle() -> None:
    async def run() -> None:
        reg = _reg()
        promotion.reset_mint_counters()
        try:
            await promotion.promote_incident(reg, _incident(lon=1.0, lat=1.0), source="test")
            await promotion.promote_incident(reg, _incident(lon=2.0, lat=2.0), source="test")
            assert promotion.mints_state() == {"mints_last_cycle": 0, "mints_total": 2}

            await promotion.promote_incidents(reg, [_incident(lon=3.0, lat=3.0)], source="test")
            # begin_cycle rolled the in-flight accumulator (2) into last-cycle;
            # the batch's own mint accrues to the NEW in-flight cycle.
            assert promotion.mints_state() == {"mints_last_cycle": 2, "mints_total": 3}
        finally:
            promotion.reset_mint_counters()

    asyncio.run(run())


def test_status_provenance_reports_the_ontology_mint_counters(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Keep the route's snapshot read keyless and cheap.
    async def _snap() -> dict:
        return {"type": "FeatureCollection", "features": []}

    monkeypatch.setattr(adsb_routes, "global_snapshot", _snap)
    promotion.reset_mint_counters()
    try:
        r = client.get("/api/status/provenance")
        assert r.status_code == 200
        body = r.json()
        assert set(body["ontology"]) == {"mints_last_cycle", "mints_total"}
        assert body["ontology"]["mints_total"] == 0
        assert body["ontology"]["mints_last_cycle"] == 0

        async def run() -> None:
            reg = _reg()
            oid = await promotion.promote_incident(reg, _incident(lon=9.0, lat=9.0), source="test")
            assert oid is not None

        asyncio.run(run())
        body = client.get("/api/status/provenance").json()
        assert body["ontology"]["mints_total"] == 1
    finally:
        promotion.reset_mint_counters()
