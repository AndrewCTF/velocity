"""Stage C1 (cross-view retrieval) tests for the ``search()`` call-site
contract pipeline.py's router depends on (``retrieval.crossview.search(evidence,
priors) -> list[Candidate]``, doc §5/§6).

Fully offline: :func:`reference_photos.fetch_reference_photos` (live
Panoramax/KartaView network) and :func:`crossview.crossview_rank` (needs
torch/transformers/sklearn -- the CUDA sidecar venv ``~/.venv`` per doc §3,
NOT installed in apps/api/.venv, which is what this suite runs under) are
monkeypatched. The point of these tests is the plumbing added around those
two calls: photo-path resolution, prior fan-out, and graceful degradation on
every failure mode -- not the CLIP ranking itself (crossview_rank/_candidate
already have their own coverage responsibility elsewhere and are reused
unchanged, per the integration spec).
"""

from __future__ import annotations

import pytest

from geolocate.contracts import Attributes, Evidence, ExifData, GeoPrior, SceneType
from geolocate.retrieval import crossview

# crossview.py loads reference_photos via a sys.path hack (`import
# reference_photos as rp`), NOT the package-qualified `geolocate.retrieval.
# reference_photos` -- those are two distinct module objects in sys.modules
# even though they're the same file. Monkeypatching must go through
# `crossview.rp` (the module object crossview.py itself calls into) or the
# patch silently misses and the real network path runs instead.
rp = crossview.rp


def _evidence(photo: str = "query.jpg", scene_type: SceneType = SceneType.OPEN) -> Evidence:
    return Evidence(
        photo=photo,
        phash="0" * 16,
        exif=ExifData(),
        scene_type=scene_type,
        caption=None,
        attributes=Attributes(),
        confidence_notes="",
    )


def _prior(region: str = "Denmark", bbox=(8.0, 54.5, 15.2, 57.8), p: float = 0.6) -> GeoPrior:
    return GeoPrior(region=region, bbox=list(bbox), p=p)


def _ref(local_path: str, source: str = "panoramax", lat: float = 55.70, lon: float = 12.50) -> rp.ReferencePhoto:
    return rp.ReferencePhoto(
        id="ref1", source=source, lat=lat, lon=lon, heading=90.0, captured_at="2024",
        thumb_url="", photo_url="", local_path=local_path,
    )


# --------------------------------------------------------------------------- #
# _bbox_center / _resolve_query_path -- pure helpers
# --------------------------------------------------------------------------- #


class TestBboxCenter:
    def test_centroid_of_bbox(self):
        assert crossview._bbox_center((8.0, 54.5, 15.2, 57.8)) == pytest.approx((56.15, 11.6))


class TestResolveQueryPath:
    def test_finds_photo_in_supplied_image_dir(self, tmp_path):
        p = tmp_path / "a.jpg"
        p.write_bytes(b"x")
        assert crossview._resolve_query_path("a.jpg", [tmp_path]) == p

    def test_missing_photo_returns_none(self, tmp_path):
        assert crossview._resolve_query_path("nope.jpg", [tmp_path]) is None

    def test_env_override_is_checked(self, tmp_path, monkeypatch):
        p = tmp_path / "b.jpg"
        p.write_bytes(b"x")
        monkeypatch.setenv("GEOLOC_IMAGE_DIR", str(tmp_path))
        assert crossview._resolve_query_path("b.jpg", None) == p


# --------------------------------------------------------------------------- #
# search() -- graceful degradation on every failure mode (never raises)
# --------------------------------------------------------------------------- #


