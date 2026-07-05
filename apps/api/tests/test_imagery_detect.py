"""imagery.detect pixel→geo mapping (deterministic, no network/GPU)."""

from __future__ import annotations

from app.imagery import cdse, detect


def test_pixel_to_lonlat_corners() -> None:
    # AOI lon [0,10], lat [0,10] → its 3857 bbox.
    bbox3857 = cdse.lonlat_bbox_3857(0.0, 0.0, 10.0, 10.0)

    # top-left pixel (0,0) → NW corner (min lon, max lat).
    lon, lat = detect.pixel_to_lonlat(bbox3857, 0.0, 0.0)
    assert abs(lon - 0.0) < 1e-6
    assert abs(lat - 10.0) < 1e-6

    # bottom-right pixel (1,1) → SE corner (max lon, min lat).
    lon, lat = detect.pixel_to_lonlat(bbox3857, 1.0, 1.0)
    assert abs(lon - 10.0) < 1e-6
    assert abs(lat - 0.0) < 1e-6

    # horizontal centre → mid longitude (linear in x).
    lon, _ = detect.pixel_to_lonlat(bbox3857, 0.5, 0.5)
    assert abs(lon - 5.0) < 1e-6


def test_roundtrip_3857() -> None:
    x, y = cdse.lonlat_to_3857(12.5, 41.9)  # Rome
    lon, lat = detect._3857_to_lonlat(x, y)
    assert abs(lon - 12.5) < 1e-6
    assert abs(lat - 41.9) < 1e-6


def test_chip_px_bounds() -> None:
    bbox = cdse.lonlat_bbox_3857(0.0, 0.0, 1.0, 1.0)  # near-square
    w, h = detect._chip_px(bbox)
    assert detect._MIN_PX <= w <= detect._MAX_PX
    assert detect._MIN_PX <= h <= detect._MAX_PX
