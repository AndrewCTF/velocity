# Frontend Specification — OSINT Geospatial Console

Companion to `@research.md` (data sources, APIs, backend architecture). This file governs the **frontend only**: stack, design tokens, layout, components, and behavior. Where this file and `research.md` disagree on frontend matters, this file wins.

---

## 1. Stack

- **Build**: Vite + TypeScript + React 18.
- **3D/4D engine**: CesiumJS (latest stable). Primary canvas. Use `Cesium.Viewer` with custom widgets disabled and rebuilt in React (we control timeline/animation chrome ourselves).
- **2D fallback**: MapLibre GL JS v5 at route `/2d` (globe projection enabled). Shares the same data layer config object as Cesium.
- **State**: Zustand (one store per domain: `layers`, `selection`, `time`, `feeds`, `alerts`). No Redux.
- **Styling**: Tailwind CSS with the custom token theme below + CSS variables. No component library that imposes its own visual language (no MUI/AntD). Headless primitives only (Radix) for menus/dialogs/sliders.
- **Data transport**: native `WebSocket` for AISStream/alert push (proxied via backend), `fetch` with TanStack Query for REST polling. All keys are backend-proxied — **frontend holds no API keys** except the Cesium ion token injected at runtime from `/api/config`.
- **Icons**: Tabler outline (webfont).
- **Fonts**: `IBM Plex Mono` (all machine values) + `Inter` (labels/prose).

---

## 2. Aesthetic — "modern defence", credible not theatrical

Three hard rules. Violating these makes an operator distrust the tool.

1. **Dark substrate, luminous data.** Chrome is near-black/charcoal, low-saturation, matte. The *only* saturated color in the UI belongs to data and alerts. Default state of the screen is calm; an anomaly is the only bright thing on it.
2. **One accent + strict semantic color.** One brand accent (cyan `#2dd4bf`) for interactive affordances and selection. Red/amber/green mean **threat state only**, never decoration. Color must never lie about danger.
3. **Motion means state change.** Restrained motion only: selection reticle slow-pulse, camera slew (eased fly-to ~800ms), new detections fade in ~400ms. Never animate idle chrome. Respect `prefers-reduced-motion`.

Depth via layering (border-opacity + faint top-edge highlight), **not** drop shadows. Floating panels sit over the globe at 85–92% opacity so spatial context is never fully lost. Monospace tabular figures for all numerics so updating columns don't jitter.

---

## 3. Design tokens

Source of truth is `apps/web/src/theme/tokens.css` (dark `:root` + a
`[data-theme='light']` override); Tailwind exposes each token as a utility in
`tailwind.config.js`. The palette is **warm ink** — an amber-shifted dark grey
lifted well off black, with a soft sky-steel accent — not the old cool-blue.

```css
:root {
  /* substrate — warm dark ink */
  --bg-0:#191817; --bg-1:#201f1d; --bg-2:#282623; --bg-3:#322f2b; --bg-4:#3f3b36;
  --line:rgba(255,246,234,0.08); --line-2:rgba(255,246,234,0.15);
  /* text — warm greys */
  --txt-0:#f5f2ed; --txt-1:#c0b9ae; --txt-2:#8e8880; --txt-3:#6a645b; --txt-4:#494440;
  /* accent (interactive/focus) — soft sky-steel blue */
  --accent:#6fb1dd; --accent-dim:rgba(111,177,221,0.14); --accent-line:rgba(111,177,221,0.45);
  --accent-fg:#9cc2ff; /* lightened accent text on --accent-dim */
  /* SEMANTIC — threat state ONLY. Each family: base / -bg tint / -line / -fg text */
  --warn:#f5a524; --warn-bg:rgba(245,165,36,0.12); --warn-line:rgba(245,165,36,0.38); --warn-fg:#fcd9a0;
  --alert:#ff5a52; --alert-bg:rgba(255,90,82,0.13); --alert-line:rgba(255,90,82,0.38); --alert-fg:#ffc9c5;
  --ok:#4ed3a1; --ok-bg:rgba(78,211,161,0.12); --ok-line:rgba(78,211,161,0.35);
  /* magenta — selection / correlation lineage (matches globe polyline family) */
  --mag:#e25bef; --mag-dim:rgba(226,91,239,0.14); --mag-line:rgba(226,91,239,0.5); --mag-fg:#f0a8f8;
  --sev-low:#cdc9c0;
  /* radii — hard-cornered, instrument-grade */
  --r-sm:2px; --r-md:3px; --r-lg:5px;
  /* z-scale — map<rail<dock<overlay<dropdown<modal<wizard<toast (0/100/200/400/500/600/700/800) */
  --font-mono:'IBM Plex Mono',monospace; --font-sans:'Inter',sans-serif;
}
```

