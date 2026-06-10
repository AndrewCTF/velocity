"""Centralized settings.

Every upstream API key lives here — frontend.md §1 / research.md §16:
no third-party key may ever leak to the browser bundle. The ONE exception
is the Cesium ion token, which is intentionally returned via /api/config so
the browser can hand it to CesiumJS at runtime.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── visual / runtime config exposed to the browser ──
    cesium_ion_token: str = ""
    enable_google_3d: bool = False
    classification: str = "UNCLAS"
    build_id: str = "dev"

    # ── third-party secrets (NEVER exposed) ──
    opensky_client_id: str = ""
    opensky_client_secret: str = ""
    aisstream_key: str = ""
    firms_map_key: str = ""
    gfw_token: str = ""
    cdse_client_id: str = ""
    cdse_client_secret: str = ""
    gmaps_key: str = ""
    acled_key: str = ""
    acled_email: str = ""
    cloudflare_token: str = ""
    openaip_key: str = ""

    # ── infra ──
    database_url: str = "postgresql+asyncpg://osint:osint@localhost:5432/osint"
    redis_url: str = "redis://localhost:6379/0"

    # ── server ──
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    log_level: str = "info"
    cors_origins: str = "http://localhost:8080"
    # When set, REST + WS routes require X-API-Key matching this value.
    # When unset (default), no auth — fine for single-analyst localhost.
    api_key: str = ""


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
