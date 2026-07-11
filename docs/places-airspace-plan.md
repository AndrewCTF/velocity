# Places & Airspace enrichment wave — implementation spec

Status: ready to build. Research + codebase mapping done & live-probed 2026-07-11
(scratchpad: `codebase-map.md`, `research-aviation.md`, `research-maritime.md`,
`research-airspace-bases-basemaps.md`). Every source below returned HTTP 200 from
this egress with the stated headers. Six agents, disjoint file ownership.

## Scope

Airport/port operational enrichment · TFR airspace layer · military-base layer ·
NGA naval-warnings layer · multi-basemap picker · NORAD/SATCAT enrichment. All
KEYLESS (CLAUDE.md invariant). No fabricated data — honesty constraints in §7.

## Agents & phases (dependency order)

```
Phase 0 (parallel-independent): D  — build scripts + committed JSON
Phase 1 (after D):               B1, B2 — backend routes/enrichment
Phase 2 (after B1/B2 routes up): F1, F2, F3 — frontend
```
F3 (basemaps) depends on NOTHING backend — may start in Phase 0. Tests: each
owner writes their own, listed per agent.

---

## §1 · Agent D — data build scripts (`scripts/build_places_data.py`)

Rerunnable, keyless, committed script(s); commit the JSON outputs too. Pattern
after existing `app/data/` loader (`places.py:26-44`, lru_cache + `Path(__file__)/data`).
Add a `__main__` self-check that asserts row counts + backward-compat keys (mirror
`places.py:221-240`).

**(a) `apps/api/app/data/airports.json` v2 — BACKWARD-COMPATIBLE.**
Source OurAirports `airports.csv` (85,721 rows). Keep EXACT existing keys
`{name, iata, icao, lat, lon, type, iso}` (`type` stays `large`|`medium`; the
bbox path filters on it — `places.py:182,188`). Filter to `type IN
(large,medium)` as today (~5.3k rows) so `bbox_features` stays fast. ADD small
scalars only: `elevation_ft`, `municipality`, `scheduled_service` (bool),
`military` (bool via name regex `AFB|Air Force Base|Naval Air|NAS |Army
Airfield|MCAS` — 298 hits, no source flag exists). **Do NOT inline runways/
frequencies** — 636KB → multi-MB would slow every bbox pull.

**`apps/api/app/data/airports_detail.json` — NEW, keyed by ICAO ident** (loaded
lazily only by entity enrichment, never by bbox). Per ICAO:
`runways[]` {le_ident, he_ident, length_ft, width_ft, surface, lighted, closed,
ils_category} from `runways.csv` (48,097 rows; no ILS field there) joined to FAA
NASR `ils_rf.txt` (US only, CATEGORY at fixed-width offset 173 w9 → `I|II|IIIA…`;
`ils_category=null` for non-US and non-ILS runways). `frequencies[]` {type, desc,
mhz} from `airport-frequencies.csv` (30,312 rows). Include detail for large+medium
ICAO idents only (keeps file bounded). NASR zip is 247MB — download once, parse
`ils_rf.txt`, don't commit the zip.

**(b) `apps/api/app/data/ports.json` v2 + `ports_detail.json` — REPLACE with WPI.**
Source NGA World Port Index CSV (3,804 rows, verified-live, plain curl):
`https://msi.nga.mil/api/publications/download?type=view&key=16920959/SFH00000/UpdatedPub150.csv`.
`ports.json` keeps backward-compat `{name, lat, lon}` + add `wpi` (World Port
Index Number, the stable join key). `ports_detail.json` keyed by `wpi`:
`harborSize, harborType, shelter, repairs, dryDock, railway, portSecurity,
harborUse, cargoPierDepth, channelDepth` (plain-text string values, NOT letter
codes — `Large|Medium|Small`, `Major|Moderate|Limited|None|Unknown`, etc.), and
`maxVesselLength|Beam|Draft` **only when >0** (sparse: 810/3804). Harbor size +
repairs + drydock are the reliable capability proxies (max-vessel is 0 even for
Singapore/Rotterdam).

**(c) `apps/api/app/data/bases.json` — NEW.** Wikidata SPARQL: direct `P31` of
`Q245016`(mil base)/`Q744099`(airbase)/`Q18691599`(naval base) with `P625`
coords = 7,195 rows (do NOT recurse subclasses — 504s). Row: `{name, lat, lon,
branch}` where `branch ∈ air|naval|army` from which Q-type matched. Optionally
merge Overpass PER-TAG pulls (`military=base|airfield|naval_base`, ~7k total; NOT
planet-wide union — times out). One flat file, bbox-served like airports.

