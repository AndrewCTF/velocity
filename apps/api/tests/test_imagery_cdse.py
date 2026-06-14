import math

import pytest

from app.imagery import cdse


def test_tile_bbox_world():
    bbox = cdse.tile_bbox_3857(0, 0, 0)
    o = math.pi * 6378137.0
    assert bbox == pytest.approx([-o, -o, o, o])


def test_tile_bbox_top_left_quadrant():
    # z1 tile (0,0) is the NW quadrant: x in [-o,0], y in [0,o]
    o = math.pi * 6378137.0
    minx, miny, maxx, maxy = cdse.tile_bbox_3857(1, 0, 0)
    assert minx == pytest.approx(-o)
    assert maxx == pytest.approx(0.0)
    assert maxy == pytest.approx(o)
    assert miny == pytest.approx(0.0)


def test_process_body_optical_has_mosaicking():
    body = cdse.build_process_body("S2_L2A_TRUECOLOR", [0, 0, 100, 100], 256, 256, "2026-06-10")
    data = body["input"]["data"][0]
    assert data["type"] == "sentinel-2-l2a"
    assert data["dataFilter"]["mosaickingOrder"] == "leastCC"
    assert "from" in data["dataFilter"]["timeRange"]
    assert body["output"]["responses"][0]["format"]["type"] == "image/jpeg"
    assert body["input"]["bounds"]["properties"]["crs"].endswith("EPSG/0/3857")


def test_process_body_sar_no_mosaicking_png():
    body = cdse.build_process_body("S1_GRD_VV", [0, 0, 100, 100], 256, 256, "2026-06-10")
    data = body["input"]["data"][0]
    assert data["type"] == "sentinel-1-grd"
    assert "mosaickingOrder" not in data["dataFilter"]
    assert body["output"]["responses"][0]["format"]["type"] == "image/png"


def test_catalog_gated_on_creds(monkeypatch):
    monkeypatch.setattr(cdse, "available", lambda: False)
    assert cdse.catalog() == []
    monkeypatch.setattr(cdse, "available", lambda: True)
    ids = {layer["id"] for layer in cdse.catalog()}
    assert {"S2_L2A_TRUECOLOR", "S1_GRD_VV"} <= ids
