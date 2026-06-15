# OSINT Geospatial Console

A single-analyst, defence/offence-grade open-source intelligence platform: a 3D/4D Cesium globe over ~60 free/open data sources, with a server-side fusion engine that correlates feeds (AIS+SAR for dark vessels, ADS-B NACp clusters for GPS jamming, BGP/Cloudflare for outages, etc.).

It is also a **Model Context Protocol** server: an AI agent can query the same live feeds (aircraft, vessels, GPS jamming, fused anomalies) as distilled JSON — see the [MCP section](#mcp-server--query-the-live-console-from-an-ai-agent) below.

See [`docs/frontend.md`](./docs/frontend.md), [`docs/research.md`](./docs/research.md), and [`docs/research_updated.md`](./docs/research_updated.md) for the full specs, [`docs/adsb-aircraft-pipeline.md`](./docs/adsb-aircraft-pipeline.md) for how the ~13 k-aircraft global feed is sourced and merged, and [`docs/mcp-server.md`](./docs/mcp-server.md) for the agent-facing MCP + intel API.

## Stack

- **Frontend**: Vite + React 18 + TypeScript + CesiumJS + MapLibre GL JS v5.24 + Tailwind + Zustand
- **Backend**: FastAPI (Python 3.12) + httpx + websockets — all Phase 1 state is in-process (bounded observation store + disk tile cache)
- **Agent access**: Model Context Protocol server (`app.mcp_server`, MCP SDK) + optional local Ollama analysis
- **Data (Phase 2, planned)**: PostgreSQL 16 + PostGIS + TimescaleDB hypertables + Redis — the observation store migrates per plan §locked-decisions #5
- **Infra**: Docker Compose, nginx reverse proxy

## Layout

```
osint/
├── apps/web/                 # React + Cesium console
├── apps/api/                 # FastAPI backend
│   └── app/
│       ├── intel/            # agent-facing analytics (classification, AOI, density, jamming)
│       ├── routes/intel.py   # /api/intel/* deep-query JSON API
│       └── mcp_server.py     # Model Context Protocol server (11 tools)
├── packages/shared/          # Shared TS types (LayerDescriptor, Observation)
├── docs/                     # adsb-aircraft-pipeline.md, mcp-server.md
└── infra/                    # Docker, nginx, db init
```

## Quick start

```bash
cp .env.example .env       # optional — every key is optional, empty works
pnpm install
docker compose up          # boots api, web, nginx on :8080
```

Open <http://localhost:8080>.

### Local dev without docker

```bash
make install                                      # pnpm install + api venv
cd apps/api && .venv/bin/uvicorn app.main:app     # backend on :8000
pnpm dev                                          # vite on :5173, proxies /api → localhost:8000
```

Set `VITE_API_URL` if the backend is anywhere other than `http://localhost:8000`.
If you set `API_KEY` on the backend, build/serve the web app with a matching
`VITE_API_KEY` — the bundle attaches it as `X-API-Key` on every call.

## System requirements

The heavy component is the **client**: a CesiumJS WebGL2 globe. It is GPU- and
browser-main-thread-bound; the backend is light. WebGL2 is required (Chrome/Edge
110+, Firefox 110+). On hybrid-graphics laptops, force the discrete GPU
(`chrome://gpu` → adapter "ACTIVE").

**VRAM is mode-dependent — be honest with yourself about which mode you run:**

- **2D-dark (default basemap):** light. The globe is a proxied 2D raster basemap
  plus the entity layers (aircraft/vessels). Runs on integrated graphics / ~2–4 GB
  VRAM. This is the right mode for modest hardware.
- **3D-sat (satellite imagery + world terrain + OSM 3D buildings, optional Google
  Photorealistic 3D):** **VRAM-heavy.** CesiumJS streams terrain meshes, high-res
  imagery, and 3D-tile building/photogrammetry sets, and it caches into whatever
  VRAM is available — measured at **20+ GB on a 32 GB card**. Tilesets are now
  individually cache-capped (Google 3D ~1.5 GB, OSM buildings ~0.5 GB) and MSAA is
  off (FXAA instead), but with terrain + global imagery + a high-DPI/4K canvas the
  resident set is still large. On a card with less VRAM Cesium evicts/re-fetches
  more aggressively (lower fps, more pop-in) but still runs.

| Tier | GPU | RAM | Display | What you get |
|---|---|---|---|---|
| Minimum | WebGL2 integrated (Iris Xe / Vega / M1) | 8 GB | 1080p | 2D-dark, regional zoom, ~30 fps. 3D-sat will be rough. |
| Recommended | Discrete ≥8 GB VRAM (RTX 3060 / RX 6700 / M-Pro) | 16 GB | 1080p–1440p | 2D-dark smooth; 3D-sat usable at city scale. |
| 3D-sat / 4K | RTX 4070+/16 GB VRAM or better | 32 GB | up to 4K | Full 3D-sat terrain + buildings; high fps. |

These tiers reflect **observed** behaviour, not a wish — 3D-sat genuinely wants a
lot of VRAM, and a low-VRAM "minimum" only applies to 2D-dark.

**Backend (server):** Python 3.12, ~1 GB RAM, outbound HTTPS — runs on a small
VPS or the same box; not the bottleneck.

## Tests

```bash
pnpm -r test                          # vitest (web, shared)
cd apps/api && .venv/bin/pytest -q     # api: unit + route + intel/MCP degradation tests
pnpm -r typecheck
# manual MCP integration drivers (need backend on :8000):
#   apps/api/.venv/bin/python tests/mcp_client_check.py   # stdio handshake
#   apps/api/.venv/bin/python tests/mcp_full_check.py     # all 11 tools end-to-end + Ollama
```

## MCP server — query the live console from an AI agent

The backend doubles as a **Model Context Protocol** server so an AI agent can
interrogate the same warm feeds the globe renders, without flooding its own
context. Full architecture + `/api/intel/*` HTTP reference:
[`docs/mcp-server.md`](./docs/mcp-server.md). It exposes 11 tools over
`app.mcp_server`:

| Tool | What it returns |
| --- | --- |
| `get_situation` | Global summary — aircraft by category, GNSS-degraded count, emergencies, worst jamming cells, vessel/alert counts. The cheap first call. |
| `focus_area(lat,lon,radius_nm)` | **Loads a region PRIMARY** (dedicated fresh `/v2/point` fetch + ongoing priority refresh, independent of global rate limits) and returns a full bundle: aircraft + density + GPS jamming + vessels + fused anomalies. |
| `aircraft_density` | Grid of cells (count, by category, GNSS-degraded) for an area. |
| `gps_jamming` | GPSJam-method assessment (ADS-B NACp<8 / NIC<7, 1° bins) — flagged cells, severity, affected aircraft. Global or scoped. |
| `query_aircraft` | Filtered query (bbox/centre, category, squawk, callsign, altitude band, emergency / gnss_degraded / on_ground). |
| `lookup_aircraft(ident)` | One aircraft by ICAO24 or callsign + integrity/threat assessment. |
| `query_vessels` | AIS vessels in an area, classified; `dark_only` for dark-vessel candidates. |
| `anomalies` | Fused report: emergencies, jamming hotspots, dark vessels, alerts + a triage threat level. |
| `list_focus_areas` / `data_sources` | Active priority AOIs / feed health. |
| `deep_analyze(question, lat?, lon?)` | Gathers the relevant intel JSON and has a **local Ollama model** reason over it — heavy analysis stays on the box, only the conclusion returns to the agent. |

Every tool returns compact, bounded JSON (counts, grids, ≤50-item samples) — an
agent can sweep the planet for a few hundred tokens instead of pulling 15k
features. Area-primary loading means the agent's region of interest stays fresh
and dense even while the global firehose is being rate-limited; the rest of the
world keeps streaming from the sticky snapshot.

```bash
# 1. backend must be running (provides the warm feeds)
uv run --project apps/api uvicorn app.main:app --port 8000

# 2a. MCP server over stdio (Claude Code / Desktop / Agent SDK) — cross-platform
uv run --project apps/api python -m app.mcp_server
# 2b. or streamable-HTTP
uv run --project apps/api python -m app.mcp_server --http --port 8765
# introspect (no backend needed)
uv run --project apps/api python -m app.mcp_server --list-tools
```

A ready `.mcp.json` at the repo root wires the `osint-geoint` server for
Claude Code using `uv run`, so it resolves the right interpreter on Linux,
macOS, and Windows without hardcoding a venv path. No `uv`? Call the venv
Python directly — `apps/api/.venv/bin/python -m app.mcp_server` (Linux/macOS)
or `apps\api\.venv\Scripts\python.exe -m app.mcp_server` (Windows), run from
`apps/api`.

Config (env or `apps/api/.env`): `API_BASE`, `API_KEY`, `OLLAMA_HOST`,
`OLLAMA_MODEL` (empty → smallest installed model auto-picked; `deep_analyze`
degrades to returning raw JSON if Ollama is absent). The MCP server never
crashes a tool call: backend down → structured `backend_unreachable` error;
Ollama down → analysis falls back to raw intel JSON.

## Phase status

- [x] Phase 0 — Foundation
- [x] Phase 1 — MVP (live ADS-B / AIS / quakes / jamming layers)
- [ ] Phase 2 — Replay + drill-in
- [x] Phase 3 — Fusion engine + alerts (correlation rules) + 2D mirror
- [~] Phase 4 — Advanced sensors + AI — **MCP server + intel API shipped** (agent access, local Ollama analysis)

See [the plan](.) for detail.
