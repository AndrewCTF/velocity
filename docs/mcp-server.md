# MCP server + intel layer

The backend doubles as a **Model Context Protocol** server (`app.mcp_server`)
so an AI agent can interrogate the same warm feeds the globe renders — ADS-B
aircraft, AIS vessels, the GPS-jamming layer, and the fusion engine — without
flooding its own context window. Every response is distilled JSON (counts,
grids, ≤50-item samples), never a raw 15k-feature dump.

See also [`adsb-aircraft-pipeline.md`](./adsb-aircraft-pipeline.md) for how the
~13 k-aircraft global feed itself is sourced and merged.

## Architecture

```
agent ──stdio / http (/mcp)──▶ app.mcp_server (46 tools)
                          │  httpx
                          ▼
                     /api/intel/*  (app.routes.intel)
                          │
                          ▼
                     app.intel.{analytics, aoi, geo}
                          │  reads (no new steady-state upstream load)
        ┌─────────────────┼───────────────────────────┐
        ▼                 ▼                            ▼
 adsb.adsb_global   correlate.store (AIS)      correlate.bus (alerts)
 (sticky snapshot)                              + routes.jamming aggregation
```

- **`app/intel/geo.py`** — aircraft/vessel classification (mirrors the
  operator-visible `apps/web/src/globe/adapters/styles.ts` dispatch: same ADS-B
  Mode-S category codes, emergency squawks, ITU ship-type buckets, military
  callsign heuristic) plus bbox / haversine helpers.
- **`app/intel/aoi.py`** — area-primary loading (below).
- **`app/intel/analytics.py`** — the distilled analytics: `situation`,
  `density`, `jamming`, `query_aircraft`, `lookup_aircraft`, `query_vessels`,
  `anomalies`, `area_intel`. Reads the already-warm in-process snapshot — it
  opens **no** new steady-state upstream fan-out.
- **`app/routes/intel.py`** — the `/api/intel/*` HTTP surface the MCP drives.
- **`app/mcp_server.py`** — FastMCP server exposing 46 tools over that HTTP
  surface (+ the Ollama-backed `deep_analyze`). `build_mcp_mount()` mounts it
  into the FastAPI app at `/mcp` (streamable-HTTP) for the hosted deployment.

## Area-primary loading

> *"When the agent wants an area, load that area PRIMARY, then only load others."*

The guarded global snapshot (`app.routes.adsb`) is untouched. `focus_area`
adds an **additive** mechanism on top:

1. Registers an AOI and does an immediate dedicated `/v2/point` fetch for just
   that area (cheap, rarely throttled even when the global firehose is
   rate-limited).
2. A background warmer (tied to the app lifespan) keeps every registered AOI
   hot on a short cycle — priority — while the rest of the world keeps
   streaming from the global snapshot ("only load others").
3. If every host refuses the direct fetch, it degrades gracefully to filtering
   the global snapshot for the AOI bbox — the agent always gets data
   (`load_mode` reports `direct` vs `snapshot`).

Bounded to 8 AOIs (LRU). Uses the same shared httpx client + upstream
semaphore + host list as the adsb module, so it can never out-pace the global
fan-out's rate budget.

## HTTP API — `/api/intel/*`

All return compact JSON. Geography is accepted as a centre (`lat,lon[,radius_nm]`)
or an explicit bbox (`min_lon,min_lat,max_lon,max_lat`).

| Endpoint | Purpose |
| --- | --- |
| `GET /situation` | Global orienting summary (cheap first call) |
| `GET /area` | Load a region PRIMARY + full intel bundle in one shot |
| `GET /density` | Aircraft density grid for an area |
| `GET /jamming` | GPS-jamming assessment (global or scoped) |
| `GET /aircraft` | Filtered aircraft query |
| `GET /aircraft/{ident}` | Single-aircraft lookup (ICAO24 or callsign) |
| `GET /vessels` | AIS vessels in an area (`dark_only` supported) |
| `GET /anomalies` | Fused report + triage threat level |
| `GET /aois` | Active priority areas |
| `GET /sources` | Feed health + which feeds are key-gated |

## MCP tools

