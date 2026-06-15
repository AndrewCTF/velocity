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

The heavy component is the **client**: a CesiumJS WebGL2 globe rendering up to
~14 k animated entities (aircraft + vessels) plus terrain/imagery. It is GPU- and
main-thread-bound in the browser, not on the server. A discrete GPU is strongly
recommended; on hybrid-graphics laptops make sure the browser uses the dGPU
(`chrome://gpu` → "GPU0 … ACTIVE"). High-DPI/4K multiplies GPU load (render scale
is capped at 1.5×); MSAA is off in favour of FXAA to keep render-target VRAM low.

| | Minimum (runs, reduced) | Recommended (smooth, full feeds) | Ideal (everything, 4K, 100+ fps) |
|---|---|---|---|
| **GPU** | Any WebGL2 GPU — integrated (Intel Iris Xe, AMD Vega, Apple M1) | Discrete, ≥4 GB VRAM (GTX 1660 / RTX 2060 / RX 5600 / M1 Pro) | RTX 3070 / RX 6800 or better, ≥8 GB VRAM |
| **CPU** | Dual-core x86-64 / Apple Silicon | Quad-core+ | 8-core+ |
| **RAM** | 8 GB | 16 GB | 32 GB |
| **Display** | 1080p | 1080p–1440p | up to 4K |
| **Browser** | Chrome/Edge 110+ or Firefox 110+ (WebGL2 required) | Chrome/Edge (latest) | Chrome/Edge (latest) |
| **Experience** | Zoom into regions; world-view aircraft capped; ~30 fps | All feeds, smooth pan, ~60 fps | Full ~14 k-entity union + 3D-sat terrain, 100+ fps |

More system RAM = a larger Cesium tile cache (`tileCacheSize`, default raised to
1000) and smoother panning, since tiles stay resident instead of being re-fetched.

**Backend (server):** Python 3.12, ~1 GB RAM, outbound HTTPS. Runs comfortably on
a small VPS or the same machine as the browser; it is not the performance
bottleneck.

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
