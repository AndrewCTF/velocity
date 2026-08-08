"""Guards for the declared ontology schema (intel/ontology_schema.py).

Two operator decisions are enforced here:

1. **The vocabulary has one source of truth.** ``KNOWN_RELS`` is derived from
   ``REL_TYPES``; before this it was a second hand-kept frozenset and thirteen
   relations the code was actually minting had fallen out of it. A verb minted
   anywhere in ``apps/api`` must be declared.
2. **Validation warns, it never rejects.** The registry has to be able to hold
   an edge an analyst or a language model invents
   (``intel/ontology.py``'s KNOWN_RELS comment, ``routes/extract.py``'s
   model-authored rels). Every validator therefore has to survive garbage.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.intel.ontology import KNOWN_RELS
from app.intel.ontology_schema import (
    PROP_TYPES,
    REL_TYPES,
    label_for,
    schema_payload,
    validate_link,
    validate_object,
)

_APP_DIR = Path(__file__).resolve().parents[1] / "app"


def test_known_rels_is_derived_from_rel_types() -> None:
    assert KNOWN_RELS == frozenset(REL_TYPES)


def test_every_relation_names_both_ends() -> None:
    for rel, rt in REL_TYPES.items():
        assert rt.forward, f"{rel} has no forward label"
        assert rt.inverse, f"{rel} has no inverse label"


def test_labels_carry_no_em_dash() -> None:
    """Relation labels render in the dashboard, so the copy rule binds them
    (apps/web/CLAUDE.md, docs/decisions.md#dashboard-copy-one-voice…)."""
    for rel, rt in REL_TYPES.items():
        assert "—" not in rt.forward, rel
        assert "—" not in rt.inverse, rel


def test_symmetric_relations_read_the_same_from_both_ends() -> None:
    for rel in ("correlated", "peers_with", "same_as"):
        rt = REL_TYPES[rel]
        assert rt.forward == rt.inverse, rel


def test_contains_and_part_of_are_each_other() -> None:
    assert REL_TYPES["contains"].forward == REL_TYPES["part_of"].inverse
    assert REL_TYPES["contains"].inverse == REL_TYPES["part_of"].forward


def test_every_rel_minted_in_the_backend_is_declared() -> None:
    """The drift guard. Any ``rel="…"`` or ``.link(src, dst, "…")`` literal under
    ``apps/api/app`` has to appear in REL_TYPES, or the schema is lying again."""
    minted: set[str] = set()
    for path in _APP_DIR.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        minted.update(re.findall(r'\brel="([a-z_]+)"', text))
        minted.update(re.findall(r'\.link\([^()]*"([a-z_]+)"\)', text))
    # `enclosure` is an RSS <link rel> in news/sources.py, not an ontology edge.
    minted.discard("enclosure")
    assert minted, "the scan found no rel literals at all — the regex broke"
    assert minted <= set(REL_TYPES), sorted(minted - set(REL_TYPES))


@pytest.mark.parametrize(
    "rel,reverse,expected",
    [
        ("officer_of", False, "officer of"),
        ("officer_of", True, "has officer"),
        ("not_a_real_rel", False, "not a real rel"),
        ("not_a_real_rel", True, "not a real rel"),
    ],
)
def test_label_for(rel: str, reverse: bool, expected: str) -> None:
    assert label_for(rel, reverse=reverse) == expected


# ── validation never rejects ──────────────────────────────────────────────────


def test_validate_object_is_silent_on_an_undeclared_kind() -> None:
    assert validate_object("no_such_kind", {"anything": object()}) == []


def test_validate_object_is_silent_on_an_undeclared_prop() -> None:
    assert validate_object("aircraft", {"invented_by_an_agent": 3}) == []


def test_validate_object_accepts_a_missing_prop() -> None:
    assert validate_object("aircraft", {}) == []


def test_validate_object_ignores_none() -> None:
    """A feed that reports no value writes None; that is the never-guess rule,
    not a type error."""
    assert validate_object("aircraft", {"velocity_ms": None}) == []


def test_validate_object_flags_a_contradicted_type() -> None:
    warnings = validate_object("aircraft", {"velocity_ms": "fast"})
    assert len(warnings) == 1
    assert "velocity_ms" in warnings[0]


def test_bool_is_not_a_number() -> None:
    """bool subclasses int, so a naive isinstance check would pass True as a
    velocity and reject a real bool prop."""
    assert validate_object("aircraft", {"velocity_ms": True})
    assert validate_object("aircraft", {"on_ground": True}) == []
    assert validate_object("aircraft", {"on_ground": 1})


def test_mmsi_may_be_an_int_and_icao24_a_string() -> None:
    assert validate_object("vessel", {"mmsi": 636092000}) == []
    assert validate_object("aircraft", {"icao24": "4ca7b3"}) == []


def test_validate_link_warns_on_an_unknown_rel_but_returns() -> None:
    warnings = validate_link("model_invented_this", "domain", "ip")
    assert len(warnings) == 1
    assert "not a declared relation" in warnings[0]


def test_validate_link_accepts_a_declared_pair() -> None:
    assert validate_link("resolves_to", "domain", "ip") == []


def test_validate_link_flags_a_wrong_endpoint() -> None:
    warnings = validate_link("resolves_to", "vessel", "ip")
    assert len(warnings) == 1
    assert "source" in warnings[0]


def test_validate_link_unconstrained_endpoints_never_warn() -> None:
    assert validate_link("same_as", "aircraft", "wallet") == []


def test_validators_survive_hostile_input() -> None:
    """The point of warn-never-reject: nothing in here may raise."""
    assert validate_object("aircraft", {"callsign": {"nested": [1, 2]}})
    validate_object("", {})
    validate_link("", "", "")
    label_for("")


# ── the payload the frontend reads ────────────────────────────────────────────


def test_schema_payload_shape() -> None:
    payload = schema_payload()
    assert set(payload) == {"relations", "kinds"}
    assert set(payload["relations"]) == set(REL_TYPES)
    assert set(payload["kinds"]) == set(PROP_TYPES)
    officer = payload["relations"]["officer_of"]
    assert officer == {
        "forward": "officer of",
        "inverse": "has officer",
        "src_kinds": ["person"],
        "dst_kinds": ["org"],
    }


def test_schema_route_is_keyless(client: TestClient) -> None:
    r = client.get("/api/ontology/schema")
    assert r.status_code == 200
    assert r.json()["relations"]["contains"]["inverse"] == "part of"


def test_object_post_reports_warnings_without_refusing_the_write(
    client: TestClient,
) -> None:
    r = client.post(
        "/api/ontology/object",
        json={"id": "aircraft:testaa", "props": {"velocity_ms": "fast"}},
    )
    assert r.status_code == 200
    body = r.json()
    # The object is stored verbatim — warnings describe it, they do not gate it.
    assert body["id"] == "aircraft:testaa"
    assert body["props"] == {"velocity_ms": "fast"}
    assert len(body["warnings"]) == 1

    stored = client.get("/api/ontology/object/aircraft:testaa")
    assert stored.status_code == 200
    assert stored.json()["props"] == {"velocity_ms": "fast"}


def test_object_post_is_quiet_when_nothing_is_wrong(client: TestClient) -> None:
    r = client.post(
        "/api/ontology/object",
        json={"id": "aircraft:testbb", "props": {"callsign": "TEST123"}},
    )
    assert r.status_code == 200
    assert r.json()["warnings"] == []
