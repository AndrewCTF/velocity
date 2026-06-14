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
# Every entry's layer-id + matrixset + ext was verified against the live GIBS
# WMTS endpoint (a real tile fetch returned 200) — no guessed identifiers.
_LAYERS: dict[str, dict[str, Any]] = {
    # ── Optical, true color (daily) ──────────────────────────────────────
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
    # ── Optical, false color (band combos) ───────────────────────────────
    "MODIS_Terra_CorrectedReflectance_Bands721": {
        "title": "MODIS Terra — Bands 7-2-1 (burn/veg)", "group": "Optical (false-color)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "MODIS_Aqua_CorrectedReflectance_Bands721": {
        "title": "MODIS Aqua — Bands 7-2-1 (burn/veg)", "group": "Optical (false-color)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "MODIS_Terra_CorrectedReflectance_Bands367": {
        "title": "MODIS Terra — Bands 3-6-7 (snow/cloud)", "group": "Optical (false-color)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1": {
        "title": "VIIRS SNPP — M11-I2-I1 (fire/veg)", "group": "Optical (false-color)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1": {
        "title": "VIIRS NOAA-20 — M11-I2-I1 (fire/veg)", "group": "Optical (false-color)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "VIIRS_SNPP_CorrectedReflectance_BandsM3-I3-M11": {
        "title": "VIIRS SNPP — M3-I3-M11 (snow/ice)", "group": "Optical (false-color)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    # ── Active fire / thermal anomalies ──────────────────────────────────
    "VIIRS_NOAA20_Thermal_Anomalies_375m_All": {
        "title": "VIIRS NOAA-20 — Thermal Anomalies", "group": "Thermal",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "png", "max_z": 9,
    },
    # ── Night lights ─────────────────────────────────────────────────────
    "VIIRS_Black_Marble": {
        "title": "Black Marble — Night Lights", "group": "Night",
        "matrixset": "GoogleMapsCompatible_Level8", "ext": "png", "max_z": 8,
    },
    # ── Land / vegetation ────────────────────────────────────────────────
    "MODIS_Terra_NDVI_8Day": {
        "title": "MODIS Terra — NDVI 8-day", "group": "Land/Vegetation",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "png", "max_z": 9,
    },
    "MODIS_Terra_Land_Surface_Temp_Day": {
        "title": "MODIS Terra — Land Surface Temp (day)", "group": "Land/Vegetation",
        "matrixset": "GoogleMapsCompatible_Level7", "ext": "png", "max_z": 7,
    },
    # ── Cryosphere ───────────────────────────────────────────────────────
    "MODIS_Terra_NDSI_Snow_Cover": {
        "title": "MODIS Terra — Snow Cover (NDSI)", "group": "Cryosphere",
        "matrixset": "GoogleMapsCompatible_Level8", "ext": "png", "max_z": 8,
    },
    "MODIS_Terra_Sea_Ice": {
        "title": "MODIS Terra — Sea Ice", "group": "Cryosphere",
        "matrixset": "GoogleMapsCompatible_Level7", "ext": "png", "max_z": 7,
    },
    # ── Ocean / atmosphere ───────────────────────────────────────────────
    "GHRSST_L4_MUR_Sea_Surface_Temperature": {
        "title": "GHRSST — Sea Surface Temperature", "group": "Ocean/Atmosphere",
        "matrixset": "GoogleMapsCompatible_Level7", "ext": "png", "max_z": 7,
    },
    "MODIS_Combined_Value_Added_AOD": {
        "title": "MODIS — Aerosol Optical Depth", "group": "Ocean/Atmosphere",
        "matrixset": "GoogleMapsCompatible_Level6", "ext": "png", "max_z": 6,
    },
    # ── Static base layers ───────────────────────────────────────────────
    "BlueMarble_NextGeneration": {
        "title": "Blue Marble (static)", "group": "Base",
        "matrixset": "GoogleMapsCompatible_Level8", "ext": "jpg", "max_z": 8,
    },
    "BlueMarble_ShadedRelief_Bathymetry": {
        "title": "Blue Marble — Relief + Bathymetry", "group": "Base",
        "matrixset": "GoogleMapsCompatible_Level8", "ext": "jpg", "max_z": 8,
    },
}

# Layers whose TIME dimension is static (no daily snapshot) — the tile_url uses
# 'default' for these so a date in the request never 404s an undated layer.
_STATIC_TIME = {
    "VIIRS_Black_Marble",
    "BlueMarble_NextGeneration",
    "BlueMarble_ShadedRelief_Bathymetry",
}


def catalog() -> list[dict[str, Any]]:
    return [{"id": k, "static": k in _STATIC_TIME, **v} for k, v in _LAYERS.items()]


def layer(layer_id: str) -> dict[str, Any]:
    return _LAYERS[layer_id]


def tile_url(layer_id: str, date: str, z: int, x: int, y: int) -> str:
    meta = _LAYERS[layer_id]  # KeyError on unknown layer (caller maps to 404)
    # Undated layers (Blue Marble, Black Marble) only serve a 'default' TIME —
    # a real date would 404. Dated layers template the requested day.
    time = "default" if layer_id in _STATIC_TIME else date
    return (
        f"{_BASE}/{layer_id}/default/{time}/{meta['matrixset']}"
        f"/{z}/{y}/{x}.{meta['ext']}"
    )
