"""EUSI keyless connector + satellite→splat wiring — pure-logic checks (no net/GPU)."""
from app import eusi


def test_f_parse():
    assert eusi._f("0.48") == 0.48
    assert eusi._f(None) is None
    assert eusi._f("not-a-number") is None


def test_rank_low_cloud_then_fine_res_first():
    scenes = [
        {"browserUrl": "a", "stripCloudCoverage": "0.5", "productResolution": "0.3"},
        {"browserUrl": "b", "stripCloudCoverage": "0.0", "productResolution": "0.9"},
        {"browserUrl": "c", "stripCloudCoverage": "0.0", "productResolution": "0.3"},
        {"catalogID": "no-browse"},  # dropped: no browserUrl
    ]
    ranked = eusi._rank(scenes)
    assert [s["browserUrl"] for s in ranked] == ["c", "b", "a"]
    assert all("browserUrl" in s for s in ranked)


def test_splat_route_and_recon_mode_wired():
    from app.routes import imagery, recon

    paths = {getattr(r, "path", "") for r in imagery.router.routes}
    assert "/api/imagery/splat" in paths
    # single-image MapAnything path is reachable from the recon job machinery
    assert hasattr(recon, "register_image_job")
    assert hasattr(recon, "_pipeline_mapany")
