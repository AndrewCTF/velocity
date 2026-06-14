import numpy as np

from app.fusion import ingest
from app.imagery import cdse


def test_grid_lonlat_center_matches_aoi():
    aoi = ingest.AOIS["dubai"]
    bbox = cdse.lonlat_bbox_3857(*aoi)
    lon, lat = ingest.grid_lonlat(bbox, 100, 100, 49.5, 49.5)
    cx = (aoi[0] + aoi[2]) / 2
    cy = (aoi[1] + aoi[3]) / 2
    assert abs(lon - cx) < 0.01
    assert abs(lat - cy) < 0.01


def test_alignment_offset_zero_for_identical():
    rng = np.random.default_rng(0)
    a = rng.random((128, 128)).astype(np.float32)
    a[40:80, 40:80] += 2.0  # structure for the gradient signal
    assert ingest.alignment_offset(a, a) == (0, 0)


def test_alignment_offset_recovers_known_shift():
    rng = np.random.default_rng(1)
    a = rng.random((128, 128)).astype(np.float32)
    a[30:90, 50:60] += 3.0  # a strong edge feature
    b = np.roll(a, shift=(4, 7), axis=(0, 1))
    dy, dx = ingest.alignment_offset(a, b)
    assert (abs(dy), abs(dx)) == (4, 7)


def test_alignment_report_structure():
    rng = np.random.default_rng(2)
    ref = rng.random((64, 64)).astype(np.float32)
    ref[20:40, 20:40] += 2.0
    other = np.roll(ref, shift=(0, 0), axis=(0, 1))
    stack = {
        "arrays": {"S2_L2A_TRUECOLOR": ref, "S1_GRD_VV": other},
    }
    rep = ingest.alignment_report(stack)
    assert rep["reference"] == "S2_L2A_TRUECOLOR"
    assert rep["offsets"]["S1_GRD_VV"] == (0, 0)