46 tools — a representative table is in the [README](../README.md#mcp-server--query-the-live-console-from-an-ai-agent);
run `--list-tools` for the full set. A slice:
`get_situation`, `focus_area`, `aircraft_density`, `gps_jamming`,
`query_aircraft`, `lookup_aircraft`, `query_vessels`, `anomalies`,
`intel_brief`, `detect_deception`, `locate_emitter`, `area_baseline`,
`whats_changed`, `incident_history`, `vessel_dossier`, `aircraft_dossier`,
`list_focus_areas`, `data_sources`, `deep_analyze`, `news_analysis`,
`fact_check`, `aoi_imagery`.

### REST-parity tools (`/api/eq`, `/api/history`, `/api/alerts/rules`)

Three routes outside `/api/intel/*` also get thin wrappers, so an
MCP-restricted agent can reach them without dropping to raw HTTP:

- **`quakes_near(lat, lon, radius_km, range='day', detail)`** → `GET /api/eq`.
  `lat`, `lon`, `radius_km` must all be given together — the route 422s on a
  partial set rather than silently returning the unfiltered global feed.
- **`track_history(id, from_ts, to_ts, detail)`** → `GET /api/history/track`.
  `id` is `'aircraft:<icao24hex>'` / `'vessel:<mmsi>'`, or a bare id whose
  shape is unambiguous (6-char ICAO24 hex or 9-digit MMSI) — the route infers
  the kind. An id it can't resolve returns the route's 422 message as-is.
- **`create_watch_rule(label, ..., icao24, mmsi, callsign)`** /
  **`list_watch_rules(detail)`** / **`delete_watch_rule(rule_id)`** →
  `POST` / `GET` / `DELETE /api/alerts/rules`. A rule needs a gate: an
  identity pin (`icao24`/`mmsi`/`callsign`, follows that entity globally, no
  AOI needed) or a complete AOI (`lat`, `lon`, `radius_nm`, default 50 nm).
  The route validates channel/kind/gate; the wrapper passes its error through
  unchanged.

### Context budget: `detail='short'` vs `'long'`

Every heavy tool takes a `detail` argument (`app/intel/shape.py`):

- **`short`** (the default) — a token-frugal *digest* of the same payload:
  scalars and small dicts kept, long arrays capped to the top few items with a
  companion `<field>_total` giving the true size, verbose strings truncated, and
  a top-level `truncated`/`hint` flag when anything was dropped. Ideal for
  orientation and planet-wide sweeps. When nothing needs trimming the payload is
  returned unchanged (short is a faithful passthrough for the already-small
  tools).
- **`long`** — the full route payload, untouched. Use it once you have picked one
  incident/area/entity worth the extra context.

The shaper is a pure function (no I/O) applied in the MCP layer, so the guarded
`/api/intel/*` routes are unchanged. Rule of thumb for an agent: **sweep in
`short`, drill in `long`.**

### `deep_analyze` (reasoning model)

Gathers the relevant intel JSON and hands it to a **reasoning model** — DeepSeek
(`deepseek-reasoner`) when configured, else a **local Ollama model** — to
reason over; heavy analysis stays off the agent's context, only the conclusion returns to
the agent's context. Auto-picks the smallest installed model; degrades to
returning the raw structured JSON (`analysis: null`) when Ollama is absent.

## Running

### Claude Code plugin (skill + commands + agent + MCP)

The repo doubles as a Claude Code **plugin marketplace** (`plugin/osint-geoint/`).
Installing the plugin wires the MCP server **and** an analyst skill
(`osint-intel`), three slash commands (`/osint-brief`, `/osint-watch`,
`/osint-jamming`), and a `osint-watch-officer` agent. Start the backend first
(`bash scripts/run-api.sh`), then in Claude Code:

```
/plugin marketplace add /path/to/OSINT
/plugin install osint-geoint@osint-velocity
```

Set **repo_dir** and **python** (the repo's venv interpreter) when prompted — the
plugin launches that Python directly (`python -m app.mcp_server`), so one manifest
works on Windows, macOS, and Linux. The installer prints the exact commands per OS:
`bash plugin/osint-geoint/install.sh` (Linux/macOS, `-y` to register) or
`plugin\osint-geoint\install.ps1` (Windows, `-Run` to register). See
[`plugin/osint-geoint/README.md`](../plugin/osint-geoint/README.md).

### Hosted

On the hosted deployment the MCP server is mounted into the FastAPI backend at
`/mcp` (streamable-HTTP) — no separate process. The gateway Worker proxies
`https://projectvelocity.org/mcp` to it, verifying the caller's Velocity
(Supabase) token and forwarding it; the backend's `ApiKeyMiddleware` re-checks
the token, so the endpoint is gated like every other non-public route. Connect
any MCP client:

```bash
claude mcp add --transport http osint-geoint \
  https://projectvelocity.org/mcp \
  --header "Authorization: Bearer $VELOCITY_TOKEN"
```

> The backend's in-process tools self-call `/api/intel/*` over localhost, so a
> hosted deployment must set `API_KEY` (the static key the self-hop presents)
> **and** Supabase auth (`SUPABASE_JWT_SECRET`) so the directly-reachable
> backend `/mcp` is gated too — not only the Worker path. See
> [`deploy-cloudflare.md`](./deploy-cloudflare.md).

### Self-host / develop

```bash
# backend must be up (provides the warm feeds)
uv run --project apps/api uvicorn app.main:app --port 8000

uv run --project apps/api python -m app.mcp_server              # stdio
uv run --project apps/api python -m app.mcp_server --http --port 8765
uv run --project apps/api python -m app.mcp_server --list-tools  # introspect
```

Register the local stdio server with Claude Code:
`claude mcp add osint-geoint -- uv run --project apps/api python -m app.mcp_server`.
Config (env or `apps/api/.env`): `API_BASE`, `API_KEY`, `OLLAMA_HOST`,
`OLLAMA_MODEL`.

### Other agents

Verified end-to-end with **opencode** (`opencode mcp list` → connected) driving
the tools through both a local Ollama model and DeepSeek (`deepseek-v4-flash`,
OpenAI-compatible). Any MCP-capable client works.

## Robustness

The MCP server never crashes a tool call:

- backend down → structured `backend_unreachable` error + hint
- Ollama down → `deep_analyze` falls back to raw intel JSON
- empty snapshot / out-of-range params → handled (HTTP 422 at the route)
- the AOI warmer is cancelled on app shutdown (no leaked background task)

## Testing

```bash
cd apps/api && .venv/bin/pytest -q          # unit + route + degradation tests
# manual integration drivers (need a live backend on :8000):
.venv/bin/python tests/mcp_client_check.py  # MCP stdio handshake
.venv/bin/python tests/mcp_full_check.py    # tools end-to-end + Ollama
```
