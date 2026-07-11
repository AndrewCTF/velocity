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

import pytest

from app.config import Settings
from app.intel import promotion
from app.intel.ontology import get_registry
from app.intel.ontology_local import SqliteRegistry, _resolved_db_path
from app.keys import UserCtx

_S = Settings(supabase_url="")


def _reg(user: str = "local") -> SqliteRegistry:
    reg = get_registry(UserCtx(user, ""), _S)
    assert isinstance(reg, SqliteRegistry)  # keyless -> local backend
    return reg


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
        evidence.append(
            {"domain": "air-emergency", "ref": {"icao24": icao24, "squawk": "7700"}}
        )
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

        incident_id = await promotion.promote_incident(
            reg, inc, source="agent:watch_officer"
        )

        assert incident_id is not None
        assert incident_id.startswith("incident:")

        obj = await reg.get(incident_id)
        assert obj is not None
        assert obj.kind == "incident"

        rows = await reg.get_assertions(incident_id)
        assert any(r.source == "agent:watch_officer" for r in rows)
        # Never defaulted to the generic "analyst" source for this pipeline.
        assert not any(
            r.source == "analyst" and r.prop == "threat_level" for r in rows
        )

        links = await reg._links_touching(["aircraft:4ca7b3"])
        evidence_links = [
            lk
            for lk in links
            if lk.src == "aircraft:4ca7b3"
            and lk.dst == incident_id
            and lk.rel == "evidence_of"
        ]
        assert len(evidence_links) == 1

        vessel_links = await reg._links_touching(["vessel:636092000"])
        assert any(
            lk.src == "vessel:636092000"
            and lk.dst == incident_id
            and lk.rel == "evidence_of"
            for lk in vessel_links
        )

    asyncio.run(run())


# ── case 6: determinism / no duplication ──────────────────────────────────────


def test_repeated_promotion_is_idempotent_no_dup_object_or_assertion() -> None:
    async def run() -> None:
        reg = _reg()
        inc = _incident(lon=30.0, lat=40.0)

        first_id = await promotion.promote_incident(
            reg, inc, source="agent:watch_officer"
        )
        first_assertions = await reg.get_assertions(first_id)

        second_id = await promotion.promote_incident(
            reg, inc, source="agent:watch_officer"
        )
        second_assertions = await reg.get_assertions(second_id)

        assert first_id == second_id
        # Identical (value, source) re-assert is deduped -- no new rows.
        assert len(second_assertions) == len(first_assertions)

        # Direct count query: no duplicate object row was minted. The
        # objects table's PRIMARY KEY(user_id, id) makes a second row
        # structurally impossible for the same id, but assert the observable
        # count anyway (per plan §C case 6).
        con = sqlite3.connect(_resolved_db_path(_S))
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
        expected_kept_ids = {
            promotion._stable_incident_id(inc) for inc in expected_kept
        }
        expected_dropped_ids = {
            promotion._stable_incident_id(inc) for inc in expected_dropped
        }

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

        result = await promotion.promote_incident(
            reg, inc, source="agent:watch_officer"
        )

        assert result is None

        would_be_id = promotion._stable_incident_id(inc)
        assert await reg.get(would_be_id) is None

    asyncio.run(run())


# ── case 9: all keyless (no Supabase config anywhere in this file) ────────────


def test_keyless_settings_used_throughout() -> None:
    assert _S.supabase_url == ""
