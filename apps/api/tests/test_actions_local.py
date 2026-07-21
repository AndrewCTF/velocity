"""Governed write-back on a keyless boot (``Settings(supabase_url="")``).

Before this module existed, ``intel/actions.py``'s ``_append_audit`` had
exactly one backend (Supabase PostgREST ``action_log``) and 503'd/502'd on
every dispatch once the local-only ontology store (2026-07-07,
docs/decisions.md) made the ontology mutation itself succeed but the audit
step still hit an unconfigured Supabase URL. Proven pre-fix (this exact call,
against the code before this file's sibling changes)::

    dispatch("flag_entity", {"target_id": "aircraft:proof", "note": "x"},
              UserCtx("u1", "tok"), Settings(supabase_url=""))
    -> HTTPException 503 "Supabase is not configured"

These tests hit ``dispatch`` directly (no mocking) against a keyless
``Settings`` and assert the governed write-backs succeed with a
locally-persisted, readable-back audit trail instead.
"""

from __future__ import annotations

import asyncio

import pytest

from app.config import Settings
from app.intel import action_log_local, alert_rules_local
from app.intel.actions import dispatch
from app.intel.ontology_local import SqliteRegistry
from app.keys import UserCtx


@pytest.fixture(autouse=True)
def _isolate_action_log_db(tmp_path):
    """Point the new local action_log sink at a per-test temp file — mirrors
    conftest's ``_isolate_ontology_db`` / ``_isolate_alert_rules_db``, kept
    local to this file since ``action_log_local`` has no conftest hook yet."""
    action_log_local.override_db_path(str(tmp_path / "action_log.db"))
    yield
    action_log_local.override_db_path(None)


def _ctx() -> UserCtx:
    return UserCtx("u1", "tok")


def _keyless() -> Settings:
    return Settings(supabase_url="")


# ── 1a: local action_log sink ──────────────────────────────────────────────


def test_flag_entity_succeeds_and_audit_reads_back_locally() -> None:
    res = asyncio.run(
        dispatch(
            "flag_entity",
            {"target_id": "aircraft:proof", "note": "loitering", "severity": 4},
            _ctx(),
            _keyless(),
        )
    )
    assert res.ok is True
    assert res.audit["action"] == "flag_entity"
    assert res.audit["target_id"] == "aircraft:proof"

    rows = asyncio.run(action_log_local.list_rows())
    assert any(
        r["action"] == "flag_entity" and r["target_id"] == "aircraft:proof"
        for r in rows
    )
    match = next(r for r in rows if r["target_id"] == "aircraft:proof")
    assert match["user_id"] == "u1"
    assert match["params"]["note"] == "loitering"


# ── 1b: nominate_target / add_watch no longer 503 early ───────────────────


def test_nominate_target_keyless_skips_board_instead_of_503() -> None:
    res = asyncio.run(
        dispatch(
            "nominate_target",
            {"target_id": "vessel:1", "priority": 2, "note": "dark"},
            _ctx(),
            _keyless(),
        )
    )
    assert res.ok is True
    # No local target_board store exists (deliberately deferred) — the
    # supplementary board reflection is skipped, not sunk into a 503.
    assert res.detail["target_board_entry"] is None
    rows = asyncio.run(action_log_local.list_rows())
    assert any(r["action"] == "nominate_target" for r in rows)


def test_add_watch_keyless_persists_to_local_alert_rules_store() -> None:
    res = asyncio.run(
        dispatch(
            "add_watch",
            {
                "target_id": "aircraft:y",
                "label": "Hormuz watch",
                "lat": 26.5,
                "lon": 56.3,
                "radius_nm": 80,
                "kinds": ["jamming"],
            },
            _ctx(),
            _keyless(),
        )
    )
    assert res.ok is True
    assert res.detail["alert_rule"]["id"]

    rules = asyncio.run(alert_rules_local.list_rules("u1", settings=_keyless()))
    assert any(r["label"] == "Hormuz watch" for r in rules)


# ── 1c: stable incident id + correct evidence_of direction ────────────────


def test_promote_incident_is_idempotent_not_uuid4_per_call() -> None:
    res1 = asyncio.run(
        dispatch(
            "promote_incident",
            {"target_id": "aircraft:dup", "title": "first"},
            _ctx(),
            _keyless(),
        )
    )
    res2 = asyncio.run(
        dispatch(
            "promote_incident",
            {"target_id": "aircraft:dup", "title": "second approval"},
            _ctx(),
            _keyless(),
        )
    )
    # Approving the same promotion twice must land on ONE incident node, not
    # mint a second uuid4-keyed one.
    assert res1.target_id == res2.target_id


def test_promote_incident_evidence_of_edge_points_target_to_incident() -> None:
    res = asyncio.run(
        dispatch(
            "promote_incident",
            {"target_id": "aircraft:evd", "title": "t"},
            _ctx(),
            _keyless(),
        )
    )
    reg = SqliteRegistry(_ctx(), _keyless())
    links = asyncio.run(reg._links_touching(["aircraft:evd"]))
    evidence_links = [lk for lk in links if lk.rel == "evidence_of"]
    assert evidence_links, "expected an evidence_of edge to the incident"
    # Canonical direction (ontology.py KNOWN_RELS): member entity -> incident.
    assert evidence_links[0].src == "aircraft:evd"
    assert evidence_links[0].dst == res.target_id