Type scale (tokens `--fs-body/-dense/-caption`, floor 10px): 10px mono
(micro-labels, units), 11px (IDs, ticker), 12px (body/secondary), 13–14px
(entity names, headings). Weights 400/500/600. **Sentence case everywhere**
except machine codes (UNCLAS, MMSI). Letter-spacing 0.5px on mono micro-labels.

Shared feedback primitives live in `src/shell/`: `InlineAlert`
(tone=info|warn|alert|ok) for inline rows and `toast.ok/warn/error()` +
`<ToastHost/>` for transient notifications — both token-driven; do not
hand-copy the tint classes.

---

## 4. Layout — five zones

The read loop the layout serves: **scan → detect → orient → drill-in → correlate → decide → annotate/hand-off.**

```
┌──────────────── TOP: command bar (44px) ───────────────────┐
│ search · AOI selector · alert ticker · CLASS · feed health  │
├──────┬───────────────────────────────────────┬─────────────┤
│ LEFT │                                        │   RIGHT     │
│ rail │            GLOBE (truth surface)       │   rail      │
│ what │      3D / 4D / 2D · never covered      │  what's     │
│ exists│            by permanent chrome        │  selected   │
│ 280px│                                        │   320px     │
├──────┴───────────────────────────────────────┴─────────────┤
│ BOTTOM: timeline — transport · scrubber · density strip     │
└─────────────────────────────────────────────────────────────┘
```

Globe is the substrate; panels float over its edges and **collapse**. Globe is never covered by permanent chrome.

### 4.1 Top — command bar
Persistent, 44px. Left→right: **unified search** (one field resolving MMSI/ICAO24/IMO/callsign/vessel name/lat-lon — never per-domain boxes); **AOI selector** (saved bboxes: Baltic, Bab-el-Mandeb, Taiwan Strait…); **alert ticker** (correlation hits slide in); **classification banner** (UNCLAS — anchors command feel, audience muscle memory); **feed-health cluster** (per-source dot OpenSky/AISStream/GFW/FIRMS — green/amber/red; must distinguish "no contacts" from "no data").

### 4.2 Left — what exists
Top: **layer/source tree** grouped Maritime / Aviation / Imagery / Signals / Hazards / Infrastructure. Per layer: opacity slider, "bind to timeline" toggle, live count badge. Bottom: **filterable entity list** — sort by proximity to AOI centre / anomaly score / last-seen. Filtering is client-side (no round-trip to sort).

### 4.3 Right — what's selected
Populates instantly on globe click. Stacked cards:
- **Header**: name, type, flag, ID (mono), last-seen, state badge.
- **Track**: sparkline of recent positions; speed/course (mono).
- **Enrichment**: lazy-loads from source API (vessel → GFW record + port calls; aircraft → reg/operator/type).
- **Correlation** (the reason the platform exists): surfaces other feeds touching this entity — e.g. "AIS gap 4h + Sentinel-1 SAR detection 2.1 km, same window → dark-vessel candidate". Action row: **Slew to [correlated contact]**, **Flag**. The slew flies the Cesium camera to the correlated feature (~800ms eased) — physically links two feeds in the operator's spatial memory.

