"""Stage C2 (OSM/Overpass structured retrieval) tests.

Offline by default: the query-builder and clustering/scoring logic are pure
functions exercised against a RECORDED Overpass fixture
(fixtures/overpass_recorded.json — a real, live response captured from
overpass-api.de over a North-Zealand/Denmark bbox on 2026-07-10, trimmed to
~65 elements but otherwise unmodified) so this file runs with no network.

A genuine live Overpass round-trip is also included, gated behind
GEOLOC_LIVE=1 (mirrors the repo's OSINT_LIVE_PROBE convention) so CI stays
offline while a human can still prove the live path works end to end.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from geolocate.retrieval import osm

FIXTURES = Path(__file__).parent / "fixtures"


def _recorded_fixture() -> dict:
    return json.loads((FIXTURES / "overpass_recorded.json").read_text(encoding="utf-8"))


def _demo_evidence() -> dict:
    return json.loads((FIXTURES / "evidence_demo_scene.json").read_text(encoding="utf-8"))


# ── query builder (offline, no network) ────────────────────────────────


class TestExpectedClasses:
    def test_forest_pasture_timber_farmyard_all_fire_on_demo_scene(self):
        ev = _demo_evidence()
        classes = osm.expected_classes(ev)
        # The demo scene mentions forest (beech/birch/canopy), pasture (cattle
        # grazing), a timber outbuilding, and poultry/farm husbandry -- all
        # four should be inferred from the evidence text alone.
        assert "forest" in classes
        assert "meadow_pasture" in classes
        assert "timber_structure" in classes
        assert "farmyard" in classes

    def test_empty_evidence_yields_no_classes(self):
        assert osm.expected_classes({}) == []
        assert osm.expected_classes({"attributes": {}}) == []

    def test_accepts_bare_attributes_dict_too(self):
        # expected_classes must work whether given the whole evidence dict or
        # just its `attributes` sub-dict (both call shapes are used in the
        # codebase: the CLI passes attributes, search() passes a whole Evidence).
        attrs_only = {"biome": "forest", "husbandry": ["cattle pasture"]}
        classes = osm.expected_classes(attrs_only)
        assert "forest" in classes
        assert "meadow_pasture" in classes


class TestBuildOverpassQuery:
    def test_query_contains_bbox_and_matched_tag_filters(self):
        attrs = {"biome": "forest", "husbandry": ["cattle pasture"]}
        bbox = (12.0, 55.5, 13.0, 56.5)  # (w, s, e, n)
        query, classes = osm.build_overpass_query(attrs, bbox)
        assert "forest" in classes and "meadow_pasture" in classes
        assert query.startswith("[out:json]")
        # bbox reordered to Overpass's south,west,north,east convention
        assert "(55.5,12.0,56.5,13.0)" in query
        assert 'nwr["landuse"="forest"]' in query
        assert 'nwr["landuse"="meadow"]' in query
        # a class NOT implied by this evidence must not appear
        assert 'nwr["building"="cabin"]' not in query

    def test_no_matching_classes_yields_empty_query(self):
        query, classes = osm.build_overpass_query({}, (0, 0, 1, 1))
        assert query == ""
        assert classes == []


# ── clustering / scoring on a RECORDED fixture (offline, no network) ────


class TestClusterAndScoreOnRecordedFixture:
    def test_top_cell_shows_real_multi_class_cooccurrence(self):
        fixture = _recorded_fixture()
        assert fixture["recorded"] is True
        assert len(fixture["elements"]) > 0

        scored = osm.cluster_and_score(fixture["elements"], cell_km=1.0, max_candidates=10)
        assert scored, "recorded fixture should yield at least one scored AOI cell"

        top = scored[0]
        # The recorded North-Zealand fixture's top cell genuinely co-occurs
        # farmyard + forest + meadow_pasture tags within ~1km (real OSM data,
        # not fabricated) -- exactly the kind of independent-feature
        # co-occurrence Stage C2 is meant to surface.
        assert len(top["sources"]) >= 3
        assert top["score"] >= scored[1]["score"]
        assert all(s.startswith("C2:") for s in top["sources"])
        assert "lat" in top and "lon" in top and "radius_m" in top

    def test_scores_are_sorted_descending(self):
        fixture = _recorded_fixture()
        scored = osm.cluster_and_score(fixture["elements"], cell_km=1.0, max_candidates=20)
        scores = [c["score"] for c in scored]
        assert scores == sorted(scores, reverse=True)

    def test_more_cooccurring_classes_outscores_a_single_class_cell(self):
        # Synthetic, controlled check of the scoring RULE itself (independent
        # of whatever the recorded fixture happens to contain): a cell with 3
        # distinct classes must outrank a cell with 1, all else equal.
        rich_cell = [
            {"lat": 56.0, "lon": 12.30, "tags": {"landuse": "forest"}},
            {"lat": 56.0001, "lon": 12.3001, "tags": {"landuse": "meadow"}},
            {"lat": 56.0002, "lon": 12.3002, "tags": {"building": "shed"}},
        ]
        poor_cell = [
            {"lat": 10.0, "lon": 10.0, "tags": {"landuse": "forest"}},
        ]
        scored = osm.cluster_and_score(rich_cell + poor_cell, cell_km=1.0)
        assert scored[0]["score"] > scored[1]["score"]
        assert len(scored[0]["sources"]) == 3


class TestRetrieveCandidatesOffline:
    def test_no_query_when_no_classes_map(self, monkeypatch):
        # Evidence with nothing OSM-mappable must short-circuit BEFORE any
        # network call -- never crash, never hit Overpass needlessly.
        calls = {"n": 0}

        def _boom(_q):
            calls["n"] += 1
            raise AssertionError("must not call Overpass when no class matched")

        monkeypatch.setattr(osm, "_overpass_query", _boom)
        candidates, meta = osm.retrieve_candidates({}, (0, 0, 1, 1))
        assert candidates == []
        assert calls["n"] == 0
        assert "no evidence attribute" in meta["note"]

    def test_overpass_failure_degrades_to_empty_not_raise(self, monkeypatch):
        def _boom(_q):
            raise RuntimeError("all Overpass mirrors failed: simulated timeout")

        monkeypatch.setattr(osm, "_overpass_query", _boom)
        candidates, meta = osm.retrieve_candidates(_demo_evidence(), (8.0, 54.5, 15.2, 57.8))
        assert candidates == []
        assert meta["error"] is not None
        assert "Overpass unavailable" in meta["note"]

    def test_recorded_elements_wired_through_retrieve_candidates(self, monkeypatch):
        fixture = _recorded_fixture()

        def _fake_query(_q):
            return {"elements": fixture["elements"]}

        monkeypatch.setattr(osm, "_overpass_query", _fake_query)
        candidates, meta = osm.retrieve_candidates(_demo_evidence(), (12.25, 55.95, 12.45, 56.05))
        assert len(candidates) > 0
        assert meta["error"] is None
        top = candidates[0]
        score = top["score"] if isinstance(top, dict) else top.score
        sources = top["sources"] if isinstance(top, dict) else top.sources
        assert score > 0
        assert any(s.startswith("C2:") for s in sources)


# ── genuine live Overpass round-trip (opt-in, mirrors OSINT_LIVE_PROBE) ──


@pytest.mark.skipif(os.environ.get("GEOLOC_LIVE") != "1", reason="live network probe -- set GEOLOC_LIVE=1 to run")
def test_live_overpass_returns_real_candidates():
    ev = _demo_evidence()
    bbox = (8.0, 54.5, 15.2, 57.8)  # Denmark, Stage B's own prior bbox for this scene
    candidates, meta = osm.retrieve_candidates(ev, bbox)
    assert meta["error"] is None, meta
    assert meta["element_count"] > 0
    assert len(candidates) > 0
