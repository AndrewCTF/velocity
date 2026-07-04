"""Entity-resolution unit tests — deterministic, no network.

The headline behaviours both Gotham reports stress:
  * the same strong id (IMO) links a vessel across MMSI changes → ONE identity;
  * a conflict between strong ids is recorded, NEVER auto-merged.
"""

from __future__ import annotations

import pytest

from app.intel import resolve


@pytest.fixture(autouse=True)
def _temp_db(tmp_path):
    resolve.override_db_path(str(tmp_path / "resolve_test.db"))
    yield
    resolve.override_db_path(None)


def test_same_mmsi_resolves_to_same_canonical():
    a = resolve.resolve("vessel", {"mmsi": "636092000"})
    b = resolve.resolve("vessel", {"mmsi": "636092000"})
    assert a == b == "vessel:636092000"


def test_imo_links_across_mmsi_change():
    # Same hull (IMO), two different MMSIs over its life → ONE identity.
    c1 = resolve.resolve("vessel", {"mmsi": "111111111", "imo": "9074729", "name": "ATLAS"})
    c2 = resolve.resolve("vessel", {"mmsi": "222222222", "imo": "9074729"})
    assert c1 == c2
    # both MMSIs are now aliases of the one canonical
    vals = {a["value"] for a in resolve.aliases_of(c1)}
    assert {"111111111", "222222222", "9074729"} <= vals
    # and a live vessel:<mmsi> id resolves back to the canonical
    assert resolve.canonical_of("vessel:222222222") == c1


def test_conflicting_imo_is_not_auto_merged():
    # MMSI reused / bad data: same MMSI reports two different IMOs.
    resolve.resolve("vessel", {"mmsi": "333333333", "imo": "9000001"})
    resolve.resolve("vessel", {"mmsi": "333333333", "imo": "9000002"})
    # The contradicting strong id must NOT silently merge — a review row exists.
    assert resolve.stats()["merge_candidates"] >= 1
    # The original IMO alias is untouched (no overwrite to the new IMO).
    assert resolve.canonical_of("vessel:333333333") == "entity:vessel:imo:9000001"


def test_aircraft_icao24_is_canonical_and_aliases_registration():
    c = resolve.resolve("aircraft", {"icao24": "4ca7b3", "registration": "EI-DEF", "callsign": "RYR123"})
    assert c == "aircraft:4ca7b3"
    assert resolve.canonical_of("aircraft:4ca7b3") == c
    types = {a["type"] for a in resolve.aliases_of(c)}
    assert {"icao24", "registration", "callsign"} <= types


def test_canonical_of_unknown_is_self():
    assert resolve.canonical_of("vessel:999") == "vessel:999"
    assert resolve.canonical_of("entity:vessel:imo:123") == "entity:vessel:imo:123"


def test_resolve_requires_an_identifier():
    with pytest.raises(ValueError):
        resolve.resolve("vessel", {})
