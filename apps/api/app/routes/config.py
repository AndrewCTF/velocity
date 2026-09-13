"""GET /api/config — runtime config delivered to the browser at boot.

Shape matches packages/shared/src/config.ts (RuntimeConfig). The Cesium ion
token is the only upstream key included. Google Photoreal 3D is feature-flagged
and defaults off (frontend.md §5).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.auth import _auth_enabled, _authorized, _bearer
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
async def get_config(request: Request, settings: Settings = Depends(get_settings)) -> RuntimeConfig:
    """Public, because the browser needs it before a session exists. The two
    upstream keys it carries are the operator's, so with auth enabled they go
    only to a caller holding a credential (ASVS V13.3.2 / V15.3.1); an
    anonymous caller gets blanks and the web client boots keyless, refetching
    after sign-in. A keyless box is unchanged: there is no credential to hold.
    Not counted toward the failed-credential lockout: this is a read of public
    config, not a guess."""
    live = get_settings()
    reveal = True
    if _auth_enabled(live):
        static = request.headers.get("x-api-key")
        reveal = await _authorized(static, _bearer(request.headers) or static, live)
    return RuntimeConfig(
        cesiumIonToken=settings.cesium_ion_token if reveal else "",
        googleApiKey=settings.gmaps_key if reveal else "",
        features=Features(enableGoogle3D=settings.enable_google_3d),
        classification=settings.classification,
        buildId=settings.build_id,
        openMode=(not _auth_enabled(settings) and settings.allow_unauthenticated),
    )
