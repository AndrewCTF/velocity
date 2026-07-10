"""Stage B (geo-prior fusion) tests.

Offline, deterministic, no network: the rule fuser (knowledge/cues.yaml) and
the log-opinion-pool fusion math are pure functions.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from geolocate import geoprior
from geolocate.contracts import Evidence

FIXTURES = Path(__file__).parent / "fixtures"


def _demo_evidence() -> Evidence:
    return Evidence.from_dict(
        json.loads((FIXTURES / "evidence_demo_scene.json").read_text(encoding="utf-8"))
    )


# ── knowledge base loads ─────────────────────────────────────────────────


class TestKnowledgeBaseLoads:
    def test_cues_yaml_loads_and_is_well_formed(self):
        kb = geoprior.load_kb()
        assert len(kb) >= 10
        for cue in kb:
            assert "id" in cue
            assert cue.get("match") in ("any", "equals", "table")
            assert cue.get("rationale")
            if cue["match"] in ("any", "equals"):
                assert cue.get("weights"), cue["id"]
            else:
                assert cue.get("table"), cue["id"]

    def test_region_bboxes_yaml_loads_and_covers_every_cue_region(self):
        # Every region any cue can name must have a bbox, or build_geo_prior
        # would have to fall back to a world bbox for it.
        kb = geoprior.load_kb()
        bboxes = geoprior.load_region_bboxes()
        assert len(bboxes) >= 10

        cue_regions: set[str] = set()
        for cue in kb:
            if cue["match"] in ("any", "equals"):
                cue_regions |= set(cue.get("weights", {}))
            else:
                for weights in cue.get("table", {}).values():
                    cue_regions |= set(weights)

        missing = cue_regions - set(bboxes)
        assert not missing, f"cues.yaml references regions with no bundled bbox: {missing}"

        for region, bbox in bboxes.items():
            assert len(bbox) == 4, region
            w, s, e, n = bbox
            assert -180 <= w < e <= 180, region
            assert -90 <= s < n <= 90, region

    def test_no_country_names_hardcoded_in_geoprior_module_source(self):
        # Spec requirement: region/country names live ONLY in the YAML data,
        # never in geoprior.py's code paths. Spot-check a few KB region names
        # do not appear as bare identifiers in the module source.
        src = Path(geoprior.__file__).read_text(encoding="utf-8")
        for region in ("Denmark", "Sweden", "Greece", "Ruritania"):
            assert region not in src


# ── cue matching mechanics (synthetic KB, independent of the real cues.yaml) ─


class TestRuleFuserSyntheticKB:
    KB = [
        {
            "id": "red_timber",
            "path": "text",
            "match": "any",
            "keywords": ["red timber"],
            "weights": {"Ruritania": 3.0, "Elsewhere": 1.0},
            "rationale": "red timber cladding",
        },
        {
            "id": "lang_ru",
            "path": "attributes.language",
            "match": "table",
            "table": {"ru": {"Ruritania": 5.0}},
            "rationale": "on-scene language",
        },
        {
            "id": "side_left",
            "path": "attributes.driving_side",
            "match": "table",
            "table": {"left": {"Leftland": 4.0}},
            "rationale": "left-hand traffic",
        },
    ]
    BBOXES = {"Ruritania": [0, 0, 1, 1], "Elsewhere": [10, 10, 11, 11], "Leftland": [20, 20, 21, 21]}

    def test_any_keyword_cue_fires_on_free_text(self):
        ev = {"caption": "A red timber barn.", "attributes": {}}
        scores, fired = geoprior.score_cues(ev, self.KB)
        assert scores["Ruritania"] == pytest.approx(3.0)
        assert scores["Elsewhere"] == pytest.approx(1.0)
        assert fired[0]["id"] == "red_timber"

    def test_table_cue_fires_on_exact_attribute(self):
        ev = {"caption": "", "attributes": {"language": "ru"}}
        scores, _ = geoprior.score_cues(ev, self.KB)
        assert scores == {"Ruritania": 5.0}

    def test_missing_attribute_does_not_fire(self):
        ev = {"caption": "nothing relevant here", "attributes": {"driving_side": None}}
        scores, fired = geoprior.score_cues(ev, self.KB)
        assert scores == {}
        assert fired == []

    def test_cues_combine_additively_across_matches(self):
        ev = {"caption": "A red timber barn.", "attributes": {"language": "ru", "driving_side": "left"}}
        scores, fired = geoprior.score_cues(ev, self.KB)
        assert scores["Ruritania"] == pytest.approx(3.0 + 5.0)
        assert scores["Leftland"] == pytest.approx(4.0)
        assert len(fired) == 3

    def test_rule_only_ranks_by_cue_weight(self):
        ev = {"caption": "A red timber barn.", "attributes": {}}
        priors = geoprior.build_geo_prior(ev, kb=self.KB, region_bboxes=self.BBOXES)
        assert priors[0].region == "Ruritania"
        assert priors[0].p > priors[1].p
        assert priors[0].bbox == self.BBOXES["Ruritania"]

    def test_vlm_estimate_can_flip_the_top_region(self):
        # Rule fuser prefers Ruritania (weight 3.0) over Elsewhere (1.0); a
        # confident VLM opinion the OTHER way should be able to flip the top
        # pick via the log-opinion pool -- proves the VLM slot is load-bearing,
        # not decorative.
        ev = {"caption": "A red timber barn.", "attributes": {}}
        vlm = {"Ruritania": 0.05, "Elsewhere": 0.95}
        priors = geoprior.build_geo_prior(ev, kb=self.KB, region_bboxes=self.BBOXES, vlm_estimate=vlm)
        assert priors[0].region == "Elsewhere"

    def test_no_vlm_estimate_falls_back_to_rule_only(self):
        ev = {"caption": "A red timber barn.", "attributes": {}}
        priors = geoprior.build_geo_prior(ev, kb=self.KB, region_bboxes=self.BBOXES)
        assert "no VLM estimate supplied" in priors[0].rationale


# ── log-opinion-pool math ────────────────────────────────────────────────


class TestLogOpinionPool:
    def test_agreement_reinforces_beyond_either_opinion_alone(self):
        a = {"A": 0.9, "B": 0.1}
        b = {"A": 0.8, "B": 0.2}
        pooled = geoprior.log_opinion_pool([(a, 1.0), (b, 1.0)])
        assert pooled["A"] > max(a["A"], b["A"])  # product-of-experts, not an average

    def test_strong_disagreement_pulls_a_region_down_harder_than_averaging_would(self):
        rule = {"A": 0.95, "B": 0.05}
        vlm = {"A": 0.02, "B": 0.98}
        pooled = geoprior.log_opinion_pool([(rule, 1.0), (vlm, 1.0)])
        linear_mix_a = 0.5 * rule["A"] + 0.5 * vlm["A"]
        assert pooled["A"] < linear_mix_a

    def test_zero_weight_opinion_is_ignored(self):
        a = {"A": 0.9, "B": 0.1}
        b = {"A": 0.1, "B": 0.9}
        pooled = geoprior.log_opinion_pool([(a, 1.0), (b, 0.0)])
        assert pooled["A"] > pooled["B"]

    def test_pooled_distribution_sums_to_one(self):
        a = {"A": 0.7, "B": 0.3}
        b = {"A": 0.4, "B": 0.6}
        pooled = geoprior.log_opinion_pool([(a, 1.0), (b, 1.0)])
        assert math.isclose(sum(pooled.values()), 1.0, rel_tol=1e-9)

    def test_empty_input_returns_empty(self):
        assert geoprior.log_opinion_pool([]) == {}


# ── end-to-end on the demo scene (real cues.yaml + real region_bboxes.yaml) ─


class TestBuildGeoPriorDemoScene:
    """The scene from the task's live-proof demo: a Nordic-red timber
    outbuilding + beech/birch forest with mossy glacial boulders + free-range
    woodland chickens + a small Hereford herd on forest-edge pasture; no
    signage/plates. Spec requirement: Denmark/S-Scandinavia at or near the top.
    """

    def test_denmark_or_s_scandinavia_ranks_in_top_two(self):
        priors = geoprior.fuse([_demo_evidence()])
        assert len(priors) >= 2
        top_two = {priors[0].region, priors[1].region}
        assert top_two == {"Denmark", "S-Scandinavia"}, [p.region for p in priors]

    def test_ranking_is_sorted_descending_by_probability(self):
        priors = geoprior.fuse([_demo_evidence()])
        ps = [p.p for p in priors]
        assert ps == sorted(ps, reverse=True)

    def test_every_region_carries_a_bbox_and_a_cue_backed_rationale(self):
        priors = geoprior.fuse([_demo_evidence()])
        for p in priors:
            assert len(p.bbox) == 4
            assert p.rationale
            # at least one real cue id should be cited, not just the fusion-note prefix
            assert "(+" in p.rationale

    def test_top_region_rationale_cites_the_beech_or_timber_cue(self):
        priors = geoprior.fuse([_demo_evidence()])
        top = priors[0]
        assert "vegetation_beech_forest_moraine" in top.rationale or "architecture_falu_red_timber" in top.rationale

    def test_build_geo_prior_accepts_a_bare_dict_too(self):
        # build_geo_prior must accept either an Evidence dataclass or a plain
        # dict (contracts.py may not always be in the loop, e.g. a hand-authored
        # evidence.json read straight with json.load).
        raw = json.loads((FIXTURES / "evidence_demo_scene.json").read_text(encoding="utf-8"))
        priors = geoprior.build_geo_prior(raw)
        assert priors and priors[0].region in ("Denmark", "S-Scandinavia")
