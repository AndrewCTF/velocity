# CLAUDE.md — Hard guardrails for any AI agent editing this repo

## Operator-visible behaviour that MUST hold

These are sacred. Subagents reviewing this file MUST verify their edit does
not regress any of them. If unsure, leave the relevant code path alone.

### Icons

- **Every aircraft and vessel renders as its category SVG**, never as a bare
  Cesium `point`/dot, never as a blue circle. The category dispatch lives in
  `apps/web/src/globe/adapters/styles.ts` (`aircraftStyle`, `vesselStyle`).
- Aircraft categories (with their colors):
  - airliner — `#facc15`
  - private  — `#2dd4bf`
  - helicopter — `#c084fc`
  - glider — `#93c5fd`
  - military — `#f59e0b`
  - emergency squawk — `#ef4444`, pulsing
- Vessel categories (with their colors):
  - cargo — `#14b8a6`
  - tanker — `#d97706`
  - fishing — `#5eead4`
  - passenger — `#38bdf8`
  - military — `#f59e0b`
  - sailing — `#a5f3fc`
  - pleasure — `#4ade80`
  - tug — `#c084fc`
  - SAR — `#ef4444`
  - dark-vessel candidate — `#ef4444`, diamond
- Aircraft icons rotate via `track_deg` → `-Cesium.Math.toRadians(track_deg)`.
- Vessel icons rotate via `cog` (or `heading` fallback).
- Selection magenta polyline `#d946ef` width 4 + black outline width 6.

### Refresh smoothness

- **Aircraft and vessels must update in place — never disappear and reappear**.
  `PollGeoJsonAdapter` uses upsert-by-id (`getById` → update billboard image /
  rotation / position), NOT `removeAll() + add()`. Any change that re-creates
  entities on every poll is a regression and must be reverted.
- `SampledPositionProperty` with `LinearApproximation` is used to interpolate
  between fixes — do not replace it with `ConstantPositionProperty` on
  existing entities or icons will jump.
- `requestRenderMode: true` must stay on. Continuous renders are reserved for
  the selection reticle / track polyline timer.

### Refresh cadence

- ADS-B global: 1 s frontend poll (`registry/defaults.ts` `ttlSec: 1`), backend
  sticky snapshot on a 1 s target cycle. Do not raise the poll above 10 s.
- AIS Digitraffic: 30 s. AISStream WS: live push.

### Aircraft count + sources (operator-visible)

- **The global snapshot must carry ≥8 000 aircraft** in steady state (~13 k is
  normal). A drop to a few hundred/thousand is a regression — see the
  `airplanes.live rate-limit 200+text` post-mortem.
- The feed is a UNION of tiers, deduped by `aircraft:<icao24>`
  (`apps/api/app/routes/adsb.py:_do_global_fanout`), freshest wins:
  1. **OpenSky `/states/all`** — the ~13 k breadth source. Works keyless
     (anonymous IP budget); falls back from authed→anonymous on 429. Throttled
     to one pull / 15 s and cached + served between pulls, so the count holds
     even after the daily credit budget is spent.
  2. **airplanes.live `/v2/point` grid** (`_GLOBAL_GRID`, 130+ cells) —
     dense-region freshness overlay, time-boxed (8 s) so a throttled grid can
     never stall the snapshot. Densify the grid only — never thin out.
- Upstream burst semaphore is **8** (`_UPSTREAM_SEMAPHORE`): airplanes.live
  rate-limits above ~8 concurrent `/v2/point` calls, and its limiter answers
  with HTTP 200 + a `text/plain` body (NOT just 429) — `_parse_ac` must reject
  non-JSON bodies, and `load_cell` must RAISE (not cache empty) on all-host
  failure. Do not "simplify" either away.
- The single-shot firehose URLs (`_FIREHOSE_URLS`) are dead from most egress
  IPs (airplanes.live `/v2/all*` 404, adsb.lol 451, adsb.fi 403) and are tried
  opportunistically with a 30 s dead-skip. OpenSky is the real breadth source.

### Labels

- Every aircraft has a label (callsign → registration → ICAO24).
- Every vessel has a label (name → MMSI fallback).
- Labels share `apps/web/src/globe/adapters/labelStyle.ts` (`labelFor`,
  `aircraftLabelText`, `vesselLabelText`). Bold IBM Plex Mono 11px, dark pill
  background, fill+outline. Do not duplicate or fork this style.

### Layers that must always work without any API key

- ADSB.lol + airplanes.live global ADS-B grid (no auth).
- Digitraffic Finland Baltic AIS (no auth).
- NASA FIRMS — needs MAP_KEY for fires (degrade gracefully when missing).
- USGS quakes (no auth).
- Carto Dark Matter basemap proxied via `/tiles/basemap` (no auth).

### Auth

- `apiFetch` and `withWsKey` wrap every browser → backend call. Do not bypass
  with raw `fetch` or raw `new WebSocket`. New transport must use them.
- WS handlers call `require_ws_key` BEFORE `accept`.

### Tests / typecheck

- `pnpm -r typecheck` must be green at every commit boundary.
- `cd apps/api && .venv/bin/pytest -q` must hold at ≥25 passed.

## Subagent rules of engagement

- One file, one owner. Multiple subagents may not edit the same file
  simultaneously. The dispatcher must serialise edits to a shared file or
  scope the brief to disjoint files.
- A subagent that "rewrites" `aircraftStyle`, `vesselStyle`, or
  `PollGeoJsonAdapter.applyStyle` MUST keep the SVG icons. Do not "simplify"
  to `Cesium.PointGraphics` unless explicitly asked.
- A subagent that touches `tracks.ts` dedup MUST keep at least one push per
  60 s OR 5° displacement so the selection polyline always has ≥2 points.
- A subagent that touches `requestRenderMode` MUST leave it `true` for the
  default scene.

## Verification before claiming done

- Boot the app, drag the camera to Europe, confirm hundreds of yellow
  airliners + orange military + green cargo icons (NOT dots).
- Click an aircraft, confirm the EntityPanel populates AND the magenta track
  polyline appears within 4 s.
- Click an empty area, confirm the polyline + reticle clear.
- Stay on the page for 30 s and confirm icons don't blink off-then-on.
