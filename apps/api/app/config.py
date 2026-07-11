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
    # Kill switch for the OpenSky breadth tier (env OPENSKY_ENABLED=0). When off,
    # `_opensky_cached` serves nothing and never kicks a pull — the snapshot rides
    # the sidecar + feeds + grid alone. Left ON by default; disable temporarily
    # without ripping out the OpenSky code path.
    opensky_enabled: bool = True
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
    adsb_feed_fast_interval_s: float = 1.0  # localhost sidecar (no limit)
    # Sidecar-only mode. The headless-browser tar1090 sidecar (:8090, started by
    # app.adsb_sidecar) runs REAL tar1090 against globe.airplanes.live +
    # globe.adsbexchange and reads its decoded store — the only form of tar1090's
    # direct method reachable from a datacenter IP (the binary re-api is
    # Cloudflare-403, measured). It's the freshest + biggest single path
    # (~18k aircraft, position age p50 ~0.4 s), so when this is on the snapshot is
    # served from the sidecar ALONE: the remote readsb mirrors are dropped from the
    # pull list (less event-loop load = fresher) and OpenSky/firehose/grid run only
    # as an automatic backfill if the sidecar union ever falls below ~8000 (a
    # Chromium crash) so the map can't go empty. Default off keeps the multi-tier
    # union for deploys without a sidecar; the local .env sets ADSB_SIDECAR_ONLY=1.
    adsb_sidecar_only: bool = False

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
    cors_origins: str = (
        "http://localhost:8080,http://127.0.0.1:8080,"
        "http://localhost:5173,http://127.0.0.1:5173,"
        "tauri://localhost,http://tauri.localhost,https://tauri.localhost"
    )
    # When set, REST + WS routes require X-API-Key matching this value.
    # When unset (default), no auth — fine for single-analyst localhost.
    api_key: str = ""

    # ── open-mode opt-in (issue #8) ──
    # When NO credential is configured (api_key + Supabase all empty) the box is
    # "keyless". Keyless DATA layers (ADS-B, AIS, quakes, basemap, …) must keep
    # working — that is a product invariant. But the COST/COMPUTE endpoints
    # (hosted-LLM analysis, GPU/CPU recon, OSINT recon, imagery-detect) spend
    # money and hardware, so on an unconfigured box they FAIL CLOSED (503) unless
    # the operator explicitly opts into open mode by setting this True — mirroring
    # how /mcp already fails closed. Set ALLOW_UNAUTHENTICATED=1 on a trusted
    # local/dev box (or CI) to serve those endpoints keyless. With any credential
    # configured this flag is irrelevant (auth is enforced normally).
    allow_unauthenticated: bool = False  # ALLOW_UNAUTHENTICATED

    # ── inbound rate limiting (issue #9) ──
    # Per-client sliding-window cap on the cost/compute endpoints (LLM, recon,
    # osint, imagery-detect). Bounds runaway loops and unauthenticated abuse of
    # paid inference / GPU time. 0 disables the limiter entirely.
    ratelimit_compute_per_min: int = 60  # RATELIMIT_COMPUTE_PER_MIN (0 = off)
    # Hard ceiling on concurrently-running recon jobs; further POSTs get 429.
    recon_max_active_jobs: int = 4  # RECON_MAX_ACTIVE_JOBS

    # ── recon job retention (issue #14) ──
    # Recon jobs (in-memory records + on-disk artifact dirs under .recon_jobs/)
    # are evicted oldest-first once either bound is exceeded, so a long-running
    # box does not leak memory + disk without bound. 0 disables that bound.
    recon_max_jobs: int = 40  # RECON_MAX_JOBS (LRU by created; 0 = unbounded)
    recon_job_ttl_s: int = 86_400  # RECON_JOB_TTL_S (evict older than this; 0 = off)

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
    # Per-tier local model ids used when running inference locally (Part 4). The
    # auto-picker (llm._pick_ollama) biases to TINY models — right for a last-resort
    # fallback, wrong when local is PRIMARY — so name the capable model per tier.
    # "" → fall back to ollama_model → auto-pick.
    ollama_model_fast: str = ""  # OLLAMA_MODEL_FAST (tool/JSON tier, e.g. qwen3-coder:30b-a3b)
    ollama_model_reason: str = ""  # OLLAMA_MODEL_REASON (deep tier, e.g. qwen3.6)
    # Prefer the local Ollama model FIRST, ahead of MiniMax/DeepSeek, to dodge cloud
    # rate limits when the operator has a capable local GPU. OFF by default so
    # hosted/cloud behaviour is unchanged; flipped at runtime via POST /api/ai/local
    # (the desktop build turns it on when a tool-capable model is present).
    llm_prefer_local: bool = False  # LLM_PREFER_LOCAL
    # Strict local-only mode: when on, `_run_chat` uses ONLY the Ollama rung —
    # on failure it returns the Ollama error directly and never falls through to
    # MiniMax/DeepSeek cloud. Distinct from `llm_prefer_local` (which tries
    # Ollama first but still falls back to cloud): this is for a caller who
    # wants a hard guarantee that no request leaves the box (e.g. a cloud key
    # is present in the environment but the operator does not want it used for
    # this run). OFF by default; flipped at runtime via POST /api/ai/local.
    llm_local_only: bool = False  # LLM_LOCAL_ONLY
    api_base: str = "http://localhost:8000"  # API_BASE (MCP → backend)

    # ── Local model manager (app.localllm) — Unsloth GGUF catalog + engines ──
    # Which local engine serves the "local" LLM rung: llama.cpp (all Unsloth
    # GGUF tiers, MoE CPU-offload) is PRIMARY; vLLM is opt-in for small models
    # fully in VRAM; Ollama is the long-standing fallback above. "auto" picks
    # llama.cpp when a binary + main model are ready, else falls back to
    # Ollama — see app.llm's engine-resolution ladder.
    llm_local_engine: str = "auto"  # LLM_LOCAL_ENGINE auto|llamacpp|vllm|ollama
    # Operator-supplied llama-server path — used verbatim, skips PATH lookup
    # and the managed release install entirely.
    llamacpp_binary: str = ""  # LLAMACPP_BINARY
    # Pinned llama.cpp GitHub release tag for the managed install (never a
    # floating "latest" — CVE-2026-27940 fixed at b8146; b9964 verified live
    # 2026-07-11 as the current stable tag). llama.cpp ships no Linux CUDA
    # prebuilt (Windows-only) — the managed installer pulls that release's
    # Ubuntu **Vulkan** build instead (runs on the same NVIDIA driver stack).
    llamacpp_release: str = "b9964"  # LLAMACPP_RELEASE
    # llama-server listens on localhost only, router mode (--models-dir), a
    # per-boot --api-key the browser never sees. Set by the sidecar (owned
    # elsewhere); this is just where the backend's OpenAI-compatible rung and
    # the hardware/models routes look for it.
    llamacpp_host: str = "http://127.0.0.1:8094"  # LLAMACPP_HOST
    llamacpp_models_max: int = 2  # LLAMACPP_MODELS_MAX (main + hot selection)
    # vLLM stays OFF by default — no CPU/GPU hybrid offload (whole model must
    # fit VRAM), and it rejects Unsloth's UD-* GGUF dynamic quants (GH
    # #39469), so it is opt-in only for small models fully in VRAM.
    vllm_enabled: bool = False  # VLLM_ENABLED
    vllm_host: str = "http://127.0.0.1:8095"  # VLLM_HOST
    # Installed-model root. "" → ./data/models (same relative-to-CWD idiom as
    # history_db_path/ontology_db_path above); created 0700 on first use.
    local_models_dir: str = ""  # LOCAL_MODELS_DIR
    # Gotham-style "selection inference": a separate, faster model pick used
    # for the AI-assessment brief when an entity is selected on the globe.
    # Installed-model key (see app.localllm.manager); "" → unconfigured.
    llm_selection_model: str = ""  # LLM_SELECTION_MODEL
    llm_selection_enabled: bool = False  # LLM_SELECTION_ENABLED
    # Pin the selection model resident (load-on-startup, exempt from the
    # router's LRU eviction) instead of loading it cold on first selection.
    llm_selection_hot: bool = False  # LLM_SELECTION_HOT

    # ── Human-in-the-loop action approval (HITL gate) ──
    # When ON (default), the intel agent's write-back actions become PROPOSALS the
    # operator approves/rejects in AgentConsole instead of dispatching directly.
    # An action whose model-reported confidence >= action_auto_threshold auto-runs
    # (default 1.01 = never auto — a safe AIP-style knob; set below 1 to auto-execute
    # high-confidence writes). Set ACTION_APPROVAL=0 to restore direct dispatch.
    action_approval: bool = True  # ACTION_APPROVAL
    action_auto_threshold: float = 1.01  # ACTION_AUTO_THRESHOLD (1.01 = never auto)

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
    deepseek_base_url: str = ""  # DEEPSEEK_BASE_URL ("" → default endpoint)
    # OFF by default (issue #10): the server must NOT silently resolve a live
    # DeepSeek key + base URL out of an unrelated dev tool's home-dir config
    # (~/.config/opencode/opencode.jsonc) — on a shared/multi-tenant host that
    # would spend someone else's personal key and let an edited opencode config
    # redirect the server's LLM egress. Set DEEPSEEK_FROM_OPENCODE=1 to opt in on
    # a single-operator dev box; otherwise supply DEEPSEEK_API_KEY explicitly.
    deepseek_from_opencode: bool = False  # DEEPSEEK_FROM_OPENCODE
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
    # 24/7 background poll cadence for the keyless REST AIS sources (Digitraffic
    # /locations) into the unified vessel store. Keeps /api/maritime/snapshot warm
    # without a browser; Digitraffic positions update ~1/min so 30 s is ample.
    ais_poll_interval_s: float = 30.0
    # Parking mode: a vessel with SOG below parked_sog_kn is "parked" (anchored /
    # moored / drifting). Parked ships don't move, so an old fix is still
    # accurate — we retain them for parked_ttl_s (much longer than the 1h live
    # store) so the snapshot carries far more stationary vessels without ghosts.
    parked_sog_kn: float = 0.5
    parked_ttl_s: float = 43200.0  # 12h
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
    # Keyless GLOBAL AIS via headless-browser sidecar (VesselFinder) — the AIS
    # twin of the ADS-B globe sidecar. A real Chromium clears VesselFinder's
    # Cloudflare gate, fetches its public /api/pub/mp2 vessel tiles across a world
    # grid (the only thing the gate authorizes) and decodes the packed binary →
    # ~21k vessels worldwide (measured 2026-06-29), served as vessels.json on
    # localhost by tools/ais-vesselfinder-feeder. This is the FIRST keyless source
    # with global vessel breadth; the REST feeds above are N-Europe regional. The
    # ais_keyless poller pulls vessels.json and republishes each fix into the
    # unified store + /ws/ais. Set enabled=False to skip the second headless tab.
    # OFF by default: MarineTraffic (below) is now the PRIMARY keyless global AIS
    # sidecar. VesselFinder keys vessels by MMSI while MarineTraffic keys by its own
    # SHIP_ID (no MMSI in its tile payload), so the two CANNOT be deduped against
    # each other — running both double-renders every ship. MarineTraffic wins on
    # breadth (~326k tracked) AND richness (name/speed/course/heading/type/flag).
    # Flip this back on only if you also disable MarineTraffic (or accept the dupes).
    ais_vesselfinder_sidecar_enabled: bool = False
    ais_vesselfinder_sidecar_url: str = "http://127.0.0.1:8091/vessels.json"
    ais_vesselfinder_sidecar_interval_s: float = 30.0

    # Keyless GLOBAL AIS via headless-browser sidecar (MarineTraffic) — the PRIMARY
    # keyless vessel source. A real Chromium loads MarineTraffic (clears its
    # Cloudflare gate) and drives the page's own public tile endpoint
    # /getData/get_data_json_4/z/X/Y across a world grid (paced — MarineTraffic
    # burst-throttles /getData). Unlike VesselFinder's packed binary this returns
    # CLEAN JSON with name/speed/course/heading/type/flag/length, served as
    # vessels.json on localhost by tools/ais-marinetraffic-feeder. Vessels are keyed
    # vessel:mt-<ship_id> (MarineTraffic has no MMSI in the tile payload). The
    # ais_keyless poller pulls vessels.json into the unified store + snapshot layer.
    # OFF by default: MarineTraffic keys vessels by SHIP_ID (no MMSI in its tile
    # payload) so it can't dedup against the MMSI-keyed feeds, and its Cloudflare
    # gate rate-throttles a datacenter IP hard. MyShipTracking (below) is the
    # enabled primary instead — MMSI-keyed (dedups) and not Cloudflare-gated. Flip
    # this on (and MyShipTracking off) if you want MarineTraffic's richer
    # flag/length/destination fields and accept the SHIP_ID dupes + throttle.
    ais_marinetraffic_sidecar_enabled: bool = False
    ais_marinetraffic_sidecar_url: str = "http://127.0.0.1:8092/vessels.json"
    ais_marinetraffic_sidecar_interval_s: float = 60.0

    # Keyless GLOBAL AIS via headless-browser sidecar (MyShipTracking) — the
    # ENABLED PRIMARY vessel source. A real Chromium drives MyShipTracking's public
    # bbox endpoint /requests/vesselsonmaptempTTT.php across a world grid; it returns
    # a TAB-delimited body with a real 9-digit MMSI + name/sog/cog per vessel, so
    # these key on the standard vessel:<mmsi> id and dedup cleanly against every
    # other AIS feed. NOT Cloudflare-gated (tolerated a 72-cell grid without
    # throttling); ~22k vessels worldwide (measured 2026-07-05), served as
    # vessels.json on localhost by tools/ais-myshiptracking-feeder.
    ais_myshiptracking_sidecar_enabled: bool = True
    ais_myshiptracking_sidecar_url: str = "http://127.0.0.1:8093/vessels.json"
    ais_myshiptracking_sidecar_interval_s: float = 30.0

    # MAVLink bridge sidecar (app.mavlink_sidecar → `python -m app.mavlink_bridge`).
    # The first-class control server the Workflows `control.drone` block points
    # at: it translates the drone.command JSON envelope into real MAVLink and
    # forwards it to a vehicle / SITL. OFF by default — a control bridge that
    # auto-connects to a drone at boot is not something you want implicitly, and
    # pymavlink + a MAVLink endpoint are optional (without them it runs log-only,
    # echoing the planned commands without touching a vehicle). Enable it and
    # point `control.drone.server_url` at http://127.0.0.1:{port}.
    mavlink_bridge_enabled: bool = False
    mavlink_bridge_port: int = 9010
    # pymavlink connection string, e.g. "udpout:127.0.0.1:14550" (SITL/ArduPilot/
    # PX4) or "/dev/ttyACM0,57600" (a real radio). Empty → log-only (no uplink).
    mavlink_bridge_connect: str = ""

    # Keyless GLOBAL AIS via DIRECT httpx (NO browser sidecar) — ShipXplorer's
    # public data.shipxplorer.com/live bbox endpoint. Reachable straight from the
    # server with browser-like headers (referer/origin); NOT Cloudflare-gated. A
    # single world-bbox call at zoom 6 returns the FULL set (~32.6k vessels, server
    # `total` field == returned count, so no decimation cap) as a JSON list
    # [ {id:[_,lat,lon,ts,_,sog,"AIS",typeName,MMSI,_,status,...]}, {total}, [], {} ].
    # Real 9-digit MMSI → keys the standard vessel:<mmsi> id and dedups (freshest-
    # wins) against MyShipTracking + the regional feeds; the two co-exist without
    # double-rendering (both MMSI-keyed). Includes satellite AIS (sate=true).
    ais_shipxplorer_enabled: bool = True
    ais_shipxplorer_url: str = "https://data.shipxplorer.com/live"
    ais_shipxplorer_interval_s: float = 45.0
    ais_shipxplorer_zoom: int = 6

    # OSINT deep-recon sidecar (tools/osint-recon) — OPTIONAL, OFF by default.
    # A separate process that shells out to the GPL tools (SpiderFoot / theHarvester
    # / Amass), keeping GPL code OUT of this MIT app. When unset, /api/osint/recon
    # returns 503 and the feature is invisible. Set to e.g. http://127.0.0.1:8099.
    osint_recon_sidecar_url: str = ""

    # MarineTraffic (PAID global AIS, key-gated). Dormant unless a key is set.
    # `marinetraffic_url` is a template ({key} substituted) because the exact path
    # depends on your MarineTraffic plan (area export / fleet positions). Polls into
    # the same vessel store + /ws/ais as the keyless feeds. May be datacenter-IP
    # restricted — probe reachability from the deployment host first.
    marinetraffic_key: str = ""  # MARINETRAFFIC_KEY
    marinetraffic_enabled: bool = True  # gate; only runs when a key is present
    marinetraffic_interval_s: float = 120.0
    marinetraffic_url: str = (
        "https://services.marinetraffic.com/api/exportvessels/v:8/{key}/protocol:jsono"
    )

    # ── Historical playback ──
    # Position history store for 3D replay/scrub. SQLite by default; safe to
    # delete (refills as live data flows). Disable to run fully stateless.
    history_enabled: bool = True
    history_db_path: str = "./data/history.db"
    # Default look-back window for replay. 7 days lets the operator scrub
    # multi-day, not just the live ~24 h window. This is a TIME bound only —
    # the byte cap below is what actually limits storage; the hour window just
    # decides how far back fixes are *kept* once there's disk room.
    history_retention_hours: int = 168  # 7 days
    # Hard ceiling on retention so the time bound can never be set unboundedly
    # large (a fat-fingered env var of e.g. 1_000_000 would otherwise let the
    # DB grow until only the byte cap reins it in, much later). history.py
    # clamps history_retention_hours into [1, history_retention_max_hours].
    # 30 days is a generous multi-day replay horizon. 0 disables the ceiling.
    history_retention_max_hours: int = 720  # 30 days
    # Hard upper bound on the replay store. The hourly maintenance pass time-
    # prunes to the (clamped) history_retention_hours, then if the file is
    # still larger than history_max_bytes it drops the oldest rows until under
    # the cap and VACUUMs to actually return the pages to the filesystem. Days
    # of global ADS-B + AIS run into many GB, so the byte cap — not the hour
    # window — is the binding limit. 0 disables the byte cap (hour window only).
    history_max_bytes: int = 2_000_000_000  # ~2 GB
    # Archive profile — turns the bounded live buffer into an intentional
    # multi-day/week archive. OFF by default (current bounded-buffer behavior
    # is unchanged unless the operator opts in).
    archive_mode: bool = False  # ARCHIVE_MODE
    # Disk budget used ONLY when archive_mode is True (GB). 0 = fall back to
    # history_max_bytes (documented, logged once at boot — never a silent no-op).
    history_disk_budget_gb: float = 0.0  # HISTORY_DISK_BUDGET_GB

    # ── Ontology local spine ──
    # Default (keyless) backend for the ontology: local SQLite next to
    # history.db. Objects keep a materialized props blob for frontend parity;
    # every property change is also an append-only assertion row (source,
    # confidence, observed_at) — see intel/ontology_local.py. Supabase, when
    # configured AND the caller is signed in, remains the remote backend.
    ontology_db_path: str = "./data/ontology.db"
    # Soft byte cap on the whole store (oldest assertions dropped + VACUUM).
    # 0 disables. Same bounding philosophy as history_max_bytes.
    ontology_db_max_bytes: int = 2_000_000_000  # ~2 GB
    # Per-object assertion budget; oldest rows beyond it are deleted. The
    # roadmap pins ~2000 as the starting cap. 0 disables.
    ontology_max_assertions_per_object: int = 2000

    # ── Foundry substrate (docs/foundry-plan.md) ──
    # BYO-data datasets/transforms/builds/bindings/schedules store. Local
    # SQLite next to ontology.db/history.db — same bounding philosophy (row
    # cap + upload size cap enforced in app/foundry/store.py + ingest.py).
    foundry_db_path: str = "./data/foundry.db"

    # ── Workflows substrate (docs/dashboard-workflows-plan.md) ──
    # User-authored DAG pipelines (sources/ops/sinks) over live platform data.
    # Same local-SQLite idiom as foundry_db_path.
    workflows_db_path: str = "./data/workflows.db"

    # ── Alert rules local spine (W3 keyless alert push, docs/decisions.md) ──
    # Default (keyless) backend for standing watch rules: local SQLite next to
    # ontology.db/history.db, same idiom. Supabase, when configured, remains
    # the RLS-scoped remote backend for signed-in multi-tenant deployments —
    # this path is additive, not a replacement.
    alert_rules_db_path: str = "./data/alert_rules.db"

    # Optional key for the Have-I-Been-Pwned email-breach API (paid). Absent →
    # the person-OSINT HIBP connector degrades to an honest note; everything else
    # in the person layer stays keyless.
    hibp_api_key: str = ""

    # Path to the CUDA venv python that runs the YOLO sidecar for imagery
    # detection (e.g. ~/.venv/bin/python — torch+ultralytics, NOT apps/api's
    # venv). Empty → /api/imagery/detect degrades to an honest "sidecar offline".
    yolo_python: str = ""


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
