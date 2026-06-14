import numpy as np

from app.fusion import pairs
from app.imagery import cdse


def _stack(sar, opt):
    return {
        "aoi": "dubai",
        "date": "2026-06-14",
        "bbox": cdse.lonlat_bbox_3857(*[55.05, 25.05, 55.30, 25.28]),
        "size": [sar.shape[1], sar.shape[0]],
        "arrays": {"S1_GRD_VV": sar, "S2_L2A_TRUECOLOR": opt},
    }


def test_tile_pairs_counts_and_shapes():
    sar = np.full((512, 512), 100, np.uint8)
    opt = np.full((512, 512, 3), 120, np.uint8)
    items = pairs.tile_pairs(_stack(sar, opt), patch=256, stride=256)
    assert len(items) == 4  # 2x2 grid
    assert items[0]["sar"].shape == (256, 256)
    assert items[0]["optical"].shape == (256, 256, 3)


def test_tile_pairs_drops_nodata_patches():
    sar = np.full((512, 512), 100, np.uint8)
    opt = np.zeros((512, 512, 3), np.uint8)  # all no-data
    opt[0:256, 0:256] = 150  # only the top-left tile has content
    items = pairs.tile_pairs(_stack(sar, opt), patch=256, stride=256)
    assert len(items) == 1
    assert items[0]["row"] == 0 and items[0]["col"] == 0


def test_tile_pairs_alignment_preserved():
    # a marker at the same pixel in both modalities must land at the same
    # in-patch location -> proves the tiler keeps co-registration.
    sar = np.full((256, 256), 50, np.uint8)
    opt = np.full((256, 256, 3), 150, np.uint8)
    sar[100, 120] = 255
    opt[100, 120] = [255, 0, 0]
    items = pairs.tile_pairs(_stack(sar, opt), patch=256, stride=256)
    assert len(items) == 1
    p = items[0]
    assert p["sar"][100, 120] == 255
    assert list(p["optical"][100, 120]) == [255, 0, 0]


def test_tile_pairs_mismatched_grid_raises():
    sar = np.zeros((256, 256), np.uint8)
    opt = np.zeros((128, 128, 3), np.uint8)
    try:
        pairs.tile_pairs(_stack(sar, opt))
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
