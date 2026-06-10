# Design: Quota-free tiles, 3D photoreal stack, data resilience, CCTV layer

Date: 2026-06-10
Status: Approved by user (sections reviewed interactively)

## Problem

Every browser request currently hits upstream providers live. Consequences:

- Carto basemap proxy (`apps/api/app/routes/tiles.py`) has no server-side
  cache — N users × M tiles = N×M upstream hits, producing 429s and a slow map.
- Google Photorealistic 3D Tiles and Cesium ion assets burn quota on every
  toggle and at orbit altitudes where photogrammetry isn't even visible.
- ADS-B fan-out (140+ cells) depends on two upstreams with no failover; a 429
  empties cells and icons blink.
- No CCTV capability exists.

## Goals

1. Photorealistic look without quotas: satellite imagery + 3D terrain from
   free, keyless sources, server-cached.
2. Keep Google Photorealistic 3D Tiles as a city-level toggle with ~90% less
   quota use.
3. ADS-B/AIS never goes dark: failover chain + stale-while-revalidate.
4. New CCTV layer: legal, owner-published feeds only (government road/weather
   cams + curated free sites).

Non-goals: self-hosted PMTiles basemap (deferred — proxy keeps the source
swappable in one place), viewport-priority polling (YAGNI; failover + SWR
solves the gaps), paid API tiers.

## Architecture

### 1. Disk tile cache (`apps/api/app/tilecache.py` — new)

- Layout: `{TILE_CACHE_DIR}/{source}/{z}/{x}/{y}` (default
  `./data/tilecache`). Atomic writes: tmp file + rename.
- Per-source TTL: carto 30 d, eox 365 d, esri 365 d, terrarium infinite.
- Request coalescing: per-key `asyncio.Lock` so concurrent misses on the same
  tile produce exactly one upstream fetch.
- Failure policy: upstream 429/5xx → serve stale copy if present (any age),
  else 502. Non-200 responses are never cached.
- Security: z/x/y are typed ints in the route signature — no path traversal.

### 2. Tile routes (`apps/api/app/routes/tiles.py`)

| Route | Source | Notes |
|---|---|---|
| `/tiles/basemap/{z}/{x}/{y}.png` | Carto Dark Matter (existing) | now cache-wrapped |
| `/tiles/sat/{z}/{x}/{y}.jpg` (new) | z ≤ 13: EOX Sentinel-2 cloudless WMTS (keyless); z ≥ 14: ESRI World Imagery (keyless legacy endpoint) | server picks source by z; browser sees one URL |
| `/tiles/terrain/{z}/{x}/{y}.png` (new) | AWS Open Data terrarium tiles (`s3.amazonaws.com/elevation-tiles-prod`) | keyless, global z0–15 |

Attribution strings exposed via `/config` so the frontend can render them.

### 3. Frontend imagery stack (`apps/web/src/globe/GlobeCanvas.tsx`)

- `3d-sat` mode rewired to the free stack: `/tiles/sat` imagery via
  `UrlTemplateImageryProvider` + terrain from `/tiles/terrain` decoded by
  `cesium-martini` (client-side terrarium → quantized-mesh). No ion token
  required for satellite + terrain.
- ion token becomes optional: when present, OSM Buildings still loads.
- Attribution: small UI footer line (EOX CC BY-NC requires attribution; the
  Cesium credit container is currently hidden — this is the legal fix).
  Package name for the martini provider to be confirmed at implementation
  (`@macrostrat/cesium-martini` or equivalent maintained fork).

### 4. Google 3D quota diet (`GlobeCanvas.tsx`)

- Create the Google tileset once per session, lazily on first enable. Toggle
  off sets `tileset.show = false`; never destroy/recreate (zero re-fetch of
  root + cached tiles on re-toggle).
- Camera-height gate: above ~30 km altitude the tileset hides and the globe +
  sat imagery shows; below, photogrammetry shows. Orbit views burn no quota.
- `maximumScreenSpaceError`: 24 default (was 16), configurable via `/config`.
- Raise `cacheBytes` / `maximumCacheOverflowBytes` so city revisits reuse
  cached tiles.
- Google attribution must display while the tileset is active (ToS): unhide
  the credit strip in that mode.
