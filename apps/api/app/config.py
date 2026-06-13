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
        # ".env" resolves against the server's CWD (apps/api in local dev,
        # /app in the container); the repo-root path covers running uvicorn
        # from apps/api against the monorepo's single .env. Later entries
        # win on conflicts, real env vars beat both.
        env_file=(".env", "../../.env"),
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
    # Disk tile cache root (basemap / sat / terrain proxies). Grows with use;
    # safe to delete at any time — it refills on demand.
    tile_cache_dir: str = "./data/tilecache"

    # ── server ──
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    log_level: str = "info"
    cors_origins: str = "http://localhost:8080"
    # When set, REST + WS routes require X-API-Key matching this value.
    # When unset (default), no auth — fine for single-analyst localhost.
    api_key: str = ""

    # ── MCP server + local AI (Ollama) ──
    # The MCP server (app.mcp_server) calls this backend over HTTP and can
    # launch a local Ollama model for deeper, in-the-loop analysis without
    # spending the calling agent's context. All optional; degrade gracefully.
    ollama_host: str = "http://localhost:11434"  # OLLAMA_HOST
    ollama_model: str = ""  # OLLAMA_MODEL ("" → auto-detect smallest installed)
    api_base: str = "http://localhost:8000"  # API_BASE (MCP → backend)

    # ── DeepSeek (OpenAI-compatible) — primary reasoning backend ──
    # The analytical tools (deep_analyze, news debias/fact-check) prefer
    # DeepSeek and fall back to Ollama. When unset, app.llm reads the key +
    # base from the user's opencode config (~/.config/opencode/opencode.jsonc).
    deepseek_api_key: str = ""  # DEEPSEEK_API_KEY
    deepseek_base_url: str = ""  # DEEPSEEK_BASE_URL ("" → opencode/default)
    deepseek_model_fast: str = "deepseek-chat"  # extraction / classification
    deepseek_model_reason: str = "deepseek-reasoner"  # judgement / fact-check

    # ── News debias / fact-check engine ──
    # Keyless RSS world feeds; analysis runs through app.llm. All optional.
    news_enabled: bool = True
    news_refresh_sec: int = 600  # backend RSS poll cadence
    news_max_items: int = 400  # cap retained headlines

    # ── Keyless AIS firehose (Kystverket public NMEA stream) ──
    # Norway's Kystverket publishes an anonymous AIS NMEA feed over TCP that
    # needs no key. We decode it and feed the same store + browser broadcast as
    # the (key-gated) AISStream bridge, so vessels appear with zero keys set.
    ais_firehose_enabled: bool = True
    ais_firehose_host: str = "153.44.253.27"
    ais_firehose_port: int = 5631

    # ── Historical playback ──
    # Position history store for 3D replay/scrub. SQLite by default; safe to
    # delete (refills as live data flows). Disable to run fully stateless.
    history_enabled: bool = True
    history_db_path: str = "./data/history.db"
    history_retention_hours: int = 48


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
