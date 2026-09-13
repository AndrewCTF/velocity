"""GET /api/config — runtime config delivered to the browser at boot.

Shape matches packages/shared/src/config.ts (RuntimeConfig). The Cesium ion
token is the only upstream key included. Google Photoreal 3D is feature-flagged
and defaults off (frontend.md §5).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.auth import (
    _auth_enabled,
    _authorized,
    _bearer,
    _locked,
    credential_kind,
    record_auth_failure,
)
from app.config import Settings, get_settings
from app.ratelimit import client_key

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

    A PRESENTED credential goes through the failed-credential lockout like every
    other pathway (ASVS V6.3.1 / V6.3.4): a wrong one counts, and a locked-out
    client gets blanks without the credential being checked, so this route is
    not an unthrottled oracle for the key. It still answers 200 (never 429):
    the browser boots on it. An anonymous read is not a guess and never counts."""
    live = get_settings()
    reveal = True
    if _auth_enabled(live):
        static = request.headers.get("x-api-key")
        token = _bearer(request.headers) or static
        reveal = False
        if token:
            who = client_key(request.client.host if request.client else "", request.headers)
            if _locked(who, live) is None:
                reveal = await _authorized(
                    static, token, live, who=who, path=request.url.path
                )
                if not reveal:
                    record_auth_failure(
                        who, live, "bad-credential", request.url.path, credential_kind(token)
                    )
    return RuntimeConfig(
        cesiumIonToken=settings.cesium_ion_token if reveal else "",
        googleApiKey=settings.gmaps_key if reveal else "",
        features=Features(enableGoogle3D=settings.enable_google_3d),
        classification=settings.classification,
        buildId=settings.build_id,
        openMode=(not _auth_enabled(settings) and settings.allow_unauthenticated),
    )