- Existing generation-counter teardown logic adapts: generation invalidation
  keeps the show/hide semantics instead of destroying the Google tileset.

### 5. ADS-B/AIS resilience (`apps/api/app/routes/adsb.py`)

- Failover chain per cell: adsb.lol → airplanes.live → adsb.fi → OpenSky.
  First three share the `/v2` response shape; OpenSky needs a response adapter
  and OAuth2 client-credentials (`OPENSKY_CLIENT_ID/SECRET` already in env).
- Circuit breaker per upstream: 429 or timeout → 60 s cooldown; the chain
  falls through immediately.
- Token bucket per upstream for polite pacing.
- Stale-while-revalidate: cells keep `fetched_at`; if all upstreams fail,
  serve up to 10 min stale with `X-Stale: true`. Combined with
  `SampledPositionProperty` interpolation, icons never vanish.
- Sacred invariants kept: 4 s frontend poll, 30 s per-cell cache,
  12-concurrent semaphore, 140+ cell grid (densify only), upsert-by-id.
- AIS: Digitraffic 30 s unchanged; AISStream WS gets a
  reconnect-with-backoff audit.

### 6. CCTV layer (new)

Backend `apps/api/app/routes/cams.py`:

- Catalog assembled hourly (in-memory/Redis cache) from:
  - Digitraffic weathercam stations (Finland, keyless JSON, snapshot URLs).
  - US state DOT public feeds — ship 3–5 keyless states first; per-state
    adapter pattern for growth.
  - `cams.yaml`: hand-curated legal free-site cams (name, lat/lon,
    snapshot_url, optional hls_url, attribution, refresh hint).
  - Policy: owner-published feeds only. No unauthorized/Insecam-style cams.
- `GET /cams` → GeoJSON FeatureCollection (id, name, has_hls, attribution).
- `GET /cams/{id}/snapshot` → proxied JPEG with 60 s cache: dodges CORS,
  hides upstream, caps upstream load at one fetch/min/cam regardless of
  viewers.
- HLS URLs returned as metadata; played client-side with lazy-loaded
  `hls.js`; proxied only if CORS forces it.

Frontend:

- New layer adapter reusing `PollGeoJsonAdapter` (1 h poll — cams are static
  points), camera SVG icon added as a category in
  `apps/web/src/globe/adapters/styles.ts` (follows existing SVG category
  pattern — never a bare point), label via shared `labelStyle.ts`,
  clustering via existing EntityCluster handling.
- Click cam → EntityPanel: snapshot `<img>` auto-refreshing every 60 s;
  HLS player when a stream URL exists.

## Error handling

- Tile cache: stale-on-failure, never cache non-200, atomic writes.
- Cam snapshot proxy: upstream dead → last cached frame + staleness badge,
  else placeholder image.
- ADS-B: chain + breaker + SWR as above; `X-Stale` surfaces degradation.

## Testing

- pytest additions: tilecache hit/miss/stale/coalescing; `/tiles/sat`
  z-switchover; ADS-B failover (mock 429 → next source → stale serve); cams
  catalog parsing + snapshot proxy. Suite stays ≥ 25 passed.
- `pnpm -r typecheck` green at every commit boundary.
- Manual verification ritual (CLAUDE.md): Europe shows SVG icons not dots;
  click → magenta track < 4 s; 30 s soak with no icon blink. Added: `3d-sat`
  renders satellite + terrain with no ion token; cam click shows a live
  snapshot.

## Sequencing (each ships independently)

1. Tile cache + cache-wrap Carto (kills basemap 429s immediately).
2. `/tiles/sat` + `/tiles/terrain` + frontend free 3d-sat stack.
3. Google 3D gating.
4. ADS-B failover chain + SWR.
5. CCTV backend + layer.

## Verified source facts (2026-06-10)

- EOX Sentinel-2 cloudless: free WMTS, keyless, attribution required,
  non-commercial license for recent years (s2maps.eu).
- AWS Terrain Tiles: AWS Open Data, keyless, no requester-pays
  (registry.opendata.aws/terrain-tiles).
- ESRI World Imagery legacy tile endpoint: serves keyless; Esri encourages
  migration to keyed basemap services — ToS-gray, mitigated by cache (each
  tile fetched once) and source swappability behind the proxy.
