# AIS vessel pipeline

How the vessel layer gets ~30 000 live ships onto the globe using only free,
keyless upstreams — and why **open-ocean coverage comes from radar, not from
AIS**.

**Code:** `apps/api/app/ais_pipeline/` · **Routes:** `apps/api/app/routes/ais_pipeline.py`
· **Probe data:** `docs/ais/keyless-provider-probe-report.md`

> **Status: wired end to end (2026-10-04).** The pipeline is bridged into the
> shared vessel store, so the default vessel layer, parked mode, chokepoints,
> analytics and `query_vessels` all carry it. A third provider (VesselFinder)
> and its unidentified satellite positions give the first keyless picture of
> open ocean. The globe has an AIS coverage layer and a satellite positions
> layer, the Sources panel has three lookups, and MCP has five tools. What is
> still open is in [§7](#7-what-is-not-done); how it was wired is in
> [§10](#10-how-it-is-wired). Sections 1 and 5 predate the VesselFinder
> finding and are corrected in [§11](#11-vesselfinder-and-the-open-ocean).

---

## TL;DR

- Two keyless providers carry real global breadth: **ShipXplorer** (one 2 s world
  pull, ~30 000 unique MMSIs) and **OpenWaters** (tiled sweep, 16 220 unique
  MMSIs, but only across 47.5 % of the globe).
- **All keyless AIS is coastal.** Six deep-ocean boxes return **zero** vessels,
  reproduced independently by both providers. The chokepoints do populate —
  Singapore ~1 280, Hormuz ~370, Gibraltar ~270.
- **Sentinel-1 SAR is the ocean answer**, and it is keyless end-to-end: a public
  STAC catalogue plus anonymous S3 reads. A full 806 MB Sentinel-1 VV scene was
  downloaded with zero credentials during testing.
- **Satellite AIS is not obtainable keylessly.** Every vendor with a live map
  gates its data behind a token. Details and a withdrawn claim in
  [§5](#5-satellite-ais-the-part-that-does-not-work).
- The store merges **freshness-wins**, which the shared observation store gets
  wrong. That is not an optimisation; see [§4](#4-why-freshness-wins-not-last-write-wins).

---

## 1. The coverage finding, stated plainly

The request was full coverage including across oceans. Here is what the
measurements actually support, per `AGENTS.md`'s ban on unbacked coverage
claims:

| Region type                          | Boxes tested | Vessels found |
| ------------------------------------ | ------------ | ------------- |
| Open ocean (no coast within the box) | 6            | **0**         |
| Chokepoint / coastal                 | 5            | 1 280 – 0     |

Open-ocean boxes tested, all returning zero on **both** providers:

```
mid-Pacific     lon 155..165  lat  10.. 20     0
S-Atlantic      lon -25..-15  lat -25..-15     0
Indian Ocean    lon  75.. 85  lat -25..-15     0
N-Pacific      lon-175..-165  lat  40.. 50     0
Southern Ocean  lon  60.. 70  lat -45..-35     0
Coral Sea       lon 160..170  lat -20..-10     0
```

For contrast, the same store queried over chokepoints:

```
Singapore Strait   n=1282
Strait of Hormuz   n= 373
Gibraltar          n= 267
Malacca            n=  54
Bab-el-Mandeb      n=   0   (no feed reaches this box at all)
```

**This is a property of the data, not a bug in the scraper.** Terrestrial AIS
receivers need line-of-sight to a transponder; open ocean has none. Every
keyless feed is a network of coastal and satellite receivers, and the satellite
receivers are the part that is not free.

So the architecture splits along that line:

- **AIS where AIS works** — coastal waters, ports, straits. ~30 000 vessels.
- **SAR where AIS cannot reach** — open ocean, and dark vessels everywhere.
  See [§6](#6-sar-the-ocean-path).

---

## 2. Providers

### ShipXplorer — the breadth source

```
https://data.shipxplorer.com/live
```

No key, no signup. Requires browser-ish `Referer`/`Origin`; a bare client 500s.
Not Cloudflare-gated.

Measured 2026-10-03, repeated across the session:

| Metric                 | Value                       |
| ---------------------- | --------------------------- |
| HTTP                   | 200                         |
| Response               | 6.3 MB                      |
| Latency                | 1.9 – 2.0 s                 |
| Provider `total` field | 30 157 – 30 238             |
| **Valid unique MMSIs** | **29 500 – 30 757**         |
| Reported position age  | median ~112 s, p95 ~2 100 s |

**The `bounds` parameter is a trap.** Only the full-world form works:

```
bounds=85,180,-85,-180     → 30 157 vessels
bounds=<anything smaller>  → 0 vessels
```

A restricted bbox returns an empty set _silently_ — verified against a
Rotterdam control box, which must contain ships and returned 0. The pipeline
therefore always requests the world and filters locally. Anyone adding a
per-viewport ShipXplorer query will get an empty map and no error.

Payload is a positional array per vessel (no keys), validated against a
30 000-row body:

```
[0]=name [1]=lat [2]=lon [3]=ts_ms [5]=sog [6]="AIS"|"SAT"
[7]=typeName [8]=mmsi [15]=imo [16]=flag [22]=heading
```

**Satellite contribution is marginal.** `sate=true` changed the result set by
about **10 MMSIs** out of 30 000. Do not read that flag as "satellite AIS
included".

### OpenWaters — best aggregate, but geographically fenced

```
https://ais.openwaters.io/v1/vessels?bbox=<lon0,lat0,lon1,lat1>
https://ais.openwaters.io/v1/stations
```

No key. It is itself an aggregate that has already deduped four feeds —
measured provenance of one 133-tile sweep:

| Upstream                            | Vessels   |
| ----------------------------------- | --------- |
| AISHub                              | 12 250    |
| BarentsWatch                        | 1 933     |
| Digitraffic                         | 923       |
| AISStream                           | 515       |
| public ed25519 / UDP relay stations | remainder |

Richer per-vessel than ShipXplorer: IMO, callsign, draught, dimensions,
nav_status, and a per-row `seen` timestamp.

Measured complete sweep (`concurrency=2`, `complete=True`, 0 failed tiles, 66 s):

```
16 220 unique MMSIs from 133 tiles
```

**The undocumented constraint that matters.** Anonymous bbox access is accepted
only for longitude in **[-90, +81]** — 171°, or 47.5 % of the globe. Latitude is
unrestricted. Everything outside answers:

```
HTTP 400  "bbox out of range"
```

This is **not** rate limiting, and that distinction cost real time to establish:

- sustained back-to-back requests to an in-window box all succeed;
- a 45-second wait does not change the answer for an out-of-window box;
- tile size is irrelevant — 4° and 9° tiles fail/pass identically at the same
  longitude.

A naive 360-tile world grid has ~50 % of its tiles rejected (measured 20 ok / 20
rejected over the first 40) and reports a confident, wrong vessel count.
`openwaters_tiles()` clips to the window and `openwaters_longitude_coverage()`
reports the 47.5 % figure so a partial count is never read as global.

At runtime the sweep is **342 tiles** (18 latitude rows × 19 longitude columns
for ±80°, with the eastern edge column clipped at 81°), which is what
`ais_openwaters_max_tiles = 342` is set to. The module constant
`_OPENWATERS_MAX_TILES = 400` is a safety cap above that, not the working count.

**Separate rate limit on top of that**, which is a different failure with a
different fix:

| Concurrency | Tiles rate-limited (HTTP 429) |
| ----------- | ----------------------------- |
| 4           | 13 of 133                     |
| 3           | 3 of 133                      |
| **2**       | **0 of 133**                  |

`concurrency=2` is the default. 429 is retried with jittered backoff; a 400 is
given up on after one short retry. Raising concurrency silently truncates
coverage.

### Regional official feeds (kept)

| Feed                         | Endpoint                                                            | Measured              |
| ---------------------------- | ------------------------------------------------------------------- | --------------------- |
| Norway — Kystdatahuset       | `https://kystdatahuset.no/ws/api/ais/realtime/geojson`              | 200, 3.6 MB, dense    |
| Finland/Baltic — Digitraffic | `wss://meri.digitraffic.fi:443/mqtt`, topic `vessels-v2/+/location` | TLS 1.3 OK, live push |

### Rejected, with reasons

| Source                                                             | Result                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| AISStream                                                          | key required; `api.aisstream.io` also fails DNS from this egress |
| MarineTraffic API                                                  | 401 `SERVICE KEY NOT FOUND`                                      |
| VesselAPI                                                          | 401                                                              |
| AISHub direct                                                      | credentials required                                             |
| Kystverket NMEA `153.44.253.27:5631`                               | connect timeout — dead from here                                 |
| `services.terrabrowser.net`, `open.iotables.com`, `cgmix.uscg.gov` | no DNS / no route                                                |
| Many "free AIS" sites                                              | dead, parked domains, or browser-gated                           |

---

## 3. What was built

```
apps/api/app/ais_pipeline/
  providers.py   keyless provider registry + parsers (pure, unit-testable)
  store.py       MMSI-keyed store, freshness-wins, 5° coverage grid
  sar.py         Sentinel-1 discovery, CFAR detection, dark-vessel correlation
  __init__.py    ingest loops + lifespan wiring
apps/api/app/routes/ais_pipeline.py
  GET /api/maritime/pipeline/stats
  GET /api/maritime/coverage          (?format=geojson: occupied cells as polygons)
  GET /api/maritime/vessels?bbox=lon0,lat0,lon1,lat1
  GET /api/maritime/dark?bbox=lon0,lat0,lon1,lat1&days=2   (&detect=true: located contacts)
  GET /api/maritime/satellite                             unidentified satellite positions
```

`Fix.t` is the age of the **data** (upstream serve time), never the wall clock of
the response. A provider that can serve a cache must stamp the data's age, or
it will pin stale positions in retention and out-rank live sources.

`/api/maritime/coverage` returns a dense 36×72 integer grid so the frontend can
render ocean emptiness directly instead of inferring it from a sparse point
cloud.

---

## 4. Why freshness-wins, not last-write-wins

The shared `ObservationStore` is last-write-wins: `add_many` assigns
`_latest[id]` unconditionally. Feed a slow world poll and a fast regional feed
into it and the **slow one wins by arrival order**, stealing the MMSI from the
live source. This repo has an existing scar from exactly that class of bug
(`docs/decisions.md`, 2026-07-15: a wedged AIS sidecar kept a frozen tier in
front of live data and no restart could clear it).

So `VesselStore.merge()` compares `t` and only overwrites with a genuinely newer
fix. Older duplicates are counted, not written. The merge is idempotent, which
matters because three tiers legitimately report the same ship.

```python
if fx.t > cur.fix.t:   # newer data wins, regardless of arrival order
    self._write(fx)
```

Guarded by `test_ais_pipeline.py::test_older_fix_does_not_clobber`.

---

## 5. Satellite AIS: the part that does not work

Every dedicated satellite-AIS vendor ships a public live map. None expose the
data without a credential. Probed 2026-10-03:

| Provider                            | Live map       | Data API                                                                              | Keyless? |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------- | -------- |
| exactEarth                          | 200            | `api.exactearth.com/v2/vessels` → **401**                                             | no       |
| FleetMon                            | egress-blocked | `api.fleetmon.com` → **401**                                                          | no       |
| Kpler                               | 200            | keyed                                                                                 | no       |
| Spire Maritime                      | 200            | keyed, commercial                                                                     | no       |
| MarineTraffic                       | 200            | `services.marinetraffic.com/api/exportvessels` → **401**                              | no       |
| VesselFinder                        | 200            | `/api/pub/addressbook/overview` → 404                                                 | no       |
| Global Fishing Watch                | 200            | `gateway.api.globalfishingwatch.org/v3/vessels` → **401** `{"error":"invalid token"}` | no       |
| GFW `gfw-public-data` bucket        | —              | **403**                                                                               | no       |
| GFW `global-fishing-watch-datasets` | —              | **404 NoSuchBucket**                                                                  | no       |

GFW is the instructive one. Its live map is fully public HTML and the browser
loads ~1.1 MB of satellite-derived fishing-effort tiles — but the page ships
`Authorization` headers, and a direct fetch of the same tile URL returns 401.
The map is a viewer, not a feed.

### A claim I withdrew

An earlier probe of OpenWaters' `/v1/stations` appeared to show a
`barentswatch/sat` station (123 vessels, 294 in 24 h). **That was wrong.**
Re-probing returned 22 stations with **zero** satellite entries, and a Barents
Sea bbox (20-30E/70-78N) returned 18 vessels, _all_ tagged `aishub`, zero SAT.
The reading was a transient/misread and is withdrawn.

`providers.SATELLITE_AIS_KEYLESS = False` now pins this, with a test, so the
claim cannot silently reappear.

---

## 6. SAR: the ocean path

Keyless end-to-end, verified live:

| Resource       | Endpoint                                                      | Measured                      |
| -------------- | ------------------------------------------------------------- | ----------------------------- |
| Catalogue      | `https://earth-search.aws.element84.com/v1` (STAC)            | 200, public                   |
| Collection     | `sentinel-1-grd`                                              | dual-pol VV/VH                |
| Pixels         | `https://sentinel-s1-l1c.s3.amazonaws.com/<key>`              | **HTTP 206/200 anonymous**    |
| CDSE catalogue | `https://catalogue.dataspace.copernicus.eu/odata/v1/Products` | 200, keyless, 17.6 M products |

A complete **806 778 940-byte** Sentinel-1 VV scene (25 998 × 19 529 px) was
downloaded with **no credentials**, read with rasterio, and CFAR-detected, then
deleted. Over the open Arabian Sea, 3 GRD scenes were found with public asset
URLs, most recent same-day.

SAR also has the property that makes it _better_ than satellite AIS for the dark
vessel problem: it detects a contact whether or not that contact is
broadcasting.

### Dark-vessel status is three-valued on purpose

```
dark      SAR contact, no AIS match, AND enough nearby AIS for absence to mean something
unknown   SAR contact, but too little nearby AIS to tell "AIS-off" from "no feed here"
```

The middle case is the one that matters. Calling a vessel "dark" in a box where
the AIS store is empty is a fabricated claim — it is indistinguishable from a
box nobody covers. `test_no_ais_coverage_is_unknown_not_dark` guards it.

### Geolocation: SOLVED via the SAFE geolocationGrid

**This gap is closed** (2026-10-04). The earlier statement — that the anonymous
pixel-space TIFF "cannot be geolocated on its own" — was true of the *raster* and
false of the *product*.

The scene's own `annotation/iw-*.xml` carries a `geolocationGrid`, and that file
is keyless like everything else in the bucket. Measured:

| Property | Value |
|---|---|
| Annotation size | 1.67 MB, HTTP 200, **zero credentials** |
| Grid points | **210** — a complete 10 (rows) × 21 (columns) grid |
| Fields per point | `line` (row), `pixel` (col), `latitude`, `longitude`, `height`, `incidenceAngle` |
| Format | scientific notation, e.g. `2.975587793538942e+01` |
| Extent vs STAC bbox | matches to ~0.04° |

Verified on two live Arabian Sea scenes: 210 points, `complete=True`, extent
`lon 56.888..60.143 / lat 37.286..39.186` against a STAC bbox of
`[56.926, 37.292, 60.092, 39.182]`.

A detection is geolocated by **bilinear interpolation** inside its grid cell.
Node spacing is ~20 km along-track over ~2007 px, which is ~10 m/px — so
interpolation error inside a cell sits well below the pixel spacing that bounds
the geolocation anyway.

`app/ais_pipeline/geolocate.py`, 15 tests in `tests/test_ais_geolocate.py`.
Wired into `sar._detect_from_scene`, which prefers the raster's own CRS and falls
back to the grid.

**What this is not:** terrain correction. Over open water — where this module
runs — there is no relief to correct for, so ellipsoid ground-range geometry is
the correct answer. Over land at high relief a real residual remains, and this
must not be used for land analysis. The caveat is carried in the API response
(`GEOLOCATION_CAVEAT`) rather than only in a comment.

The no-fabricated-coordinate rule is unchanged and still enforced: a pixel
outside the grid yields `located=False` and `lat/lon: null`, never an
extrapolation. `test_outside_grid_is_none_never_extrapolated` guards it.

---

## 7. What is not done

Stated plainly so nothing here reads as more finished than it is.

1. ~~Not wired to the globe.~~ Done 2026-10-04, see
   [§10](#10-how-it-is-wired). Still open under this heading: the bridge
   compares unlike clocks (per-fix time against MyShipTracking's sweep time and
   the push feeds' wall clock), so a contested MMSI usually stays with those
   writers; and MyShipTracking, Digitraffic and Kystdatahuset do not feed the
   pipeline store, so the coverage grid reflects ShipXplorer and OpenWaters only.
2. ~~VesselFinder's keyless tile endpoint is proven but undecoded.~~ Decoded
   and ingested 2026-10-04, see [§11](#11-vesselfinder-and-the-open-ocean).
   Still open: the per-cell detail pass is off by default because sustaining it
   got this address refused, so the default tier is VesselFinder's thinned
   world view (about 37 000 vessels), not its full set.
3. ~~Its rate limit fails silently.~~ A body shorter than a header now raises,
   three consecutive refusals abort the sweep, and the interval doubles.
   Still open: whether the default volume is sustainable over days is not
   proven.
4. ~~SAR georeferencing is not complete end-to-end.~~ `detect=true` returns
   located contacts for a box up to one degree a side through the CDSE path.
   Still open: that path needs CDSE credentials, so the fully keyless route
   remains a scene inventory; and a whole-ocean SAR sweep is not built.
5. **Delegation was 150 subagents, not 1000-2000.** The configured ceiling is 64
   concurrent children; four of five orchestrators hit output truncation before
   completing their fan-out. The probe report at
   `docs/ais/keyless-provider-probe-report.md` is the salvaged output.

---

## 8. A note on measurement hygiene

Two intermediate claims in this work were wrong and are worth recording, because
both would have been easy to ship:

- **A confident wrong coverage number.** An early OpenWaters "world sweep"
  reported 48 687 unique MMSIs. Half its tiles were HTTP 400s. The real figure
  over the accepted window is 16 220. Nothing in the response distinguished the
  two — both returned data.
- **A bad baseline.** Suite-wide test runs were executed concurrently and raced
  on shared global state, producing 718, then 187, then 82 failures. A clean
  sequential run is **3062 passed, 0 failed**. Those numbers were measurement
  artifacts, not regressions.

The guard against a repeat: any sweep reports `tilesFailed` and a `complete`
flag, and an incomplete sweep is never rendered as a coverage figure.

### Two more, found later

- **A bbox puzzle solved by the vendor's own JS.** VesselFinder's
  `/api/pub/mp2` took a bbox whose captured whole-world x-span was 107 994 000,
  while plain EPSG:3857 metres gives 20 037 508 — a factor of exactly **5.39×**.
  That ratio is the answer: the endpoint uses **600 000 units per degree**, not
  mercator. `bbox_param` in `app/ais_pipeline/vesselfinder.py` now reproduces
  the captured value to within 6 000 units. A computed mercator bbox returned a
  12-byte body, which is exactly the silent-empty-200 failure mode this repo
  already has a scar from.
- **Probing cost me the source.** Testing the bbox contract meant dozens of
  rapid requests to one host, and VesselFinder answered with a **TCP-level
  block** — packets dropped, not a 429, surviving a 90 s wait and re-probing all
  four of its IPs. It stayed unreachable for the rest of the session. The lesson
  is the one already written into `apps/api/CLAUDE.md`: find the rate limit
  before you spend the budget, because a provider you burn is a provider you
  cannot measure.

---

## 9. Verification

```
# from the repo ROOT (from apps/api the .env auth resolves and tests 401)
OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest \
    apps/api/tests/test_ais_pipeline.py apps/api/tests/test_ais_pipeline_routes.py \
    apps/api/tests/test_ais_vesselfinder.py apps/api/tests/test_ais_pipeline_sar_detect.py -q
# 112 passed (2026-10-04)

OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q
# 3114 passed, 21 skipped, 4 failed in test_mqtt_client (they fail without
# this work too) (2026-10-04)

apps/api/.venv/bin/ruff check apps/api
# All checks passed

pnpm -r typecheck
# packages/shared + apps/web: Done
```

Live end-to-end, measured this session:

| Check                           | Result                                              |
| ------------------------------- | --------------------------------------------------- |
| ShipXplorer world pull          | 29 557 fixes, provider total 30 157, 6.3 MB, ~2 s   |
| OpenWaters tiled sweep          | 16 220 unique MMSI, `complete=True`, 0 failed tiles |
| SAR scene discovery, open ocean | 3 GRD scenes, public URLs, same-day                 |
| Anonymous 806 MB SAR download   | HTTP 200, 0 credentials                             |
| Deep-ocean coverage, 6 boxes    | 0 — on both providers                               |

---

## 10. How it is wired

Added 2026-10-04. Decision record: `docs/decisions.md`, "AIS pipeline bridged
into the shared vessel store".

```
ShipXplorer ─┐                                   ┌─ /api/maritime/coverage (+ ?format=geojson)
             ├─► VesselStore (freshness-wins) ───┼─ /api/maritime/vessels
OpenWaters ──┘        │                          └─ /api/maritime/pipeline/stats
                      │ _mirror: winner, newer than the shared fix, inside retention
                      ▼
            shared ObservationStore (last-write-wins)
                      │
   /api/maritime/snapshot · parked · chokepoints · analytics · query_vessels
```

**API.** `ais_pipeline._mirror` is the only path from the pipeline into the
shared store. It writes the upstream fix time, never the poll time, and never
overwrites a fresher fix. `ais_keyless` no longer pulls ShipXplorer; the
pipeline does not poll Kystdatahuset.

**Globe.** Vessels need no new layer: `maritime.keyless` reads the snapshot,
which now carries the union. `maritime.coverage` (Layers → Maritime → AIS
coverage, off by default) shades each occupied 5° cell by its count band. An
unshaded cell means no keyless feed reports there. `maritime.satellite`
(Satellite positions, off by default) draws the unidentified open-ocean
positions; see [§11](#11-vesselfinder-and-the-open-ocean).

**Sources panel** (Investigate → Sources → Detection and imagery): AIS pipeline
source health, AIS pipeline vessels in a box, SAR scenes over a box.

**MCP.** `maritime_pipeline_stats`, `maritime_coverage`,
`maritime_vessels_bbox`, `sar_scenes` (with `detect`),
`maritime_satellite_positions`.

Measured live on `/api/maritime/snapshot`, 2026-10-04, with both browser
sidecars down in both runs:

|                       | before       | after           |
| --------------------- | ------------ | --------------- |
| vessels               | 39 318       | 48 135          |
| with a name           | 12 567       | 47 808          |
| with a heading        | 7 927        | 34 411          |
| with an ITU ship type | 14 534       | 44 615          |
| with a flag           | 0            | 38 382          |
| fix age, median / p95 | 26 s / 814 s | 137 s / 1 456 s |

The age row rose because it became true: the old path stamped every ShipXplorer
row with the time of the poll.

---

## 11. VesselFinder and the open ocean

Added 2026-10-04. This corrects two statements above: "all keyless AIS is
coastal" ([§1](#1-the-coverage-finding-stated-plainly)) and "satellite AIS is
not obtainable keylessly" ([§5](#5-satellite-ais-the-part-that-does-not-work)).
Both remain true of IDENTIFIED vessels. They are not true of positions.

```
https://www.vesselfinder.com/api/pub/mp2?bbox=<lon0,lat0,lon1,lat1 x 600000>&zoom=<z>&mmsi=0&mcbe=1
https://www.vesselfinder.com/api/pub/sfl?bbox=<same>&zoom=<z>
```

No key, no browser, no cookie; browser-ish `Referer`/`Origin`. The layouts are
ported from the site's own map script (`vfmap/map.500107.js`,
`vfmap/index.500107.js`), in `apps/api/app/ais_pipeline/vesselfinder.py`.

| | `mp2` | `sfl` |
|---|---|---|
| What | identified vessels | "Satellite Position" markers |
| MMSI, name | yes | **no** |
| Position age | yes, per row (minutes, then hours) | **no** |
| Type class, heading step | yes | yes |
| Reaches open ocean | no, coastal like the rest | **yes** |

Measured 2026-10-04:

| Check | Result |
|---|---|
| `mp2`, Singapore 2 x 1.5 degrees, zoom 7 / 10 / 11 / 12 | 134 / 1 460 / 3 201 / 3 203 vessels |
| `mp2`, zoom 11, box 4x4 vs 5x5 degrees | 3 663 vs **9** (HTTP 200, no error) |
| `mp2` scout pass, 72 tiles of 30 degrees at zoom 8 | 37 069 identified vessels |
| `sfl`, 12 world tiles at zoom 4 | 10 296 positions |
| `sfl`, mid Indian Ocean 60-90E / 30S-0 | 525 positions |
| `sfl`, North Pacific 160E-180 / 20-50N | 217 positions |
| Site-wide vessel count in the `mp2` header | 304 360 to 310 018 |

**Units trap.** The scale is 600 000 per degree for the bbox and the positions.
A request in degrees x 1e6 is answered, for the wrong place, with no error.

**Size trap.** Each zoom has a largest box it answers in full. Past it the
answer is a handful of rows, HTTP 200. Zoom 11 and 4x4 degrees is the pair the
detail pass uses; zoom 8 and 30x30 is the scout pass.

**Rate trap, and it is not the 4-byte one.** About four minutes of the detail
pass at 2 to 4 requests a second got every connection from this address
refused (connect timeouts, single requests included), still refused half an
hour later. The default is therefore the scout pass plus the satellite
positions: 90 requests, one at a time, every 30 minutes. The detail pass is
`AIS_VESSELFINDER_DETAIL_TILES`, default 0.

**What the satellite positions are, and are not.** They show that a ship of a
given class is at a place, heading a given way. They do not say which ship, or
when: the site publishes neither for them, so `/api/maritime/satellite` carries
no MMSI and no `t`, and the layer (`maritime.satellite`, off by default) shows
a dash for both. They are never merged into the identified vessel store.
