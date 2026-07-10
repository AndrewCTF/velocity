"""Stage A tests. Fully offline/keyless: no network, no model weights, no GPU.
Scene-type thresholds are exercised on synthetic images built by hand so the
expected label is derived from the documented physical reasoning in
forensics.compute_scene_features, not from eyeballing a real photo."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from geolocate import forensics
from geolocate.contracts import SceneType

# --------------------------------------------------------------------------- #
# Synthetic image builders
# --------------------------------------------------------------------------- #


def _flat_image(path, rgb, size=(120, 120), noise=0.0, seed=0):
    """A single flat colour over the whole frame (optionally lightly jittered
    for texture realism -- kept small enough to not cross any threshold)."""
    rng = np.random.default_rng(seed)
    h, w = size[1], size[0]
    arr = np.full((h, w, 3), rgb, dtype=np.float64)
    if noise:
        arr = arr + rng.normal(0, noise * 255, arr.shape)
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB").save(path)
    return path


def _two_band_image(path, rgb_top, rgb_bottom, size=(120, 120), noise=0.0, seed=1):
    """Flat upper-half / lower-half colours -- lets a test target the
    upper-half openness signal directly. dHash only looks at HORIZONTAL
    gradients, so a perfectly flat band has zero horizontal texture and
    hashes to all-zeros regardless of vertical banding -- pass ``noise`` to
    give the image the horizontal texture any real photo has, when a test
    needs its phash to be distinguishable from another synthetic image."""
    h, w = size[1], size[0]
    rng = np.random.default_rng(seed)
    arr = np.zeros((h, w, 3), dtype=np.float64)
    arr[: h // 2, :, :] = rgb_top
    arr[h // 2 :, :, :] = rgb_bottom
    if noise:
        arr = arr + rng.normal(0, noise * 255, arr.shape)
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB").save(path)
    return path


def _split_upper_image(path, rgb_left, rgb_right, rgb_bottom, size=(120, 120)):
    """Upper half split into a dark-left / bright-right patch (simulating a
    branch overhanging one side of frame with open sky beside it) over a
    uniform lower half -- exercises the mean+std openness combination
    documented in compute_scene_features (not brightness alone)."""
    h, w = size[1], size[0]
    arr = np.zeros((h, w, 3), dtype=np.float64)
    arr[: h // 2, : w // 2, :] = rgb_left
    arr[: h // 2, w // 2 :, :] = rgb_right
    arr[h // 2 :, :, :] = rgb_bottom
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(path)
    return path


def _checkerboard_image(path, size=(64, 64), block=8):
    h, w = size[1], size[0]
    yy, xx = np.mgrid[0:h, 0:w]
    pattern = ((xx // block) + (yy // block)) % 2
    arr = np.where(pattern[..., None].astype(bool), 230, 20).astype(np.uint8)
    arr = np.repeat(arr, 3, axis=2)
    Image.fromarray(arr, mode="RGB").save(path)
    return path


# --------------------------------------------------------------------------- #
# Perceptual hash
# --------------------------------------------------------------------------- #


class TestPhash:
    def test_identical_bytes_hash_identical(self, tmp_path):
        p1 = _flat_image(tmp_path / "a1.png", (80, 140, 60))
        p2 = tmp_path / "a2.png"
        p2.write_bytes(p1.read_bytes())  # byte-identical copy
        assert forensics.compute_phash(p1) == forensics.compute_phash(p2)
        assert forensics.hamming_distance(forensics.compute_phash(p1), forensics.compute_phash(p2)) == 0

    def test_robust_to_format_recompression(self, tmp_path):
        # Same content, re-encoded as JPEG (lossy) -- the whole point of a
        # perceptual hash is that this should NOT look like a different photo.
        arr = np.zeros((120, 120, 3), dtype=np.uint8)
        arr[:60, :, :] = (210, 225, 240)
        arr[60:, :, :] = (60, 110, 50)
        png_path = tmp_path / "scene.png"
        Image.fromarray(arr, mode="RGB").save(png_path)
        jpg_path = tmp_path / "scene.jpg"
        Image.fromarray(arr, mode="RGB").save(jpg_path, format="JPEG", quality=85)

        dist = forensics.hamming_distance(forensics.compute_phash(png_path), forensics.compute_phash(jpg_path))
        assert dist <= 4, f"expected near-identical phash across recompression, got distance {dist}"

    def test_distinctly_different_images_have_large_distance(self, tmp_path):
        p1 = _flat_image(tmp_path / "solid.png", (30, 70, 20))
        p2 = _checkerboard_image(tmp_path / "checker.png")
        dist = forensics.hamming_distance(forensics.compute_phash(p1), forensics.compute_phash(p2))
        assert dist > forensics.DEFAULT_DEDUP_THRESHOLD

    def test_hash_length_matches_hash_size(self, tmp_path):
        p = _flat_image(tmp_path / "a.png", (100, 100, 100))
        h = forensics.compute_phash(p, hash_size=8)
        assert len(h) == 16  # 64 bits -> 16 hex chars
        int(h, 16)  # must parse as hex


class TestGroupNearDuplicates:
    def test_exact_duplicate_pair_clusters_together(self):
        hashes = {"a1.jpg": "0" * 16, "a2.jpg": "0" * 16, "c.jpg": "5" * 16}
        groups = forensics.group_near_duplicates(hashes, threshold=10)
        assert sorted(map(sorted, groups)) == [["a1.jpg", "a2.jpg"], ["c.jpg"]]

    def test_near_duplicate_within_threshold_clusters(self):
        b1 = int("f" * 16, 16)
        b2 = b1 ^ 0b111  # 3 bits flipped -> within default threshold of 10
        hashes = {"b1.jpg": format(b1, "016x"), "b2.jpg": format(b2, "016x"), "a.jpg": "0" * 16}
        groups = forensics.group_near_duplicates(hashes, threshold=10)
        assert sorted(map(sorted, groups)) == [["a.jpg"], ["b1.jpg", "b2.jpg"]]

    def test_distance_above_threshold_stays_separate(self):
        hashes = {"a.jpg": "0" * 16, "b.jpg": "f" * 16}
        groups = forensics.group_near_duplicates(hashes, threshold=10)
        assert sorted(map(sorted, groups)) == [["a.jpg"], ["b.jpg"]]

    def test_singleton_set_is_its_own_group(self):
        groups = forensics.group_near_duplicates({"only.jpg": "abc123"}, threshold=10)
        assert groups == [["only.jpg"]]

    def test_empty_input(self):
        assert forensics.group_near_duplicates({}, threshold=10) == []

    def test_three_way_near_dup_chain_merges_transitively(self):
        # a--b within threshold (9 bits), b--c within threshold (9 disjoint
        # bits), but a--c is NOT within threshold directly (18 bits) --
        # union-find must still merge all three into one group via b.
        a = 0
        b = 0x1FF  # bits 0-8 set -> popcount 9
        c = b ^ (0x1FF << 32)  # flips 9 *different* bits -> distance(b,c)=9
        hashes = {"a.jpg": format(a, "016x"), "b.jpg": format(b, "016x"), "c.jpg": format(c, "016x")}
        dist_ab = forensics.hamming_distance(hashes["a.jpg"], hashes["b.jpg"])
        dist_bc = forensics.hamming_distance(hashes["b.jpg"], hashes["c.jpg"])
        dist_ac = forensics.hamming_distance(hashes["a.jpg"], hashes["c.jpg"])
        assert dist_ab == 9 and dist_bc == 9
        assert dist_ac == 18 > 10  # confirms a and c are NOT directly linkable

        groups = forensics.group_near_duplicates(hashes, threshold=10)
        assert groups == [["a.jpg", "b.jpg", "c.jpg"]]


# --------------------------------------------------------------------------- #
# Classical scene features -> scene_type
# --------------------------------------------------------------------------- #


class TestSceneTypeClassification:
    def test_uniform_dark_green_is_canopy_interior(self, tmp_path):
        # Enclosed under leaves from every direction: dim + green-dominated.
        p = _flat_image(tmp_path / "canopy.png", (30, 70, 20), noise=0.01)
        features = forensics.compute_scene_features(p)
        scene_type, rationale = forensics.classify_scene_type(features)
        assert scene_type is SceneType.CANOPY_INTERIOR
        assert "canopy" in rationale.lower() or "enclosed" in rationale.lower()

    def test_bright_sky_over_green_field_is_open(self, tmp_path):
        p = _two_band_image(tmp_path / "open.png", rgb_top=(210, 225, 240), rgb_bottom=(60, 110, 50))
        features = forensics.compute_scene_features(p)
        scene_type, _ = forensics.classify_scene_type(features)
        assert scene_type is SceneType.OPEN

    def test_uniform_dark_beige_is_indoor(self, tmp_path):
        # No vegetation, low texture, no bright sky patch anywhere.
        p = _flat_image(tmp_path / "indoor.png", (90, 85, 80), noise=0.005)
        features = forensics.compute_scene_features(p)
        scene_type, rationale = forensics.classify_scene_type(features)
        assert scene_type is SceneType.INDOOR
        assert features["green_frac"] < 0.08

    def test_moderate_openness_with_green_ground_is_semi_open(self, tmp_path):
        # Grey-blue sky strip (moderate brightness, not blazing) over a green
        # field: not dim enough for canopy, not bright/contrasty enough for open.
        p = _two_band_image(tmp_path / "semi.png", rgb_top=(140, 150, 160), rgb_bottom=(60, 140, 60))
        features = forensics.compute_scene_features(p)
        scene_type, _ = forensics.classify_scene_type(features)
        assert scene_type is SceneType.SEMI_OPEN

    def test_partial_overhang_with_sky_gap_reads_as_open_not_canopy(self, tmp_path):
        # Regression guard for the mean+std openness design: a dark branch
        # patch covering HALF the upper frame, with open sky beside it and an
        # open yard below, must not be misread as canopy_interior just
        # because the upper-half MEAN alone would be middling-dark.
        p = _split_upper_image(
            tmp_path / "overhang.png",
            rgb_left=(25, 45, 20),  # dark branch/leaf silhouette
            rgb_right=(220, 225, 235),  # open sky beside it
            rgb_bottom=(150, 60, 50),  # sunlit wall/yard below
            size=(120, 120),
        )
        features = forensics.compute_scene_features(p)
        scene_type, _ = forensics.classify_scene_type(features)
        assert scene_type is not SceneType.CANOPY_INTERIOR
        assert scene_type in (SceneType.OPEN, SceneType.SEMI_OPEN)

    def test_openness_score_is_mean_plus_std_of_upper_half(self, tmp_path):
        p = _two_band_image(tmp_path / "b.png", rgb_top=(200, 200, 200), rgb_bottom=(10, 10, 10))
        features = forensics.compute_scene_features(p)
        assert features["openness_score"] == pytest.approx(
            features["sky_open_mean"] + features["sky_open_std"], abs=1e-9
        )

    def test_features_dict_has_expected_keys(self, tmp_path):
        p = _flat_image(tmp_path / "x.png", (100, 120, 90))
        features = forensics.compute_scene_features(p)
        for key in (
            "mean_rgb", "std_rgb", "green_frac", "sky_open_mean", "sky_open_std",
            "openness_score", "edge_density", "dominant_colors",
        ):
            assert key in features
        assert len(features["dominant_colors"]) <= 3
        assert all(c.startswith("#") and len(c) == 7 for c in features["dominant_colors"])


# --------------------------------------------------------------------------- #
# EXIF
# --------------------------------------------------------------------------- #


class TestExtractExif:
    def test_no_exif_returns_all_none(self, tmp_path):
        p = _flat_image(tmp_path / "plain.png", (50, 50, 50))
        exif = forensics.extract_exif(p)
        assert exif.gps is None
        assert exif.ts is None
        assert exif.camera is None
        assert exif.orientation is None
        assert exif.focal_length_mm is None

    def test_malformed_file_does_not_raise(self, tmp_path):
        bad = tmp_path / "not_really_an_image.jpg"
        bad.write_bytes(b"this is not image data at all")
        exif = forensics.extract_exif(bad)  # must not raise
        assert exif.gps is None

    def test_gps_camera_datetime_extracted(self, tmp_path):
        from PIL import ExifTags

        im = Image.new("RGB", (32, 32), (100, 150, 80))
        exif = im.getexif()
        exif[ExifTags.Base.Make] = "TestCam"
        exif[ExifTags.Base.Model] = "ModelX"
        exif[ExifTags.Base.Orientation] = 1
        exif[ExifTags.Base.DateTime] = "2024:05:01 12:30:00"
        exif[ExifTags.Base.GPSInfo] = {
            1: "N", 2: (48.0, 51.0, 30.0),
            3: "E", 4: (2.0, 21.0, 3.0),
            5: 0, 6: 35.0,
        }
        path = tmp_path / "geotagged.jpg"
        im.save(path, format="JPEG", exif=exif)

        result = forensics.extract_exif(path)
        assert result.camera == "TestCam ModelX"
        assert result.ts == "2024:05:01 12:30:00"
        assert result.orientation == 1
        assert result.gps is not None
        assert result.gps.lat == pytest.approx(48.0 + 51 / 60 + 30 / 3600, abs=1e-6)
        assert result.gps.lon == pytest.approx(2.0 + 21 / 60 + 3 / 3600, abs=1e-6)
        assert result.gps.alt_m == pytest.approx(35.0, abs=1e-6)

    def test_southern_western_hemisphere_is_negative(self, tmp_path):
        from PIL import ExifTags

        im = Image.new("RGB", (32, 32), (100, 150, 80))
        exif = im.getexif()
        exif[ExifTags.Base.GPSInfo] = {1: "S", 2: (33.0, 55.0, 0.0), 3: "W", 4: (18.0, 25.0, 0.0)}
        path = tmp_path / "sw.jpg"
        im.save(path, format="JPEG", exif=exif)

        result = forensics.extract_exif(path)
        assert result.gps.lat < 0
        assert result.gps.lon < 0


# --------------------------------------------------------------------------- #
# VLM hook (must stay a no-op offline)
# --------------------------------------------------------------------------- #


class TestVlmHookIsOptOutByDefault:
    def test_returns_none_when_unconfigured(self, tmp_path, monkeypatch):
        monkeypatch.delenv("GEOLOCATE_VLM_MODEL", raising=False)
        p = _flat_image(tmp_path / "x.png", (50, 50, 50))
        assert forensics.caption_via_vlm(p) is None

    def test_run_stage_a_without_vlm_flag_never_calls_hook(self, tmp_path, monkeypatch):
        called = {"n": 0}

        def _boom(path):
            called["n"] += 1
            raise AssertionError("caption_via_vlm must not be called when use_vlm=False")

        monkeypatch.setattr(forensics, "caption_via_vlm", _boom)
        p = _flat_image(tmp_path / "x.png", (30, 70, 20))
        ev = forensics.run_stage_a(p, use_vlm=False)
        assert called["n"] == 0
        assert ev.caption is None


# --------------------------------------------------------------------------- #
# Per-photo / batch orchestration
# --------------------------------------------------------------------------- #


class TestRunStageA:
    def test_run_stage_a_produces_valid_evidence(self, tmp_path):
        p = _flat_image(tmp_path / "photo.png", (30, 70, 20))
        ev = forensics.run_stage_a(p)
        assert ev.photo == "photo.png"
        assert len(ev.phash) == 16
        assert ev.scene_type is SceneType.CANOPY_INTERIOR
        assert ev.confidence_notes  # never empty -- always explains itself

    def test_batch_groups_duplicates_across_set(self, tmp_path):
        base = _flat_image(tmp_path / "dup1.png", (30, 70, 20), noise=0.02)
        dup2 = tmp_path / "dup2.png"
        dup2.write_bytes(base.read_bytes())
        other = _two_band_image(tmp_path / "other.png", (210, 225, 240), (60, 110, 50), noise=0.02)

        evidences, groups = forensics.run_stage_a_batch([base, dup2, other])
        assert len(evidences) == 3
        by_name = {e.photo: e for e in evidences}
        assert by_name["dup1.png"].scene_type is SceneType.CANOPY_INTERIOR
        assert by_name["dup2.png"].scene_type is SceneType.CANOPY_INTERIOR
        assert by_name["other.png"].scene_type is SceneType.OPEN

        group_sets = [set(g) for g in groups]
        assert {"dup1.png", "dup2.png"} in group_sets
        assert {"other.png"} in group_sets
        assert len(groups) == 2


# --------------------------------------------------------------------------- #
# Injectable attributes_overrides (any vision model / analyst input, no live
# model call required) -- doc §2 Stage A, "Scene caption + attributes via a
# VLM": this is the offline injection path for that same Attributes shape.
# --------------------------------------------------------------------------- #


class TestAttributesOverrides:
    def test_override_populates_attributes_the_heuristics_cannot_fill(self, tmp_path):
        p = _flat_image(tmp_path / "photo.png", (30, 70, 20))
        overrides = {
            "photo.png": {
                "caption": "A beech forest with a red timber cabin.",
                "attributes": {
                    "biome": "temperate_broadleaf_forest",
                    "architecture": {"material": "red timber"},
                    "vegetation": ["beech", "birch"],
                    "language": "da",
                    "driving_side": "right",
                },
            }
        }
        ev = forensics.run_stage_a(p, attributes_overrides=overrides)
        assert ev.caption == "A beech forest with a red timber cabin."
        assert ev.attributes.biome == "temperate_broadleaf_forest"
        assert ev.attributes.architecture == {"material": "red timber"}
        assert ev.attributes.vegetation == ["beech", "birch"]
        assert ev.attributes.language == "da"
        assert ev.attributes.driving_side == "right"
        assert "attributes_overrides" in ev.confidence_notes.lower() or "overridden" in ev.confidence_notes.lower()

    def test_override_takes_precedence_over_heuristic_biome(self, tmp_path):
        # This is a canopy_interior synthetic image -- the heuristic biome
        # guess would be "forest" (see _heuristic_biome); the override must
        # win.
        p = _flat_image(tmp_path / "canopy.png", (30, 70, 20), noise=0.01)
        ev_no_override = forensics.run_stage_a(p)
        assert ev_no_override.attributes.biome == "forest"

        overrides = {"canopy.png": {"attributes": {"biome": "tropical_rainforest"}}}
        ev = forensics.run_stage_a(p, attributes_overrides=overrides)
        assert ev.attributes.biome == "tropical_rainforest"

    def test_missing_photo_in_overrides_dict_is_a_silent_no_op(self, tmp_path):
        p = _flat_image(tmp_path / "photo.png", (30, 70, 20))
        overrides = {"some-other-photo.png": {"attributes": {"biome": "desert"}}}
        ev = forensics.run_stage_a(p, attributes_overrides=overrides)
        assert ev.attributes.biome != "desert"  # untouched -- falls back to the heuristic
        assert ev.caption is None

    def test_none_overrides_never_breaks_a_run(self, tmp_path):
        p = _flat_image(tmp_path / "photo.png", (30, 70, 20))
        ev = forensics.run_stage_a(p, attributes_overrides=None)
        assert ev.photo == "photo.png"

    def test_composes_with_use_vlm_override_wins(self, tmp_path, monkeypatch):
        p = _flat_image(tmp_path / "photo.png", (30, 70, 20))

        def _fake_vlm(path):
            return {
                "caption": "VLM caption",
                "attributes": {"biome": "vlm_biome", "language": "en", "vegetation": ["oak"]},
            }

        monkeypatch.setattr(forensics, "caption_via_vlm", _fake_vlm)
        overrides = {
            "photo.png": {
                "caption": "override caption",
                "attributes": {"biome": "override_biome", "driving_side": "left"},
            }
        }
        ev = forensics.run_stage_a(p, use_vlm=True, attributes_overrides=overrides)
        # override wins where both set a value (caption, biome) ...
        assert ev.caption == "override caption"
        assert ev.attributes.biome == "override_biome"
        # ... but a VLM-only field (not touched by the override) survives the merge.
        assert ev.attributes.vegetation == ["oak"]
        assert ev.attributes.language == "en"
        assert ev.attributes.driving_side == "left"

    def test_batch_forwards_overrides_per_photo_by_filename(self, tmp_path):
        a = _flat_image(tmp_path / "a.png", (30, 70, 20), noise=0.02)
        b = _two_band_image(tmp_path / "b.png", (210, 225, 240), (60, 110, 50), noise=0.02)
        overrides = {"a.png": {"attributes": {"biome": "boreal_forest"}}}

        evidences, _ = forensics.run_stage_a_batch([a, b], attributes_overrides=overrides)
        by_name = {e.photo: e for e in evidences}
        assert by_name["a.png"].attributes.biome == "boreal_forest"
        assert by_name["b.png"].attributes.biome != "boreal_forest"
