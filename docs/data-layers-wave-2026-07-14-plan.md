# Data layers wave — 12 new keyless feeds (2026-07-14)

Goal: add 12 genuinely-new data layers, each wired across **backend route + test**,
**MCP tool**, **frontend globe layer**, and **ontology linkage** (`kind:` id +
`/api/entity` enrichment) so "all data is linked and accessible in FE/BE/MCP".
Success = `bash scripts/verify.sh` green + `ruff check` clean + no regression
below pytest baseline 1630.

## Coverage check (verified 2026-07-14, grep of routes/)
Already built — DO NOT rebuild: GDELT `/api/events/gdelt`, EONET `/api/events/eonet`,
ACLED `/api/events/acled`, IODA+Cloudflare `/api/cyber/*outages`, NWS alerts
`/api/weather/alerts`, METAR, Open-Meteo forecast, SWPC **Kp index only**
`/api/weather/swpc/kp`, EMSC seismic, FIRMS, submarine cables, CelesTrak.

## The 12 (all keyless; #9 is self-derived from AIS)

| # | Feed | Route | Upstream (keyless) | kind | style |
|---|------|-------|--------------------|------|-------|
| 1 | GDACS global disaster alerts (severity-scored) | `/api/hazards/gdacs` | gdacs.org gdacsapi geteventlist/MAP (GeoJSON) | `disaster` | hazard |
| 2 | NIFC wildfire perimeters (polygons) | `/api/hazards/fire-perimeters` | services3.arcgis.com WFIGS Current (f=geojson) | `fireperim` | polygon |
| 3 | NHC tropical cyclones + cones | `/api/hazards/cyclones` | nhc.noaa.gov CurrentStorms.json + gis cone | `cyclone` | hazard/polygon |
| 4 | Smithsonian GVP volcanoes | `/api/hazards/volcanoes` | webservices.volcano.si.edu WFS (GeoJSON) | `volcano` | hazard |
| 5 | Safecast radiation | `/api/hazards/radiation` | api.safecast.org measurements.json | `radiation` | hazard |
| 6 | Air quality (PM2.5/AQI) | `/api/env/air-quality` | air-quality-api.open-meteo.com (keyless) | `airquality` | generic |
| 7 | Space weather ext (X-ray flares, storm alerts, aurora) | `/api/weather/swpc/space` | services.swpc.noaa.gov json/products | (data, no map pins) | — |
| 8 | NDBC marine buoys (wave/wind) | `/api/maritime/buoys` | ndbc.noaa.gov latest_obs | `buoy` | generic |
| 9 | Maritime chokepoint congestion (dwell/counts) | `/api/maritime/chokepoints` | **self-derived** from maritime snapshot | `chokepoint` | generic |
| 10 | ReliefWeb disasters (humanitarian) | `/api/hazards/reliefweb` | api.reliefweb.int/v1/disasters | `relief` | hazard |
| 11 | WRI global power plants (energy infra) | `/api/infra/powerplants` | WRI dataset (vendored static, keyless) | `powerplant` | facility |
| 12 | Aviation hazards SIGMET/AIRMET | `/api/aviation/sigmet` | aviationweather.gov airsigmet (f=geojson) | `sigmet` | polygon |

## Per-feed recipe (12×)
1. **Route** `routes/<name>.py`: URL const + `load()` that fetches, normalizes to a
   GeoJSON FeatureCollection with stable `id`=`<kind>:<rawid>`, `cache.get_or_fetch`.
   Register in `main.py` (import + include_router).
2. **Test** copy `tests/test_eq_route.py`: patch `httpx.AsyncClient.get`, autouse
   cache reset, assert FeatureCollection shape + cache dedupe.
3. **MCP** one `@mcp.tool()` → `shape(await _get("/api/…"), detail)`.
4. **Frontend** descriptor in `registry/defaults.ts` (`kind:'geojson'`, `emits`,
   `endpoint`, `refresh.ttlSec`). Points fall through to PollGeoJsonAdapter; polygons
   handled by its Polygon path. New StyleKind `'hazard'` in styles.ts (facilityStyle
   template) shared by hazard-family feeds; reuse `generic`/`facility` elsewhere.
5. **Ontology linkage** add each `kind` to `ObjectKind` Literal + `_KNOWN_KINDS`
   (ontology.py:61-81); add `/api/entity/{kind:id}` branch + `_enrich_<kind>` so any
   feed object resolves to enrichment and is promotable via existing actions.

## Shared helper (justified: 12× duplication)
Add `routes/_feedgeo.py::passthrough_geojson(key, url, ttl, transform=None)` wrapping
the cables.py idiom once. Keeps each route ~10 lines, one place for the 502/timeout
handling. Match local style otherwise.

## Reuse / linkage
- Hazard-family (1,3,4,5,10) share one StyleKind + `emits:['event']`.
- `/api/entity` enrichment makes every feed object clickable → correlations card
  (bus-keyed, automatic) → graph promote. That IS the "linked together".
- Chokepoint (#9) reuses `maritime.global_snapshot()`; no new upstream.

## Verification — DONE (2026-07-14, all green)
- `bash scripts/verify.sh` → **ALL GREEN**: typecheck ✓, eslint ✓, web unit
  355 passed, api **1645 passed + 1 skipped** (was 1630 baseline; +15 new tests).
- `ruff check apps/api` → All checks passed.
- `pnpm -r typecheck` → green (packages/shared + apps/web).
- Live upstream shape validation (curl -4, real data 2026-07-14): GDACS,
  Open-Meteo air-quality, NDBC (fixed-column text), WRI CSV headers, NHC (empty,
  off-season) — all field names / column positions match the parsers.
- Route behaviour proven via TestClient (builds real `create_app()`): 15 tests
  across all 12 routes assert FeatureCollection shape + id contract + 502-on-bad-
  upstream + entity resolution. NOT exercised: the already-running uvicorn picking
  up the new code (normal restart) — routes register + serve correctly under
  TestClient which is the same app factory.

## Shipped surface (per feed): route + main.py registration + MCP tool + globe
descriptor + hazard/hazardpoly/facility style + 2D catalog row + ontology kind +
/api/entity resolver. 12 feeds, 6 route files, 34→46 registry layers, 22→34 MCP tools.
