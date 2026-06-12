# OSINT Geospatial Console

A single-analyst, defence/offence-grade open-source intelligence platform: a 3D/4D Cesium globe over ~60 free/open data sources, with a server-side fusion engine that correlates feeds (AIS+SAR for dark vessels, ADS-B NACp clusters for GPS jamming, BGP/Cloudflare for outages, etc.).

See [`frontend.md`](./frontend.md), [`research.md`](./research.md), and [`research_updated.md`](./research_updated.md) for the full specs.

## Stack

- **Frontend**: Vite + React 18 + TypeScript + CesiumJS + MapLibre GL JS v5.24 + Tailwind + Zustand
- **Backend**: FastAPI (Python 3.12) + SQLAlchemy 2 + asyncpg + APScheduler + websockets
- **Data**: PostgreSQL 16 + PostGIS 3.4 + TimescaleDB 2.x + Redis 7
- **Infra**: Docker Compose, nginx reverse proxy

## Layout

```
osint/
├── apps/web/         # React + Cesium console
├── apps/api/         # FastAPI backend
├── packages/shared/  # Shared TS types (LayerDescriptor, Observation)
└── infra/            # Docker, nginx, db init
```

## Quick start

```bash
cp .env.example .env       # fill in CESIUM_ION_TOKEN at minimum
pnpm install
docker compose up          # boots db, redis, api, web, nginx on :8080
```

Open <http://localhost:8080>.

## Tests

```bash
pnpm -r test               # vitest (web, shared)
cd apps/api && pytest      # api
pnpm -r typecheck
```

## MCP server — query the live console from an AI agent

The backend doubles as a **Model Context Protocol** server so an AI agent can
interrogate the same warm feeds the globe renders, without flooding its own
context. It exposes 11 tools over `app.mcp_server`:

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

- [x] Phase 0 — Foundation (this commit)
- [ ] Phase 1 — MVP (4 live layers)
- [ ] Phase 2 — Replay + drill-in
- [ ] Phase 3 — Fusion engine + alerts + 2D mirror
- [ ] Phase 4 — Advanced sensors + AI

See [the plan](.) for detail.
