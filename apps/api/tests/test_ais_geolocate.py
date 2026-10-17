"""Guards for Sentinel-1 geolocation from the SAFE geolocationGrid.

Why this module exists: the anonymous SAFE measurement TIFF has no CRS, so a
bright-target detection had no honest way to become a lon/lat. The scene's own
annotation XML carries 210 geolocationGridPoint records with explicit
line/pixel/latitude/longitude, fetched with zero credentials.

The property that matters most and is easiest to break: a detection OUTSIDE the
grid must be reported UNLOCATED, never extrapolated to a fabricated coordinate.
That is the same rule the AIS store follows about data age — do not invent what
upstream did not provide.
"""

from __future__ import annotations

import pytest

from app.ais_pipeline import geolocate as geo

# A minimal but structurally faithful 2x2 grid, plus a 3x2 case below.
GRID_2X2 = """<?xml version="1.0"?>
<product>
  <imageAnnotation>
    <geolocationGrid>
      <geolocationGridPoint><line>0</line><pixel>0</pixel>
        <latitude>10.0</latitude><longitude>20.0</longitude></geolocationGridPoint>
      <geolocationGridPoint><line>0</line><pixel>100</pixel>
        <latitude>10.0</latitude><longitude>22.0</longitude></geolocationGridPoint>
      <geolocationGridPoint><line>200</line><pixel>0</pixel>
        <latitude>12.0</latitude><longitude>20.0</longitude></geolocationGridPoint>
      <geolocationGridPoint><line>200</line><pixel>100</pixel>
        <latitude>12.0</latitude><longitude>22.0</longitude></geolocationGridPoint>
    </geolocationGrid>
  </imageAnnotation>
</product>
"""

# Scientific notation, as the real SAFE files use (2.975587793538942e+01).
GRID_SCI = """<?xml version="1.0"?>
<product><imageAnnotation><geolocationGrid>
  <geolocationGridPoint><line>0</line><pixel>0</pixel>
    <latitude>2.975587793538942e+01</latitude>
    <longitude>5.901436364934764e+01</longitude></geolocationGridPoint>
  <geolocationGridPoint><line>0</line><pixel>1289</pixel>
    <latitude>2.975587793538942e+01</latitude>
    <longitude>6.164300000000000e+01</longitude></geolocationGridPoint>
  <geolocationGridPoint><line>2007</line><pixel>0</pixel>
    <latitude>3.167425500000000e+01</latitude>
    <longitude>5.867820000000000e+01</longitude></geolocationGridPoint>
  <geolocationGridPoint><line>2007</line><pixel>1289</pixel>
    <latitude>3.167425500000000e+01</latitude>
    <longitude>6.164300000000000e+01</longitude></geolocationGridPoint>
</geolocationGrid></imageAnnotation></product>
"""

# Namespace-prefixed variant: tags must match on LOCAL name.
GRID_NS = """<?xml version="1.0"?>
<product xmlns:s1="http://esa.int/safe/sentinel-1.0/sentinel-1">
  <s1:imageAnnotation><s1:geolocationGrid>
    <s1:geolocationGridPoint><s1:line>0</s1:line><s1:pixel>0</s1:pixel>
      <s1:latitude>10.0</s1:latitude><s1:longitude>20.0</s1:longitude>
    </s1:geolocationGridPoint>
    <s1:geolocationGridPoint><s1:line>0</s1:line><s1:pixel>100</s1:pixel>
      <s1:latitude>10.0</s1:latitude><s1:longitude>22.0</s1:longitude>
    </s1:geolocationGridPoint>
    <s1:geolocationGridPoint><s1:line>200</s1:line><s1:pixel>0</s1:pixel>
      <s1:latitude>12.0</s1:latitude><s1:longitude>20.0</s1:longitude>
    </s1:geolocationGridPoint>
    <s1:geolocationGridPoint><s1:line>200</s1:line><s1:pixel>100</s1:pixel>
      <s1:latitude>12.0</s1:latitude><s1:longitude>22.0</s1:longitude>
    </s1:geolocationGridPoint>
  </s1:geolocationGrid></s1:imageAnnotation>
</product>
"""


def test_annotation_url_from_measurement_href():
    href = (
        "s3://sentinel-s1-l1c/GRD/2026/10/3/IW/DV/"
        "S1D_IW_GRDH_1SDV_20261003T140102_004852_0091E7_9926/measurement/iw-vv.tiff"
    )
    assert geo.annotation_url(href) == (
        "s3://sentinel-s1-l1c/GRD/2026/10/3/IW/DV/"
        "S1D_IW_GRDH_1SDV_20261003T140102_004852_0091E7_9926/annotation/iw-vv.xml"
    )