**Owner-D tests:** `apps/api/tests/test_places_data.py` — load each committed
JSON, assert row counts (airports ≥5000, ports ≥3500, bases ≥7000), backward-compat
keys present on every row, detail files keyed correctly, `ils_category` null
outside US. No network.

---

## §2 · Agent B1 — backend: places detail, entity enrichment, METAR, SATCAT

Owns: `apps/api/app/places.py`, `apps/api/app/routes/places.py`,
`apps/api/app/routes/entity.py`, `apps/api/app/routes/weather.py`,
`apps/api/app/main.py` (ALL new-router registration — single owner; wires B2's
routers too, added last after B2 modules land).

- **`places.py`:** add `airports_detail()` / `ports_detail()` lru_cache loaders
  (mirror `airports()` :31-36); add `airport_detail(ident)` / `port_detail(wpi)`
  dict lookups; add `bases()` loader + extend `bbox_features` for `kind="base"`
  (emit props `{name, kind:"base", branch}`) or add a sibling `bases_bbox()`.
- **`routes/places.py`:** add `GET /api/places/bases` (bbox GeoJSON, copy
  `places_airports` :41-54 incl. `_parse_bbox` + `Cache-Control 86400`). Add
  optional `?detail=1` or a `/api/places/airport/{ident}` + `/api/places/port/{wpi}`
  detail endpoint — pick ONE style; enrichment (§below) is the primary consumer.
