import pytest

from app.imagery import gibs


def test_catalog_has_known_layers():
    ids = {layer["id"] for layer in gibs.catalog()}
    assert "MODIS_Terra_CorrectedReflectance_TrueColor" in ids
    assert "VIIRS_NOAA20_CorrectedReflectance_TrueColor" in ids


def test_tile_url_true_color():
    url = gibs.tile_url(
        "MODIS_Terra_CorrectedReflectance_TrueColor", "2026-06-10", 3, 4, 2
    )
    assert url == (
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/"
        "MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-06-10/"
        "GoogleMapsCompatible_Level9/3/2/4.jpg"
    )


def test_tile_url_unknown_layer_raises():
    with pytest.raises(KeyError):
        gibs.tile_url("NoSuchLayer", "2026-06-10", 0, 0, 0)


def test_ext_and_format_per_layer():
    tc = gibs.layer("MODIS_Terra_CorrectedReflectance_TrueColor")
    assert tc["ext"] == "jpg"
    th = gibs.layer("VIIRS_NOAA20_Thermal_Anomalies_375m_All")
    assert th["ext"] == "png"