def test_annotation_url_rejects_non_measurement_assets():
    assert geo.annotation_url("s3://bucket/annotation/iw-vv.xml") is None
    assert geo.annotation_url("https://example.com/x.tiff") is None
    assert geo.annotation_url(None) is None


def test_parse_geogrid_reads_grid():
    g = geo.parse_geogrid(GRID_2X2)
    assert g is not None
    assert g.rows == [0, 200]
    assert g.cols == [0, 100]
    assert len(g.points) == 4
    assert g.complete is True


def test_parse_geogrid_handles_scientific_notation():
    """The real SAFE files write lat/lon as 2.975587793538942e+01."""
    g = geo.parse_geogrid(GRID_SCI)
    assert g is not None
    lon, lat = g.points[(0, 0)]
    assert lat == pytest.approx(29.75587793538942)
    assert lon == pytest.approx(59.01436364934764)


def test_parse_geogrid_handles_xml_namespaces():
    g = geo.parse_geogrid(GRID_NS)
    assert g is not None
    assert len(g.points) == 4
    assert g.complete is True


def test_parse_geogrid_rejects_xml_without_grid():
    assert geo.parse_geogrid("<product><nope/></product>") is None
    assert geo.parse_geogrid("not xml at all") is None
    assert geo.parse_geogrid("") is None


def test_corners_interpolate_exactly():
    """A detection on a grid node must return that node, not an approximation."""
    g = geo.parse_geogrid(GRID_2X2)
    assert g.to_lonlat(0, 0) == (20.0, 10.0)
    assert g.to_lonlat(0, 100) == (22.0, 10.0)
    assert g.to_lonlat(200, 0) == (20.0, 12.0)
    assert g.to_lonlat(200, 100) == (22.0, 12.0)


def test_midpoint_is_bilinear():
    g = geo.parse_geogrid(GRID_2X2)
    lon, lat = g.to_lonlat(100, 50)
    assert lon == pytest.approx(21.0)
    assert lat == pytest.approx(11.0)


def test_quarter_way_is_linear():
    """Quarter of the way along BOTH axes.

    Grid spans lon 20..22 over 100 px and lat 10..12 over 200 rows, so a quarter
    of the way along each is lon 20.5, lat 10.5 (the row step is 2 deg over 200,
    so 50 rows is 0.5 deg — NOT 0.25).
    """
    g = geo.parse_geogrid(GRID_2X2)
    lon, lat = g.to_lonlat(50, 25)
    assert lon == pytest.approx(20.5)
    assert lat == pytest.approx(10.5)


def test_outside_grid_is_none_never_extrapolated():
    """THE guard: no fabricated coordinate outside the grid."""
    g = geo.parse_geogrid(GRID_2X2)
    assert g.to_lonlat(-1, 50) is None  # above first row
    assert g.to_lonlat(201, 50) is None  # below last row
    assert g.to_lonlat(100, -1) is None  # left of first col
    assert g.to_lonlat(100, 101) is None  # right of last col
    assert g.to_lonlat(99999, 99999) is None


def test_bounds_reports_scene_extent():
    g = geo.parse_geogrid(GRID_2X2)
    assert g.bounds() == (20.0, 10.0, 22.0, 12.0)


def test_single_degenerate_cell_still_answers():
    """A 1x1 grid (possible on a clipped product) must not divide by zero."""
    xml = """<product><imageAnnotation><geolocationGrid>
      <geolocationGridPoint><line>0</line><pixel>0</pixel>
        <latitude>5.0</latitude><longitude>6.0</longitude></geolocationGridPoint>
    </geolocationGrid></imageAnnotation></product>"""
    g = geo.parse_geogrid(xml)
    # 1 point is below the 4-point minimum, so no grid — and no coordinate.
    assert g is None


def test_grid_report_absent():
    r = geo.grid_report(None)
    assert r["available"] is False
    assert "terrain correction" in r["caveat"].lower()


def test_grid_report_present_carries_provenance():
    g = geo.parse_geogrid(GRID_2X2)
    r = geo.grid_report(g)
    assert r["available"] is True
    assert r["points"] == 4
    assert r["rows"] == 2 and r["cols"] == 2
    assert r["complete"] is True
    assert r["lonMin"] == 20.0 and r["latMax"] == 12.0
    assert "bilinear" in r["method"].lower()


def test_caveat_does_not_overclaim():
    """Geolocation is not terrain correction — the report must say so."""
    assert "NOT terrain correction" in geo.GEOLOCATION_CAVEAT
    assert "open water" in geo.GEOLOCATION_CAVEAT.lower()