- **`routes/entity.py`:** at the kind dispatch (`:239-251`, pattern of
  `_enrich_aircraft`) add branches:
  - `airport:` → look up by IATA/ICAO code (id is `airport:{code}`, see
    `_airport_record` :65), merge base row + `airport_detail(icao)` (runways,
    frequencies, mil flag, elevation), attach LiveATC (`liveatc_url =
    https://www.liveatc.net/search/?icao=<icao>`, `candidate_mounts =
    [s1-fmt2.liveatc.net/<icao>_twr, …]` clearly labeled best-effort — search
    page is Cloudflare-403, mounts are guessable not enumerable). METAR is
    fetched frontend-side via §weather, or inline here if cheap.
  - `port:` → look up by `wpi` (id is `port:{slug}-{idx}` today — see
    `_port_record` :78; **note:** current id has no wpi. Extend `_port_record` to
    embed wpi in the id, e.g. `port:{wpi}`, OR resolve by name+coord. Prefer
    `port:{wpi}` and update the id scheme in `_port_record` — coordinate with
    F1's props). Return `port_detail(wpi)` fields.
  - `satellite:` → NEW branch keyed by NORAD id; return SATCAT row (owner, launch
    date/site, RCS, ops-status, period/apogee/perigee) from CelesTrak — honestly
    labeled `source:"CelesTrak SATCAT"`. (No satellite branch exists today —
    `:239-251` is aircraft/vessel/quake only.)
- **`routes/weather.py`:** add `GET /api/weather/metar?ids=KJFK,EGLL` — passthrough
  to `https://aviationweather.gov/api/data/metar?ids=<ids>&format=json` via
  `upstream.get_client()` + `TtlCache` 5min (`cache.get_or_fetch`, pattern
  `weather.py:30,65,106`). Return fields as-is (wdir, wspd, visib, altim, temp,
  dewp, clouds, fltCat, rawOb). Respects their 100 req/min ToS via cache. No
  METAR exists anywhere today (grep zero).
- **SATCAT data:** load `satcat.csv` (CelesTrak, 69,829 rows) — add a build step
  in §1/agent-D OR a daily `TtlCache` fetch in a small `app/satcat.py` loader.
  Prefer a committed `app/data/satcat.json` from agent D if cheap; else runtime
  cached. Keyed by NORAD_CAT_ID.

**Owner-B1 tests** (client fixture, `OSINT_DISABLE_BACKGROUND=1`,
`conftest.py:123-131`, NO live upstream — monkeypatch/fixture):
`test_places.py` (extend: bases bbox, detail lookups), new
`test_entity_places.py` (airport/port/satellite enrichment shape, 404→now-200),
new `test_weather_metar.py` (parse a committed `tests/fixtures/metar_kjfk.json`,
assert fltCat/wind passthrough, cached).

---

## §3 · Agent B2 — backend: TFR airspace + NGA warnings (NEW files)

Owns: `apps/api/app/routes/airspace.py` (new), `apps/api/app/routes/maritime.py`
(new). B1 registers both in `main.py`. Use `upstream.get_client()` + `TtlCache`.

- **`airspace.py` — `GET /api/airspace/tfr` (list GeoJSON) + lazy detail.**
  List: `https://tfr.faa.gov/tfrapi/exportTfrList` → JSON, 151 active, fields
  `notam_id,type,facility,state,description,creation_date` (TtlCache 10min).
  Detail: `https://tfr.faa.gov/download/detail_<id_underscored>.xml` (notam_id
  `6/4909` → `detail_6_4909.xml`), XNOTAM XML → parse:
  - Polygons: chained `<Avx codeType=GRC>` vertices `geoLat`/`geoLong`
    `"DDMM.mmmmN"`/`"DDDMM.mmmmE"` → decimal degrees.
  - Circles: `codeType=CIR` + `valRadiusArc`/`uomRadiusArc` (NM) around center →
    TESSELLATE ~64 points into a polygon ring.
  - Altitudes: `valDistVerLower/Upper` + `uomDistVerUpper` FT + `codeDistVer`
    HEI(AGL)/MSL.
  Emit GeoJSON `Polygon` features, props `{notam_id, type (reason), facility,
  state, description, alt_low, alt_high, effective}`. No GeoJSON variant upstream
  (`exportTfrGeoJson` 404) — we build it. Detail-fetch cached per id (10min).
- **`maritime.py` — `GET /api/maritime/warnings` (GeoJSON).**
  `https://msi.nga.mil/api/publications/broadcast-warn?status=active&output=json`
  — 503 bare, **200 with headers** `User-Agent`, `Accept: application/json`,
  `Referer: https://msi.nga.mil/home`. Occasional 503 self-clears <30s → RETRY
  (2-3×) + TtlCache 15min. 386 active; fields `msgYear,msgNumber,navArea,
  subregion,text,status,issueDate,authority`. Positions embedded in free `text`
  as `DD-MM.mmN DDD-MM.mmE` → **coord parser** (multiple coords per warning →
  emit a Point per coord, or MultiPoint). Flag `mine: true` when text matches
  `/\bMINE(S)?\b/i` (2 live hits). Emit Point features, props `{msgNumber,
  navArea, subregion, text, mine, issueDate}`.
- **ASAM: DO NOT BUILD** — endpoint-specific Akamai WAF, 503 even with full
  browser headers while broadcast-warn 200s (control-tested). Note as future
  (sidecar/browser fetch). NOTAMs: skip (FAA API 401, host unreachable).

**Owner-B2 tests:** new `test_airspace.py` (parse committed
`tests/fixtures/tfr_detail_6_4909.xml` → assert GRC polygon vertices in decimal
deg + CIR tessellation ≥64 pts + alt fields), new `test_maritime_warnings.py`
(coord parser on `DD-MM.mmN DDD-MM.mmE` strings incl. a mine warning →
`mine:True`; shape from `tests/fixtures/broadcast_warn.json`). No live upstream.

---

## §4 · Agent F1 — frontend layers (shared style files)

Owns: `registry/defaults.ts`, `normal/layerCatalog.ts`, `globe/LayerCompositor.ts`,
`globe/adapters/PollGeoJsonAdapter.ts`, `globe/adapters/styles.ts`,
`globe/adapters/labelStyle.ts`. Three new layers via existing `PollGeoJsonAdapter`
+ bbox/refreshOnMove wiring (`LayerCompositor.ts:369-375`).

- **`airspace.tfr`** — POLYGON layer. `PollGeoJsonAdapter.ts:1384` currently gates
  the polygon path on `styleKind === 'jamming'` — **widen that condition** to also
  accept `'airspace-tfr'`, and add a `tfrPolygonStyle(props)` (semi-transparent
  fill colored by `type`: SECURITY/VIP red, HAZARDS orange, AIR SHOWS/SPORTS blue,
  SPACE ops purple; outline solid). Reuse the `opts.polygon` block (:1389-1396,
  `PolygonHierarchy` + `ClassificationType.TERRAIN`). Endpoint `/api/airspace/tfr`.
- **`places.bases`** — icon per `branch` (air/naval/army SVG in `styles.ts`,
  category icons NOT dots — CLAUDE.md invariant). New `StyleKind 'base'`
  (`:222-231`), dispatch case (near airport `:1478`), `baseStyle(props)` in
  `styles.ts`, label in `labelStyle.ts`. Endpoint `/api/places/bases`, bbox +
  `PLACES_LOD_ALT_M` gating (`LayerCompositor.ts:110-147`).
- **`maritime.warnings`** — warning icon; `mine:true` → distinct style (e.g. red
  mine glyph). New `StyleKind 'warning'`, dispatch case, `warningStyle(props)`.
  Endpoint `/api/maritime/warnings`.
- Registry: add descriptors in `defaults.ts` (copy `places.airports` block
  `:618-645`, `visibleByDefault:false`, correct endpoint). Catalog toggles in
  `layerCatalog.ts` (copy `:118-119`): "TFR / Airspace", "Military bases",
  "Naval warnings". `LayerCompositor.ts` style dispatch (`:326-333`) map the three
  new layer ids → their StyleKind.

**Owner-F1 test:** extend `globe/invariants.test.ts` (or new
`globe/adapters/newLayers.test.ts`) — assert TFR uses polygon path, bases/warnings
emit billboards (icons not points), mine style distinct.

---

## §5 · Agent F2 — frontend entity panel (airport/port cards)

Owns: `globe/EntityPanel.tsx`, `globe/entity-panel/*` (new card components),
`transport/entity.ts`. Enrichment fetch already generic (`fetchEnrichment`
`:96-104` via `apiFetch`; `Enrichment` union `:92` has open `{kind:string}` member
— new kinds type-compatible). Add card branches like existing kinds
(`EntityPanel.tsx:221-693`).

- **Airport card:** runways TABLE (ident pair, length, surface, lighted; **ILS CAT
  badge** — show `—` when `ils_category` null, i.e. non-US or non-ILS); live METAR
  block (fetch `/api/weather/metar?ids=<icao>` via `apiFetch`): wind dir+speed with
  a heading arrow, visibility, **flight-category chip** VFR/MVFR/IFR/LIFR from
  `fltCat`, **fog indicator** derived from `fltCat` LIFR/IFR + low `visib`;
  frequencies list; LiveATC linkout (`liveatc_url`) + best-effort `<audio>` player
  over `candidate_mounts` (clearly labeled experimental — mounts may 404);
  military/civil badge from `military`.
- **Port card:** harborSize, harborType, shelter, repairs, dryDock, railway,
  portSecurity, harborUse; vessel-size limits (`maxVesselLength/Beam/Draft` — only
  render when present); depths (cargoPier, channel). Op-status shows "Unknown"
  unless WPI carries it (no live closure feed).
- `transport/entity.ts`: add typed members `AirportEnrichment` / `PortEnrichment`
  / `SatelliteEnrichment` (+ METAR sub-type) to the `Enrichment` union.

**Owner-F2 test:** new `entity-panel/placeCards.test.tsx` — render airport card
with US + non-US fixture (ILS badge shows CAT vs `—`), fog chip from fltCat, port
card renders WPI fields, hides absent max-vessel.

---

## §6 · Agent F3 — frontend basemap picker (no backend)

Owns: `state/stores.ts` (`ImageryMode` + `useImagery`), `globe/GlobeCanvas.tsx`
(basemap builders + swap logic), `command-bar/CommandBar.tsx` (picker UI). No
dependency on backend — may start immediately.

- Extend `ImageryMode` (`stores.ts:84`, today `'2d-dark'|'3d-sat'`) to a string
  union incl. `esri-imagery|esri-topo|esri-dark|opentopo|usgs-imagery|eox-s2`.
- `GlobeCanvas.tsx`: add `UrlTemplateImageryProvider` builders (pattern
  `buildDarkBasemap` :105 / `buildSatImagery` :115), extend swap logic (`:730-862`,
  `wantSat` :739) to select provider by mode. **Go DIRECT from browser** (these are
  third-party imagery hosts — Cesium provider, not `apiFetch`; the two existing
  basemaps use the `/tiles/` proxy for caching but touching `tiles.py` would break
  disjoint ownership, so new optional basemaps stream direct with attribution; a
  future pass can move them behind `/tiles/`). Exact URLs (all probed 200, keyless):
  - Esri World Imagery `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` (jpeg)
  - Esri World Topo `.../World_Topo_Map/MapServer/tile/{z}/{y}/{x}`
  - Esri Dark Gray `.../Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`
  - OpenTopoMap `https://a.tile.opentopomap.org/{z}/{x}/{y}.png` (2 req/s fair use)
  - USGS Imagery `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`
  - EOX s2cloudless `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg`
  (Note Esri/USGS are `{z}/{y}/{x}`; OpenTopo/EOX are `{z}/{x}/{y}`.) Render each
  provider's attribution string in the existing footer.
- `CommandBar.tsx`: replace binary `ImageryToggle` (`:40-41,76-79`) with a
  dropdown/segmented picker listing the modes.

**Owner-F3 test:** `command-bar/basemapPicker.test.tsx` — selecting a mode updates
`useImagery`; provider URL builder returns the expected template per mode.

---

## §7 · Honesty constraints (encode in UI + comments)

- **ILS CAT is US-only** (FAA NASR). `ils_category=null` outside US → render `—`,
  never guess from length/lighting.
- **No keyless airport capacity/hangar/MRO source** (Wikidata lacks it at scale).
  Derive capability PROXIES only: runway count, max runway length, large/medium
  class, scheduled_service. NEVER fabricate passenger/capacity numbers.
- **Port op-status = "Unknown"** unless WPI carries it — no live closure feed.
- **ASAM WAF-blocked** → warnings layer ships broadcast-warn only; ASAM = future.
- **NOTAMs skipped** (FAA API 401, host unreachable from egress).
- **NORAD = CelesTrak SATCAT** catalog data, labeled as such (no NORAD/NORTHCOM
  public API exists).
- **LiveATC** = search linkout + guessed mount URLs, labeled best-effort/experimental.

---

## §8 · File-ownership matrix (zero overlap)

| Agent | Creates / modifies |
|---|---|
| **D** | `scripts/build_places_data.py` (+ per-domain helpers); `app/data/airports.json` (v2), `airports_detail.json`, `ports.json` (v2), `ports_detail.json`, `bases.json`, `satcat.json`; `tests/test_places_data.py`; `tests/fixtures/*` it produces |
| **B1** | `app/places.py`, `app/routes/places.py`, `app/routes/entity.py`, `app/routes/weather.py`, `app/main.py` (all new router registration), `app/satcat.py` (if runtime); `tests/test_places.py` (extend), `tests/test_entity_places.py`, `tests/test_weather_metar.py`, `tests/fixtures/metar_kjfk.json` |
| **B2** | `app/routes/airspace.py`, `app/routes/maritime.py`; `tests/test_airspace.py`, `tests/test_maritime_warnings.py`, `tests/fixtures/tfr_detail_6_4909.xml`, `tests/fixtures/broadcast_warn.json` |
| **F1** | `registry/defaults.ts`, `normal/layerCatalog.ts`, `globe/LayerCompositor.ts`, `globe/adapters/PollGeoJsonAdapter.ts`, `globe/adapters/styles.ts`, `globe/adapters/labelStyle.ts`; `globe/adapters/newLayers.test.ts` |
| **F2** | `globe/EntityPanel.tsx`, `globe/entity-panel/*`, `transport/entity.ts`; `globe/entity-panel/placeCards.test.tsx` |
| **F3** | `state/stores.ts`, `globe/GlobeCanvas.tsx`, `command-bar/CommandBar.tsx`; `command-bar/basemapPicker.test.tsx` |

Shared-file coordination: `main.py` single-owner = B1 (registers B2's routers,
done last). No two agents touch the same file. F1 owns all shared style files
(`styles.ts`, `labelStyle.ts`, `PollGeoJsonAdapter.ts`) — preserve every invariant
in those (icons-not-dots, upsert-by-id, polygon gate).

---

## §9 · Verification

Baseline: **1209 passed + 1 skipped** — never commit below it; raise the number in
CLAUDE.md when new tests land.

```bash
# Backend unit (from repo ROOT — from apps/api the .env auth → 401 wall):
OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q

# Frontend + full gate:
pnpm -r typecheck
bash scripts/verify.sh              # typecheck + lint + web unit + api tests

# TestClient route probes (in a pytest or python -c against create_app):
#   GET /api/places/bases?bbox=-1,50,2,52       → FeatureCollection, ≥1 base
#   GET /api/entity/airport:KJFK                 → runways[], frequencies[], liveatc_url
#   GET /api/entity/port:<wpi>                   → harborSize/repairs/…
#   GET /api/entity/satellite:25544              → SATCAT owner/launch/RCS
#   GET /api/airspace/tfr                        → FeatureCollection of polygons
#   GET /api/weather/metar?ids=KJFK              → fltCat present
#   GET /api/maritime/warnings                   → FeatureCollection, some mine:true

# LIVE probes once backend boots (bash scripts/run-api.sh from ROOT, :8000):
curl -s 'http://localhost:8000/api/airspace/tfr' | head -c 300
curl -s 'http://localhost:8000/api/weather/metar?ids=KJFK' | head -c 300
curl -s 'http://localhost:8000/api/maritime/warnings' | head -c 300
```

UI check (hardware, not headless — GPU fps unmeasurable in Playwright): toggle
each new layer → category icons (not dots); TFR draws translucent polygons; click
an airport → EntityPanel runways table + METAR chip within 4s; switch basemaps →
imagery swaps without a blank globe. `apiFetch`/`withWsKey` on every browser→backend
call; new basemap providers are third-party hosts (scoped eslint-ignore, not
apiFetch).
