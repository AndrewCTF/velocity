"""GET /api/config — runtime config delivered to the browser at boot.

Shape matches packages/shared/src/config.ts (RuntimeConfig). The Cesium ion
token is the only upstream key included. Google Photoreal 3D is feature-flagged
and defaults off (frontend.md §5).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.auth import _auth_enabled
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
    # True when this box is keyless AND ALLOW_UNAUTHENTICATED is on — i.e. the
    # compute/LLM endpoints are served to anyone. The UI shows an open-mode
    # banner so an operator is never surprised that a public box spends compute.
    open_mode: bool = Field(False, alias="openMode")

    model_config = {"populate_by_name": True}


@router.get("/api/config", response_model=RuntimeConfig, response_model_by_alias=True)
def get_config(settings: Settings = Depends(get_settings)) -> RuntimeConfig:
    return RuntimeConfig(
        cesiumIonToken=settings.cesium_ion_token,
        googleApiKey=settings.gmaps_key,
        features=Features(enableGoogle3D=settings.enable_google_3d),
        classification=settings.classification,
        buildId=settings.build_id,
        openMode=(not _auth_enabled(settings) and settings.allow_unauthenticated),
    )