### 4.4 Bottom — time (4D workhorse)
Three integrated parts: **transport** (play/pause, speed multiplier 1×–3600×, step-frame); **scrubber** with playhead; **temporal density strip** — thin histogram under scrubber. Detections/AIS-gaps/alerts render as ticks (alert=red, detection=amber, density=grey). Right-click tick → jump; drag → set replay loop window. The strip means the operator scrubs straight to activity, never plays through dead hours.

---

## 5. Globe behavior (Cesium)

- Boot: `Cesium.Terrain.fromWorldTerrain()`, ion token from `/api/config`. Disable default `geocoder`, `baseLayerPicker`, `homeButton`, `navigationHelpButton`, `fullscreenButton`, default `timeline`/`animation` (rebuilt in React).
- **SceneMode**: expose 3D / Columbus(2.5D) / 2D switch in the left rail header. In-Cesium switch — same CZML, no code-path divergence.
- **3D buildings**: `Cesium.createOsmBuildingsAsync()` (free, Asset 96188) as default. Google Photorealistic 3D Tiles behind an opt-in env flag only (`VITE_ENABLE_GOOGLE_3D`) — see `@research.md` for billing caveats; gate hard, default off.
- **Entities**: ≤5,000 live `viewer.entities`. Beyond that, batch into `PointPrimitiveCollection` updated in a `clock.onTick` handler. Throttle CZML batch updates ≥250ms. `requestRenderMode:true` to cut idle CPU.
- **4D**: bind moving entities to `SampledPositionProperty`; LINEAR interp for AIS/ADS-B, LAGRANGE deg 2–5 for satellites. CZML schema/examples in `@research.md` §12 — frontend consumes CZML emitted by `/api/czml/replay`.
- **Selection**: `viewer.selectedEntity` drives the right rail. Selected feature gets a slow-pulse reticle billboard. Camera **slews**, never cuts.

---

## 6. Components (build order)

1. `<ConsoleShell>` — five-zone CSS grid, collapse logic, dark theme provider.
2. `<GlobeCanvas>` — Cesium mount, scene-mode switch, layer compositor reading the shared layer config.
3. `<CommandBar>` — search, AOI selector, ticker, classification, feed-health dots.
4. `<LayerRail>` — source tree + filterable entity list (left).
5. `<EntityPanel>` — header/track/enrichment/correlation cards (right). Track sparkline as inline SVG.
6. `<Timeline>` — transport + scrubber + density strip; binds to Cesium `clock`.
7. `<AlertLayer>` — WebSocket consumer; pushes ticks to timeline strip + slide-in ticker + optional toast.
8. `/2d` route — MapLibre mirror consuming the same layer config + GeoJSON endpoints.

---

## 7. Performance & UX musts

- 60fps target on a mid GPU at ≤5k entities; degrade to primitives gracefully.
- Per-feed cache TTL matches upstream cadence (see `@research.md` §16): 5s ADS-B, 30s AIS aggregate, 10min FIRMS, 6h SAR tiles, 24h terrain.
- Loading vs empty vs error are **three distinct states** per layer (operator must never confuse "no data" with "nothing there").
- Keyboard: `/` focus search, `space` play/pause, `[`/`]` step frame, `f` flag selected, `g/c/2` scene mode.
- All numerics through `Math.round`/`toFixed`/`toLocaleString` — no float artifacts on screen.
- `prefers-reduced-motion`: disable reticle pulse, slew becomes instant set, fades become instant.

---

## 8. Out of scope (frontend)

Auth/multi-user, data ingestion, detector models, key management — all backend, per `@research.md`. Frontend assumes a working backend exposing: `/api/config`, `/api/aviation/states`, `/api/ais/stream` (WS), `/api/sar/dark`, `/api/firms`, `/api/eq`, `/api/czml/replay`, `/api/tiles/*`, `/api/alerts` (WS), `/api/search`, `/api/entity/{id}`.
