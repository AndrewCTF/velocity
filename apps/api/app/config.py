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

    # ── Keyless full-feed ADS-B (readsb / tar1090 aircraft.json) ──
    # Several aggregators run an OPEN global readsb/tar1090 instance that serves
    # its FULL aircraft set as aircraft.json with no key and no Cloudflare block
    # — the "tar1090 way" to get all the data. Unioned with OpenSky into the
    # global snapshot, deduped by icao24. Point this at YOUR own ultrafeeder /
    # tar1090 (sdr-enthusiasts Docker stack) to fold in its coverage too.
    # Comma-separated. To avoid rate-limiting any single host we pull ONE feed
    # per cycle, round-robin, every adsb_feed_interval_s — so with 2 feeds each
    # host is hit only once per ~60 s. Recent per-feed slices are kept + unioned
    # between pulls; OpenSky (15 s) still carries breadth, so the slow feed
    # cadence only affects the EXTRA aircraft these feeds add.
    adsb_feed_urls: str = (
        "https://globe.theairtraffic.com/data/aircraft.json,"
        "https://skylink.hpradar.com/data/aircraft.json,"
        "https://api.adsb.lol/v2/point/0/0/20000"  # ADSBx-v2 'ac' key, ~12.5k global
    )
    # Per-feed poll cadence. Full readsb aircraft.json MIRRORS are CDN-ish files
    # refreshed ~1 s (tar1090 itself polls them ~1 s), so polling each every
    # adsb_feed_interval_s is gentle AND keeps positions fresh — stale fixes are
    # what make tracked aircraft jump. Rate-limit-sensitive /v2 APIs (adsb.lol)
    # use the slow interval; a localhost sidecar uses the fast one.
    adsb_feed_interval_s: float = 5.0  # full aircraft.json mirrors
    adsb_feed_slow_interval_s: float = 20.0  # /v2 + /re-api APIs (rate-limited)
    adsb_feed_fast_interval_s: float = 2.0  # localhost sidecar (no limit)

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
    # Extra keyless regional AIS: Norway Kystdatahuset (REST GeoJSON poll) and
    # Finland Digitraffic (live MQTT-over-WSS). Both feed the same /ws/ais layer.
    ais_kystdatahuset_enabled: bool = True
    ais_kystdatahuset_interval_s: float = 60.0
    ais_digitraffic_mqtt_enabled: bool = True
    # Digitraffic /locations serves the LAST-KNOWN position of every vessel it
    # has ever seen — ~86% are fixes months/years old (decommissioned, scrapped,
    # or long out of coverage). An in-commission vessel keeps an AIS transponder
    # ON and reports every few minutes even at anchor, so last-report recency is
    # the only reliable "still in commission" proxy. Drop fixes older than this
    # so the map shows live + parked-but-transmitting vessels, not ghost ships.
    # 24h keeps anchored/slow reporters while cutting the multi-year dead. Set to
    # 0 to disable the filter and serve every last-known position.
    digitraffic_max_fix_age_s: float = 86400.0

    # ── Historical playback ──
    # Position history store for 3D replay/scrub. SQLite by default; safe to
    # delete (refills as live data flows). Disable to run fully stateless.
    history_enabled: bool = True
    history_db_path: str = "./data/history.db"
    history_retention_hours: int = 48


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
