import numpy as np

from app.imagery import cdse
from app.intel import sar_vessels


def test_detect_targets_finds_injected_ships():
    rng = np.random.default_rng(0)
    # Calm sea clutter ~ low amplitude; inject 3 bright compact targets.
    img = (rng.random((200, 200)) * 20).astype(np.float32)
    ships = [(40, 50), (120, 160), (170, 30)]
    for r, c in ships:
        img[r - 1 : r + 2, c - 1 : c + 2] = 240
    targets = sar_vessels.detect_targets(img, k=4.0)
    assert len(targets) == 3
    found = {(round(t["row"]), round(t["col"])) for t in targets}
    for r, c in ships:
        assert any(abs(fr - r) <= 1 and abs(fc - c) <= 1 for fr, fc in found)


def test_detect_targets_rejects_pure_clutter():
    rng = np.random.default_rng(1)
    img = (rng.random((200, 200)) * 20).astype(np.float32)
    assert sar_vessels.detect_targets(img, k=5.0) == []


def test_detect_targets_suppresses_large_bright_region():
    rng = np.random.default_rng(2)
    img = (rng.random((200, 200)) * 20).astype(np.float32)
    img[0:96, 0:96] = 240  # land block (16-grid aligned) — suppressed, not a ship
    img[150:153, 150:153] = 240  # a real small ship
    targets = sar_vessels.detect_targets(img, k=4.0)
    assert len(targets) == 1
    assert round(targets[0]["row"]) == 151 and round(targets[0]["col"]) == 151


def test_pixel_lonlat_inverts_forward_projection():
    bbox = cdse.lonlat_bbox_3857(55.9, 26.4, 56.9, 27.1)
    # center pixel of a 100x100 image ~ center of the bbox
    lon, lat = sar_vessels._pixel_lonlat(bbox, 100, 100, 49.5, 49.5)
    assert abs(lon - 56.4) < 0.05
    assert abs(lat - 26.75) < 0.05


def test_epsg3857_roundtrip():
    x, y = cdse.lonlat_to_3857(56.4, 26.75)
    lon, lat = sar_vessels.epsg3857_to_lonlat(x, y)
    assert abs(lon - 56.4) < 1e-6
    assert abs(lat - 26.75) < 1e-6


def test_ais_match_radius():
    vessels = [(56.40, 26.75)]
    assert sar_vessels._ais_match(56.405, 26.752, vessels, 0.02) is True
    assert sar_vessels._ais_match(56.50, 26.95, vessels, 0.02) is False
