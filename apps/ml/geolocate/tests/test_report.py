"""Stage E tests (verification, calibrated confidence, report generation).

Pure stdlib + the repo's app.intel.ontology_local for the writeback tests --
no network, no VLM, no GPU. Run from the repo ROOT:

    OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/ml/geolocate -q

``geolocate`` is put on sys.path by ../conftest.py; ``app.*`` (used only by
the to_ontology tests) is importable because apps/api/.venv has an editable
install of the api package, independent of cwd.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from geolocate import report
from geolocate.contracts import (
    Attributes,
    Candidate,
    Evidence,
    ExifData,
    GeoPrior,
    GpsCoord,
    SceneType,
    SunCue,
)

# --------------------------------------------------------------------------- #
# Synthetic fixtures
# --------------------------------------------------------------------------- #


def _evidence(
    photo: str,
    *,
    scene_type: SceneType = SceneType.CANOPY_INTERIOR,
    gps: GpsCoord | None = None,
    biome: str | None = None,
    terrain_slope: str | None = None,
    vegetation: list[str] | None = None,
    language: str | None = None,
    signage_text: list[str] | None = None,
    driving_side: str | None = None,
    architecture: dict | None = None,
    caption: str = "dense forest interior, no visible landmarks",
    phash: str = "aaaaaaaaaaaaaaaa",
) -> Evidence:
    return Evidence(
        photo=photo,
        phash=phash,
        exif=ExifData(gps=gps, ts=None, camera=None),
        scene_type=scene_type,
        caption=caption,
        attributes=Attributes(
            biome=biome,
            architecture=architecture or {},
            vegetation=vegetation or [],
            husbandry=[],
            signage_text=signage_text or [],
            language=language,
            driving_side=driving_side,
            sun=SunCue(),
            terrain_slope=terrain_slope,
        ),
        confidence_notes="",
    )


def _denmark_forest_evidence() -> list[Evidence]:
    """The actual target scenario (build brief): dense-forest photos that
    scene analysis places in Denmark/S. Scandinavia but that CANNOT be
    splat-localised under canopy. No EXIF (stripped test set, per repo
    invariant), all three photos canopy_interior."""
    return [
        _evidence(
            "img_01.jpg",
            phash="1111111111111111",
            biome="temperate_mixed_forest",
            terrain_slope="gentle",
            vegetation=["scots_pine", "european_beech"],
            caption="pine trunks, needle-litter floor, closed canopy overhead",
        ),
        _evidence(
            "img_02.jpg",
            phash="2222222222222222",
            biome="temperate_mixed_forest",
            terrain_slope="gentle",
            vegetation=["scots_pine"],
            caption="mossy boulder among pines, closed canopy overhead",
        ),
        _evidence(
            "img_03.jpg",
            phash="3333333333333333",
            biome="temperate_mixed_forest",
            terrain_slope="gentle",
            language="da",
            signage_text=["Skovsti"],
            caption="wooden trail waymark reading 'Skovsti' beside a forest path",
        ),
    ]


def _denmark_forest_geo_prior() -> list[GeoPrior]:
    return [
        GeoPrior(
            region="Denmark",
            bbox=[8.0, 54.5, 12.7, 57.8],
            p=0.58,
            rationale="Latin-script trail signage 'Skovsti' (Danish: 'forest trail'), temperate "
            "mixed pine/beech biome, gentle moraine terrain consistent with Danish forestry.",
        ),
        GeoPrior(
            region="Southern Sweden",
            bbox=[11.0, 55.3, 15.0, 59.0],
            p=0.24,
            rationale="Same boreal-temperate biome and forestry management style; language cue "
            "transfers weakly (Scandinavian language family).",
        ),
        GeoPrior(
            region="Northern Germany",
            bbox=[7.5, 52.5, 11.5, 55.0],
            p=0.11,
            rationale="Plausible vegetation match; weaker on the language/signage cue.",
        ),
    ]


def _open_scene_evidence() -> list[Evidence]:
    return [
        _evidence(
            "farm_01.jpg",
            phash="4444444444444444",
            scene_type=SceneType.OPEN,
            biome="vegetated_open",
            terrain_slope="flat",
            architecture={"material": "brick", "roof_type": "gable"},
            driving_side="right",
            caption="red brick farmstead with a gabled roof beside a gravel yard",
        ),
        _evidence(
            "farm_02.jpg",
            phash="5555555555555555",
            scene_type=SceneType.OPEN,
            biome="vegetated_open",
            terrain_slope="flat",
            architecture={"material": "brick", "roof_type": "gable"},
            driving_side="right",
            caption="same farmstead, gable end and driveway visible",
        ),
    ]


def _open_scene_geo_prior() -> list[GeoPrior]:
    return [
        GeoPrior(region="Denmark", bbox=[8.0, 54.5, 12.7, 57.8], p=0.7, rationale="brick gable farmsteads, right-hand driving"),
        GeoPrior(region="Netherlands", bbox=[3.3, 50.7, 7.2, 53.6], p=0.2, rationale="similar brick vernacular"),
    ]


def _open_scene_candidates_coherent() -> list[Candidate]:
    # Two independent stages (C2 OSM + C1 cross-view) converge on ~the same spot.
    return [
        Candidate(lat=56.1000, lon=10.2000, radius_m=150, score=0.81, sources=["C2:osm_overpass"], evidence="building+landuse=farmyard co-occurrence"),
        Candidate(lat=56.1006, lon=10.2004, radius_m=150, score=0.74, sources=["C1:sample4geo"], evidence="top cross-view embedding match"),
        Candidate(lat=56.3000, lon=9.9000, radius_m=150, score=0.30, sources=["C2:osm_overpass"], evidence="weaker secondary match"),
    ]


def _pose_dict() -> dict:
    return {
        "lat": 56.1001,
        "lon": 10.2001,
        "heading_deg": 42.0,
        "reproj_error_px": 3.2,
        "method": "D2:dsm_fallback",
    }


# --------------------------------------------------------------------------- #
# verify_consistency
# --------------------------------------------------------------------------- #


def test_verify_consistency_empty_is_undetermined() -> None:
    result = report.verify_consistency([])
    assert result["coherent"] is None
    assert result["n_points_considered"] == 0
    assert "undetermined" in result["rationale"]


def test_verify_consistency_coherent_cluster() -> None:
    cands = _open_scene_candidates_coherent()[:2]  # the two ~50 m apart
    result = report.verify_consistency(cands)
    assert result["coherent"] is True
    assert result["spread_km"] < 1.0
    assert result["radius_km"] == pytest.approx(1.0)


def test_verify_consistency_scattered() -> None:
    cands = [
        Candidate(lat=56.10, lon=10.20, radius_m=150, score=0.9, sources=["C2:osm"], evidence="a"),
        Candidate(lat=56.60, lon=9.50, radius_m=150, score=0.85, sources=["C2:osm"], evidence="b"),
        Candidate(lat=55.90, lon=10.90, radius_m=150, score=0.80, sources=["C2:osm"], evidence="c"),
    ]
    result = report.verify_consistency(cands)
    assert result["coherent"] is False
    assert result["spread_km"] > 1.0
    assert "EXCEEDS" in result["rationale"]


def test_verify_consistency_single_candidate_trivially_coherent() -> None:
    cands = [Candidate(lat=56.1, lon=10.2, radius_m=150, score=0.5, sources=["C2:osm"], evidence="a")]
    result = report.verify_consistency(cands)
    assert result["coherent"] is True
    assert result["spread_km"] == 0.0


def test_verify_consistency_per_photo_grouping_uses_best_per_photo() -> None:
    # Dict-shaped candidates carrying an optional "photo" attribution (not
    # part of the Candidate dataclass, but the doc-shape fallback this
    # function tolerates): best-per-photo should be picked before spread is
    # measured, ignoring each photo's lower-scored also-rans.
    cands = [
        {"photo": "a.jpg", "lat": 56.1000, "lon": 10.2000, "radius_m": 150, "score": 0.9, "sources": ["C2"], "evidence": "x"},
        {"photo": "a.jpg", "lat": 40.0000, "lon": -3.0000, "radius_m": 150, "score": 0.1, "sources": ["C2"], "evidence": "decoy"},
        {"photo": "b.jpg", "lat": 56.1005, "lon": 10.2003, "radius_m": 150, "score": 0.8, "sources": ["C1"], "evidence": "y"},
    ]
    result = report.verify_consistency(cands)
    assert result["coherent"] is True
    assert result["n_points_considered"] == 2
    assert "photo" in result["rationale"]


# --------------------------------------------------------------------------- #
# calibrate_confidence
# --------------------------------------------------------------------------- #


def test_calibrate_confidence_all_levels_present() -> None:
    conf = report.calibrate_confidence(_open_scene_evidence(), _open_scene_geo_prior(), _open_scene_candidates_coherent())
    assert set(conf.keys()) == {"country", "region", "aoi", "pose"}
    for level in conf.values():
        assert 0.0 <= level["confidence"] <= 1.0
        assert level["evidence_tag"] in report.EVIDENCE_TAGS
        assert isinstance(level["rationale"], str) and level["rationale"]


def test_calibrate_confidence_monotonic_with_agreement() -> None:
    prior = _denmark_forest_geo_prior()
    weak_evidence = [_evidence("img_01.jpg", phash="1111111111111111")]  # no attributes populated
    strong_evidence = _denmark_forest_evidence()  # 3 photos, consistent biome/terrain/vegetation/signage

    weak = report.calibrate_confidence(weak_evidence, prior, [])
    strong = report.calibrate_confidence(strong_evidence, prior, [])

    assert strong["country"]["confidence"] >= weak["country"]["confidence"]
    assert strong["region"]["confidence"] >= weak["region"]["confidence"]
    # the weak case has zero comparable cues -> zero agreement contribution
    assert strong["country"]["confidence"] > weak["country"]["confidence"]


def test_calibrate_confidence_exif_gps_short_circuits_to_proven() -> None:
    ev = [_evidence("img_01.jpg", phash="1111111111111111", gps=GpsCoord(lat=56.05, lon=10.2, alt_m=12.0))]
    conf = report.calibrate_confidence(ev, _denmark_forest_geo_prior(), [])
    assert conf["country"]["evidence_tag"] == "proven"
    assert conf["region"]["evidence_tag"] == "proven"
    assert conf["aoi"]["evidence_tag"] == "proven"
    assert conf["country"]["confidence"] >= 0.9
    assert conf["aoi"]["confidence"] >= 0.9


def test_calibrate_confidence_canopy_forces_low_aoi_even_with_high_score_candidates() -> None:
    ev = _denmark_forest_evidence()  # all 3 photos canopy_interior
    # Give Stage C a suspiciously high score anyway -- the structural gate
    # must suppress AOI confidence regardless of what the raw score says.
    cands = [Candidate(lat=56.10, lon=10.20, radius_m=150, score=0.95, sources=["C2:osm_overpass"], evidence="dubious under-canopy match")]
    conf = report.calibrate_confidence(ev, _denmark_forest_geo_prior(), cands)
    assert conf["aoi"]["confidence"] <= 0.15
    assert conf["aoi"]["evidence_tag"] == "heuristic"
    assert "canopy" in conf["aoi"]["rationale"].lower()
    assert conf["pose"]["confidence"] == 0.0


def test_calibrate_confidence_open_scene_aoi_is_plumbed_unverified() -> None:
    conf = report.calibrate_confidence(_open_scene_evidence(), _open_scene_geo_prior(), _open_scene_candidates_coherent())
    assert conf["aoi"]["evidence_tag"] == "plumbed-unverified"
    assert conf["aoi"]["confidence"] > 0.3
    assert conf["aoi"]["label"] is not None


def test_calibrate_confidence_pose_reflects_reprojection_error() -> None:
    conf_good = report.calibrate_confidence(_open_scene_evidence(), _open_scene_geo_prior(), _open_scene_candidates_coherent(), pose={"reproj_error_px": 1.0, "method": "D1:splat"})
    conf_bad = report.calibrate_confidence(_open_scene_evidence(), _open_scene_geo_prior(), _open_scene_candidates_coherent(), pose={"reproj_error_px": 45.0, "method": "D1:splat"})
    assert conf_good["pose"]["confidence"] > conf_bad["pose"]["confidence"]
    assert conf_good["pose"]["evidence_tag"] == "plumbed-unverified"


def test_calibrate_confidence_handles_totally_empty_input() -> None:
    conf = report.calibrate_confidence([], [], [])
    for level in conf.values():
        assert level["confidence"] == 0.0
        assert level["evidence_tag"] == "heuristic"
        assert level["label"] is None


# --------------------------------------------------------------------------- #
# write_report -- Denmark-forest scenario (the build's target honesty case)
# --------------------------------------------------------------------------- #


def test_write_report_denmark_forest_is_honest_about_aoi(tmp_path) -> None:
    out = report.write_report(tmp_path, _denmark_forest_evidence(), _denmark_forest_geo_prior(), [], pose=None)
    md = (tmp_path / "geo_assessment.md").read_text(encoding="utf-8")

    # structural ordering: Verdict -> Evidence -> Honest limits -> Method to go finer
    assert md.index("## Verdict") < md.index("## Evidence") < md.index("## Honest limits") < md.index("## Method to go finer")
    for header in ("### Country", "### Region", "### AOI", "### Pose"):
        assert header in md

    conf = out["confidence"]
    # strong-ish country/region verdict, never overclaimed
    assert conf["country"]["label"] == "Denmark"
    assert 0.3 < conf["country"]["confidence"] < 0.93
    assert conf["country"]["evidence_tag"] == "plumbed-unverified"
    # AOI is honestly empty/low, and the report says why
    assert conf["aoi"]["confidence"] <= 0.15
    assert conf["aoi"]["evidence_tag"] == "heuristic"
    assert "canopy" in md.lower() and "physics" in md.lower()
    # pose was not attempted, and the report explains the router logic
    assert conf["pose"]["confidence"] == 0.0
    assert "not attempted" in md.lower() or "reference-image" in md.lower()
    # the concrete "go finer" method is present and specific
    assert "reference-image" in md.lower() or "cross-match" in md.lower()
    # per-photo file refs
    for photo in ("img_01.jpg", "img_02.jpg", "img_03.jpg"):
        assert photo in md
        assert f"evidence/{photo}.json" in md


def test_write_report_geojson_validates_denmark_forest(tmp_path) -> None:
    report.write_report(tmp_path, _denmark_forest_evidence(), _denmark_forest_geo_prior(), [], pose=None)
    gj = json.loads((tmp_path / "result.geojson").read_text(encoding="utf-8"))
    _assert_valid_geojson(gj)
    assert gj["type"] == "FeatureCollection"
    kinds = [f["properties"]["kind"] for f in gj["features"]]
    assert kinds.count("geo_prior_region") == 3  # one polygon per prior region
    assert "candidate_aoi" not in kinds  # no candidates in this run
    assert "pose" not in kinds


def test_write_report_open_scene_includes_candidate_and_pose_features(tmp_path) -> None:
    report.write_report(
        tmp_path,
        _open_scene_evidence(),
        _open_scene_geo_prior(),
        _open_scene_candidates_coherent(),
        pose=_pose_dict(),
    )
    gj = json.loads((tmp_path / "result.geojson").read_text(encoding="utf-8"))
    _assert_valid_geojson(gj)
    kinds = [f["properties"]["kind"] for f in gj["features"]]
    assert kinds.count("candidate_aoi") == 3
    assert kinds.count("pose") == 1
    cand_feats = [f for f in gj["features"] if f["properties"]["kind"] == "candidate_aoi"]
    assert all("score" in f["properties"] and "confidence_aoi" in f["properties"] for f in cand_feats)
    pose_feat = next(f for f in gj["features"] if f["properties"]["kind"] == "pose")
    assert pose_feat["geometry"]["type"] == "Point"
    assert pose_feat["properties"]["confidence_pose"] > 0.0

    md = (tmp_path / "geo_assessment.md").read_text(encoding="utf-8")
    assert "farm_01.jpg" in md and "farm_02.jpg" in md


def test_write_alias_matches_pipeline_call_site_contract(tmp_path) -> None:
    """pipeline.py's documented call site: report.write(evidence, groups,
    router, priors, candidates, outdir) -> Path."""
    path = report.write(
        _denmark_forest_evidence(),
        [["img_01.jpg"], ["img_02.jpg"], ["img_03.jpg"]],  # dedup groups (unused by the adapter)
        {},  # router decisions (unused by the adapter)
        _denmark_forest_geo_prior(),
        [],
        tmp_path,
    )
    assert path == tmp_path / "geo_assessment.md"
    assert path.exists()
    assert (tmp_path / "result.geojson").exists()


def _assert_valid_geojson(gj: dict) -> None:
    assert gj.get("type") == "FeatureCollection"
    assert isinstance(gj.get("features"), list)
    for feat in gj["features"]:
        assert feat.get("type") == "Feature"
        geom = feat.get("geometry")
        assert geom is not None
        assert geom.get("type") in ("Point", "Polygon")
        coords = geom.get("coordinates")
        assert isinstance(coords, list) and coords
        if geom["type"] == "Point":
            lon, lat = coords
            assert isinstance(lon, (int, float)) and isinstance(lat, (int, float))
            assert -180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0
        else:  # Polygon
            ring = coords[0]
            assert len(ring) >= 4 and ring[0] == ring[-1]
            for lon, lat in ring:
                assert -180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0
        assert isinstance(feat.get("properties"), dict)


# --------------------------------------------------------------------------- #
# to_ontology -- optional local-ontology writeback
# --------------------------------------------------------------------------- #


def test_to_ontology_noop_without_registry() -> None:
    result = asyncio.run(report.to_ontology(None, _open_scene_evidence(), _open_scene_candidates_coherent()))
    assert result["written"] is False
    assert result["reason"]
    assert result["photo_ids"] == []


def test_to_ontology_noop_without_candidate_aoi() -> None:
    from app.config import Settings
    from app.intel import ontology_local
    from app.intel.ontology import get_registry
    from app.keys import UserCtx

    result_holder: dict = {}

    def run(tmp_path) -> None:
        ontology_local.override_db_path(str(tmp_path / "onto.db"))
        try:
            reg = get_registry(UserCtx("local", ""), Settings(supabase_url=""))
            result_holder["result"] = asyncio.run(
                report.to_ontology(reg, _denmark_forest_evidence(), [])  # no candidates -> no AOI to mint
            )
        finally:
            ontology_local.override_db_path(None)

    import tempfile
    from pathlib import Path as _P

    with tempfile.TemporaryDirectory() as d:
        run(_P(d))

    result = result_holder["result"]
    assert result["written"] is False
    assert "no candidate aoi" in result["reason"].lower()


def test_to_ontology_writes_real_rows_and_links_photo_to_place(tmp_path) -> None:
    """Proves the writeback is a real SQLite round-trip, not a mock: mirrors
    apps/api/tests/test_ontology_local.py's isolation pattern (override_db_path
    on a per-test temp DB)."""
    from app.config import Settings
    from app.intel import ontology_local
    from app.intel.ontology import get_registry
    from app.keys import UserCtx

    ontology_local.override_db_path(str(tmp_path / "onto.db"))
    try:
        reg = get_registry(UserCtx("local", ""), Settings(supabase_url=""))
        ev = _open_scene_evidence()
        cands = _open_scene_candidates_coherent()

        result = asyncio.run(report.to_ontology(reg, ev, cands))
        assert result["written"] is True
        assert result["place_id"] is not None
        assert len(result["photo_ids"]) == len(ev)

        async def check() -> None:
            for photo_id, e in zip(result["photo_ids"], ev, strict=True):
                obj = await reg.get(photo_id)
                assert obj is not None
                assert obj.props["kind"] == "photo"
                assert obj.props["phash"] == e.phash

            place = await reg.get(result["place_id"])
            assert place is not None
            assert place.props["kind"] == "place"

            around = await reg.traverse(result["photo_ids"][0], depth=1)
            rels = [(lk.src, lk.dst, lk.rel) for lk in around.links]
            assert (result["photo_ids"][0], result["place_id"], "located_at") in rels

        asyncio.run(check())
    finally:
        ontology_local.override_db_path(None)