class TestSearchDegradesGracefully:
    def test_no_priors_returns_empty(self):
        assert crossview.search([_evidence()], []) == []

    def test_no_evidence_returns_empty(self):
        assert crossview.search([], [_prior()]) == []

    def test_unresolvable_query_photo_skips_without_fetching(self, tmp_path, monkeypatch):
        called = {"n": 0}

        def _boom(*a, **k):
            called["n"] += 1
            raise AssertionError("must not fetch references for an unresolvable query photo")

        monkeypatch.setattr(rp, "fetch_reference_photos", _boom)
        out = crossview.search([_evidence("does-not-exist.jpg")], [_prior()], image_dirs=[tmp_path])
        assert out == []
        assert called["n"] == 0

    def test_reference_fetch_exception_degrades_to_empty(self, tmp_path, monkeypatch):
        (tmp_path / "query.jpg").write_bytes(b"fake")

        def _boom(*a, **k):
            raise RuntimeError("network down")

        monkeypatch.setattr(rp, "fetch_reference_photos", _boom)
        out = crossview.search([_evidence("query.jpg")], [_prior()], image_dirs=[tmp_path])
        assert out == []

    def test_empty_references_skips_ranking(self, tmp_path, monkeypatch):
        (tmp_path / "query.jpg").write_bytes(b"fake")
        monkeypatch.setattr(rp, "fetch_reference_photos", lambda *a, **k: [])

        def _boom(*a, **k):
            raise AssertionError("must not call crossview_rank with zero references")

        monkeypatch.setattr(crossview, "crossview_rank", _boom)
        out = crossview.search([_evidence("query.jpg")], [_prior()], image_dirs=[tmp_path])
        assert out == []

    def test_clip_backend_unavailable_degrades_to_empty(self, tmp_path, monkeypatch):
        # Mirrors the real apps/api/.venv environment this suite runs under:
        # torch/transformers/sklearn are not installed there (Stage C1 needs
        # the CUDA sidecar venv, doc §3) -- crossview_rank raising
        # ModuleNotFoundError must degrade, not crash the pipeline.
        (tmp_path / "query.jpg").write_bytes(b"fake")
        (tmp_path / "ref.jpg").write_bytes(b"fake")
        ref = _ref(str(tmp_path / "ref.jpg"))
        monkeypatch.setattr(rp, "fetch_reference_photos", lambda *a, **k: [ref])

        def _boom(*a, **k):
            raise ModuleNotFoundError("No module named 'sklearn'")

        monkeypatch.setattr(crossview, "crossview_rank", _boom)
        out = crossview.search([_evidence("query.jpg")], [_prior()], image_dirs=[tmp_path])
        assert out == []

    def test_wall_clock_budget_stops_further_fetches(self, tmp_path, monkeypatch):
        (tmp_path / "query.jpg").write_bytes(b"fake")
        monkeypatch.setattr(crossview, "_SEARCH_BUDGET_S", 0.0)
        called = {"n": 0}

        def _boom(*a, **k):
            called["n"] += 1
            raise AssertionError("must not fetch once the wall-clock budget is exhausted")

        monkeypatch.setattr(rp, "fetch_reference_photos", _boom)
        out = crossview.search(
            [_evidence("query.jpg")], [_prior(region="A"), _prior(region="B")],
            image_dirs=[tmp_path], top_priors=2,
        )
        assert out == []
        assert called["n"] == 0


# --------------------------------------------------------------------------- #
# search() -- happy path: results convert to the §4 Candidate schema
# --------------------------------------------------------------------------- #


class TestSearchHappyPath:
    def test_ranked_candidates_convert_to_contract_schema_with_honest_ood_flag(self, tmp_path, monkeypatch):
        (tmp_path / "query.jpg").write_bytes(b"fake")
        (tmp_path / "ref.jpg").write_bytes(b"fake")
        ref = _ref(str(tmp_path / "ref.jpg"))
        monkeypatch.setattr(rp, "fetch_reference_photos", lambda *a, **k: [ref])

        fake_result = {
            "candidates": [
                crossview._candidate(ref, cosine=0.81, score=0.9, rank=0, ood=True, margin=0.02, radius_m=300.0)
            ],
            "note": "test fixture",
            "n_refs": 1,
            "ood": True,
        }
        monkeypatch.setattr(crossview, "crossview_rank", lambda *a, **k: fake_result)

        out = crossview.search([_evidence("query.jpg")], [_prior()], image_dirs=[tmp_path])
        assert len(out) == 1
        c = out[0]
        assert c.lat == pytest.approx(55.70)
        assert c.lon == pytest.approx(12.50)
        assert c.sources == ["C1:panoramax"]
        # honest OOD flag surfaced in the §4 `evidence` text (spec: "honest
        # OOD flag in evidence/sources") -- reused unchanged from _candidate().
        assert "OOD-WARNING" in c.evidence

    def test_results_sorted_by_score_descending(self, tmp_path, monkeypatch):
        (tmp_path / "query.jpg").write_bytes(b"fake")
        (tmp_path / "ref.jpg").write_bytes(b"fake")
        ref = _ref(str(tmp_path / "ref.jpg"))
        monkeypatch.setattr(rp, "fetch_reference_photos", lambda *a, **k: [ref])

        low = crossview._candidate(ref, cosine=0.5, score=0.2, rank=1, ood=False, margin=0.1, radius_m=300.0)
        high = crossview._candidate(ref, cosine=0.9, score=0.8, rank=0, ood=False, margin=0.1, radius_m=300.0)
        monkeypatch.setattr(
            crossview, "crossview_rank",
            lambda *a, **k: {"candidates": [low, high], "note": "", "n_refs": 1, "ood": False},
        )

        out = crossview.search([_evidence("query.jpg")], [_prior()], image_dirs=[tmp_path])
        assert [c.score for c in out] == sorted((c.score for c in out), reverse=True)

    def test_multiple_priors_fan_out_and_accumulate(self, tmp_path, monkeypatch):
        (tmp_path / "query.jpg").write_bytes(b"fake")
        (tmp_path / "ref.jpg").write_bytes(b"fake")
        ref = _ref(str(tmp_path / "ref.jpg"))
        monkeypatch.setattr(rp, "fetch_reference_photos", lambda *a, **k: [ref])
        monkeypatch.setattr(
            crossview, "crossview_rank",
            lambda *a, **k: {
                "candidates": [crossview._candidate(ref, 0.8, 0.8, 0, False, 0.1, 300.0)],
                "note": "", "n_refs": 1, "ood": False,
            },
        )
        out = crossview.search(
            [_evidence("query.jpg")],
            [_prior(region="A", p=0.9), _prior(region="B", p=0.5)],
            image_dirs=[tmp_path],
            top_priors=2,
        )
        assert len(out) == 2
