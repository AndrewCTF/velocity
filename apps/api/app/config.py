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

    # ── commercial-licensing mode ──
    # Velocity ships as a paid SaaS, so the DEPLOYED backend must only touch data
    # sources whose licence permits COMMERCIAL use. When True the source adapters
    # select the commercial-legal set (ADS-B → adsb.lol ODbL; satellite → CDSE
    # Sentinel/Copernicus; basemap → OpenFreeMap/self-host; weather → NWS/NOAA;
    # events → GDELT/EONET) and the non-commercial ones (OpenSky, airplanes.live,
    # EOX cloudless, Esri, Maxar Open Data, Global Fishing Watch, ACLED,
    # Open-Meteo hosted, Planespotters, public Overpass/Nominatim) are OFF.
    # Default False so local dev + the test suite keep the fuller non-commercial
    # sources; the Cloudflare Container sets COMMERCIAL_MODE=1. The gateway also
    # overrides PER REQUEST via the X-Velocity-Tier header (see tier.py): a
    # paying customer is always served the commercial-legal set.
    # See docs/commercial-licensing.md for the full per-source audit.
    commercial_mode: bool = False
    # On a commercial_mode deployment, also serve the non-commercial firehoses
    # to FREE (unentitled) sessions. Off by default: the operator ingesting NC
    # data is itself commercial use, so leave this False unless you accept that.
    allow_nc_for_free: bool = False
    # Commercial-OK raster dark basemap URL template ({z}/{x}/{y}) used when a
    # request is served commercial-legal (CARTO's hosted tiles are enterprise-
    # only). E.g. a self-hosted OpenFreeMap/Protomaps raster renderer or a
    # MapTiler key'd URL. Empty → /tiles/basemap 503s for commercial requests
    # and the client falls back to the satellite layer.
    commercial_basemap_url: str = ""
    # OSM data is ODbL (commercial-OK) but the PUBLIC Overpass/Nominatim
    # instances forbid commercial/heavy use. On a commercial deployment the
    # operator must point these at self-hosted endpoints; left empty, the
    # buildings (LOD1) + geocode/reverse-geocode features are disabled in
    # commercial_mode rather than hit the public instances.
    nominatim_url: str = ""  # e.g. https://nominatim.your-host.tld
    overpass_url: str = ""  # e.g. https://overpass.your-host.tld/api/interpreter

    # ── third-party secrets (NEVER exposed) ──
    opensky_client_id: str = ""
    opensky_client_secret: str = ""
    aisstream_key: str = ""
    # When true AND aisstream_key is set, run the AISStream upstream ALWAYS-ON
    # (global vessel firehose) from boot, instead of only while a browser holds
    # /ws/ais open. AISStream's free tier has a message cap, so this is opt-in —
    # leave it off to keep AISStream on-demand and conserve the budget.
    aisstream_firehose: bool = False  # AISSTREAM_FIREHOSE
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
    # safe to delete at any time — it refills on demand. Self-bounding: once the
    # cache exceeds tile_cache_max_bytes it LRU-evicts oldest tiles back under
    # the cap (see app.tilecache). 0 disables the cap (unbounded growth).
    tile_cache_dir: str = "./data/tilecache"
    tile_cache_max_bytes: int = 1_000_000_000  # ~1 GB; LRU-evicted past this

    # ── server ──
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    log_level: str = "info"
    cors_origins: str = "http://localhost:8080"
    # When set, REST + WS routes require X-API-Key matching this value.
    # When unset (default), no auth — fine for single-analyst localhost.
    api_key: str = ""

    # ── Supabase login gate ──
    # When supabase_url + supabase_anon_key are set, non-public routes also
    # accept a valid Supabase access token (Authorization: Bearer <jwt>, or
    # ?key=<jwt> for WS) — the token the browser gets after signing in, i.e.
    # "the API key you get from Supabase". A static api_key (above) still works
    # in parallel for server/MCP callers. Token validation is LOCAL HS256 when
    # supabase_jwt_secret is set (fast, no round-trip — mirrors the gateway
    # Worker); otherwise a cached call to GoTrue's /auth/v1/user using the anon
    # key. Either supabase_jwt_secret OR (supabase_url + supabase_anon_key) is
    # enough to enable + enforce the gate.
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_jwt_secret: str = ""

    # ── BYOK (bring-your-own-key) ──
    # Symmetric key (Fernet, urlsafe-base64 32 bytes) used to encrypt user API
    # keys at rest in Supabase `public.user_keys`. The plaintext key never lands
    # in the DB — only Fernet ciphertext — so a DB compromise alone can't read
    # them. Generate once: `python -c "from cryptography.fernet import Fernet;
    # print(Fernet.generate_key().decode())"`. When unset, the BYOK routes 503.
    byok_enc_key: str = ""  # BYOK_ENC_KEY

    # ── MCP server + local AI (Ollama) ──
    # The MCP server (app.mcp_server) calls this backend over HTTP and can
    # launch a local Ollama model for deeper, in-the-loop analysis without
    # spending the calling agent's context. All optional; degrade gracefully.
    ollama_host: str = "http://localhost:11434"  # OLLAMA_HOST
    ollama_model: str = ""  # OLLAMA_MODEL ("" → auto-detect smallest installed)
    api_base: str = "http://localhost:8000"  # API_BASE (MCP → backend)

    # ── MiniMax-M3 via NVIDIA NIM (OpenAI-compatible) — PRIMARY reasoning backend ──
    # The analytical tools prefer MiniMax-M3 (a reasoning model) hosted on
    # NVIDIA's integrate endpoint; app.llm tries it first, then DeepSeek, then a
    # local Ollama model. Key resolves from MINIMAX_API_KEY or NVIDIA_API_KEY
    # (the NVIDIA-issued nvapi-… bearer). Never exposed to the browser.
    minimax_api_key: str = ""  # MINIMAX_API_KEY
    nvidia_api_key: str = ""  # NVIDIA_API_KEY (alias for the same NVIDIA endpoint)
    minimax_base_url: str = "https://integrate.api.nvidia.com/v1"  # MINIMAX_BASE_URL
    minimax_model: str = "minimaxai/minimax-m3"  # reasoning model id

    # ── DeepSeek (OpenAI-compatible) — fallback reasoning backend ──
    # Used when MiniMax is unconfigured/unreachable; falls back further to
    # Ollama. When unset, app.llm reads the key + base from the user's opencode
    # config (~/.config/opencode/opencode.jsonc).
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
    # Hard upper bound on the replay store. The hourly maintenance pass time-
    # prunes to history_retention_hours, then if the file is still larger than
    # history_max_bytes it drops the oldest rows until under the cap and
    # VACUUMs to actually return the pages to the filesystem. 48 h of global
    # ADS-B + AIS is ~8 GB, so the byte cap — not the hour window — is the
    # binding limit. 0 disables the byte cap (hour window only).
    history_max_bytes: int = 2_000_000_000  # ~2 GB


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
