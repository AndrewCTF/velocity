"""Round-trip tests for the spec §4 JSON contracts. Pure stdlib -- no images,
no network, always runs offline."""

from __future__ import annotations

from geolocate.contracts import (
    Attributes,
    Candidate,
    Evidence,
    ExifData,
    GeoPrior,
    GpsCoord,
    SceneType,
    SunCue,
    dump_candidates,
    dump_geo_priors,
    load_candidates,
    load_geo_priors,
)


def _sample_evidence(photo: str = "photo1.jpg") -> Evidence:
    return Evidence(
        photo=photo,
        phash="a1b2c3d4e5f60718",
        exif=ExifData(
            gps=GpsCoord(lat=48.8566, lon=2.3522, alt_m=35.0),
            ts="2024:05:01 12:30:00",
            camera="TestCam ModelX",
            orientation=1,
            focal_length_mm=24.0,
        ),
        scene_type=SceneType.OPEN,
        caption="A red barn beside a gravel driveway.",
        attributes=Attributes(
            biome="vegetated_open",
            architecture={"material": "brick"},
            vegetation=["oak"],
            husbandry=["cattle"],
            signage_text=["No Trespassing"],
            language="en",
            driving_side="right",
            sun=SunCue(shadow_az_deg=120.0, solar_elev_deg=45.0),
            terrain_slope="flat",
        ),
        confidence_notes="heuristic: openness high, green_frac moderate.",
    )


class TestEvidenceRoundTrip:
    def test_to_dict_from_dict_roundtrip(self):
        ev = _sample_evidence()
        restored = Evidence.from_dict(ev.to_dict())
        assert restored == ev

    def test_to_json_from_json_roundtrip(self):
        ev = _sample_evidence()
        restored = Evidence.from_json(ev.to_json())
        assert restored == ev

    def test_save_load_roundtrip(self, tmp_path):
        ev = _sample_evidence()
        path = ev.save(tmp_path / "evidence" / "photo1.json")
        assert path.exists()
        restored = Evidence.load(path)
        assert restored == ev

    def test_scene_type_is_json_string_not_enum_repr(self, tmp_path):
        ev = _sample_evidence()
        path = ev.save(tmp_path / "photo1.json")
        text = path.read_text()
        assert '"scene_type": "open"' in text
        assert "SceneType" not in text

    def test_minimal_evidence_no_gps_no_caption_roundtrips(self):
        ev = Evidence(
            photo="stripped.png",
            phash="0000000000000000",
            exif=ExifData(),
            scene_type=SceneType.CANOPY_INTERIOR,
            caption=None,
            attributes=Attributes(),
            confidence_notes="no exif at all",
        )
        restored = Evidence.from_dict(ev.to_dict())
        assert restored == ev
        assert restored.exif.gps is None
        assert restored.caption is None

    def test_from_dict_tolerates_missing_optional_keys(self):
        # Downstream stages should be able to hand back a partial dict (e.g.
        # after editing "attributes") without every field being present.
        d = {
            "photo": "p.jpg",
            "phash": "abc",
            "exif": {},
            "scene_type": "semi_open",
            "confidence_notes": "",
        }
        ev = Evidence.from_dict(d)
        assert ev.caption is None
        assert ev.exif.gps is None
        assert ev.attributes.vegetation == []
        assert ev.scene_type is SceneType.SEMI_OPEN

    def test_all_scene_type_values_round_trip(self):
        for st in SceneType:
            ev = Evidence(
                photo="x.jpg", phash="0" * 16, exif=ExifData(), scene_type=st,
                caption=None, attributes=Attributes(), confidence_notes="",
            )
            assert Evidence.from_dict(ev.to_dict()).scene_type is st


class TestGeoPriorContract:
    def test_dump_load_roundtrip(self, tmp_path):
        priors = [
            GeoPrior(region="Western Europe", bbox=[-5.0, 42.0, 10.0, 52.0], p=0.6, rationale="architecture cue"),
            GeoPrior(region="Central Europe", bbox=[5.0, 45.0, 20.0, 55.0], p=0.4, rationale="vegetation zone"),
        ]
        path = dump_geo_priors(priors, tmp_path / "geo_prior.json")
        restored = load_geo_priors(path)
        assert restored == priors

    def test_bbox_order_preserved(self, tmp_path):
        priors = [GeoPrior(region="r", bbox=[1.0, 2.0, 3.0, 4.0], p=1.0)]
        path = dump_geo_priors(priors, tmp_path / "geo_prior.json")
        restored = load_geo_priors(path)
        assert restored[0].bbox == [1.0, 2.0, 3.0, 4.0]


class TestCandidateContract:
    def test_dump_load_roundtrip(self, tmp_path):
        candidates = [
            Candidate(lat=48.85, lon=2.35, radius_m=500.0, score=0.82, sources=["C2:osm"], evidence="farm tags"),
            Candidate(lat=48.86, lon=2.36, radius_m=250.0, score=0.41, sources=["C1:crossview"], evidence="embed"),
        ]
        path = dump_candidates(candidates, tmp_path / "candidates.json")
        restored = load_candidates(path)
        assert restored == candidates

    def test_defaults_for_sources_and_evidence(self):
        c = Candidate(lat=0.0, lon=0.0, radius_m=100.0, score=0.5)
        assert c.sources == []
        assert c.evidence == ""
        assert Candidate.from_dict(c.to_dict()) == c


def test_json_files_are_pretty_printed_and_stable(tmp_path):
    ev = _sample_evidence()
    path = ev.save(tmp_path / "photo1.json")
    text = path.read_text()
    assert text.endswith("\n")
    assert "\n  " in text  # indented, not minified
