"""NASA GIBS WMTS-REST adapter — keyless, date-templated global imagery.

URL: https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{LAYER}/default/{TIME}/{MATRIXSET}/{z}/{y}/{x}.{ext}
EPSG:3857 GoogleMapsCompatible matrix sets align tile z/x/y with Cesium's
web-mercator imagery provider. TIME is YYYY-MM-DD (or 'default'). No API key.
"""

from __future__ import annotations

from typing import Any

_BASE = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"

# id -> display/tiling metadata. matrixset caps the max native zoom per the
# source resolution (250 m/1 km -> Level9; 375 m thermal -> Level9).
_LAYERS: dict[str, dict[str, Any]] = {
    "MODIS_Terra_CorrectedReflectance_TrueColor": {
        "title": "MODIS Terra — True Color", "group": "Optical (daily)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "MODIS_Aqua_CorrectedReflectance_TrueColor": {
        "title": "MODIS Aqua — True Color", "group": "Optical (daily)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "VIIRS_SNPP_CorrectedReflectance_TrueColor": {
        "title": "VIIRS SNPP — True Color", "group": "Optical (daily)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor": {
        "title": "VIIRS NOAA-20 — True Color", "group": "Optical (daily)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "VIIRS_NOAA20_Thermal_Anomalies_375m_All": {
        "title": "VIIRS NOAA-20 — Thermal Anomalies", "group": "Thermal",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "png", "max_z": 9,
    },
}


def catalog() -> list[dict[str, Any]]:
    return [{"id": k, **v} for k, v in _LAYERS.items()]


def layer(layer_id: str) -> dict[str, Any]:
    return _LAYERS[layer_id]


def tile_url(layer_id: str, date: str, z: int, x: int, y: int) -> str:
    meta = _LAYERS[layer_id]  # KeyError on unknown layer (caller maps to 404)
    return (
        f"{_BASE}/{layer_id}/default/{date}/{meta['matrixset']}"
        f"/{z}/{y}/{x}.{meta['ext']}"
    )
