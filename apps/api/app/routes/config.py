"""GET /api/config — runtime config delivered to the browser at boot.

Shape matches packages/shared/src/config.ts (RuntimeConfig). The Cesium ion
token is the only upstream key included. Google Photoreal 3D is feature-flagged
and defaults off (frontend.md §5).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.config import Settings, get_settings

router = APIRouter(tags=["config"])


class Features(BaseModel):
    enable_google3_d: bool = Field(..., alias="enableGoogle3D")

    model_config = {"populate_by_name": True}


class RuntimeConfig(BaseModel):
    cesium_ion_token: str = Field(..., alias="cesiumIonToken")
    # Google Maps key for global Photorealistic 3D Tiles (browser-side, referrer-restricted).
    google_api_key: str = Field("", alias="googleApiKey")
    features: Features
    classification: str
    build_id: str = Field(..., alias="buildId")

    model_config = {"populate_by_name": True}


@router.get("/api/config", response_model=RuntimeConfig, response_model_by_alias=True)
def get_config(settings: Settings = Depends(get_settings)) -> RuntimeConfig:
    return RuntimeConfig(
        cesiumIonToken=settings.cesium_ion_token,
        googleApiKey=settings.gmaps_key,
        features=Features(enableGoogle3D=settings.enable_google_3d),
        classification=settings.classification,
        buildId=settings.build_id,
    )
