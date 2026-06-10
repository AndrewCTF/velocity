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

## Phase status

- [x] Phase 0 — Foundation (this commit)
- [ ] Phase 1 — MVP (4 live layers)
- [ ] Phase 2 — Replay + drill-in
- [ ] Phase 3 — Fusion engine + alerts + 2D mirror
- [ ] Phase 4 — Advanced sensors + AI

See [the plan](.) for detail.
