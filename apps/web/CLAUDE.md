# apps/web — invariants for the globe and dashboard

Repo-wide rules and the operating method: `/CLAUDE.md`. Decision history and
post-mortems: `docs/decisions.md` — read the entry before changing any guarded
behavior below. Backend-side rules that these depend on: `apps/api/CLAUDE.md`.

Everything here is enforced by a guard; `bash scripts/verify.sh` runs them all.
A guard failure means an operator decision regressed — fix the code, or revoke
the decision deliberately by changing BOTH the guard and this file.

## Icons / labels

- Category SVG icons only, never bare points; palette + dispatch in
  `globe/adapters/styles.ts`; shared label style in `labelStyle.ts`
  (callsign→reg→ICAO24, name→MMSI). → `src/globe/invariants.test.ts`
- Aircraft rotate by `track_deg`, vessels by `cog`/`heading`. Selection
  polyline `#d946ef` w4 + black outline w6; `tracks.ts` dedup keeps ≥1 push
  per 60 s or 5° so the polyline always has ≥2 points.

## Refresh / motion

- `PollGeoJsonAdapter` upserts by id — never `removeAll()+add()`.
  → eslint rule + `invariants.test.ts`
- DEFAULT aircraft motion = TELEPORT to real fixes; never synthesize motion on
  the default path (operator rejected glide/dead-reckoning repeatedly).
  Sanctioned opt-in exceptions — do NOT delete as regressions:
  `aircraftDeadReckon` toggle (OFF default) and `continuousRenderGovernor`
  toggle (OFF default), both in `state/settings.ts`. → `docs/decisions.md`
- With `aircraftDeadReckon` ON the motion model is ANALYTIC
  (`globe/adapters/deadReckon.ts`): `pos(t) = advance(anchor, track_deg,
  velocity_ms * max(0, t - t0))`. Speed is EXACTLY the reported `velocity_ms`
  and it can NEVER reverse — both structural, both operator requirements
  (2026-07-14). Never ease/interpolate TOWARD a fix (makes speed arbitrary +
  glides backwards); never fit velocity from consecutive fixes (only 13.5% land
  within ±10% of reported). → `globe/adapters/deadReckon.test.ts`
- Position-unchanged SKIP still refreshes the entity PropertyBag; only the
  restyle is skipped. Vessels keep their `SampledPositionProperty` glide.
- `requestRenderMode: true` + `maximumRenderTimeChange: 0` in GlobeCanvas
  viewer opts. → `invariants.test.ts`
- Poll on an absolute wall-clock grid (`scheduleNext`), not `ttl - elapsed`.
- Satellite SGP4 via `SampledPositionProperty` is real physics, exempt from the
  no-synthesis rule; propagation stays chunked.

## Colour schemes

- `theme/schemes.ts` is the registry; each entry has a COMPLETE palette block in
  `theme/tokens.css` (`dark` is the bare `:root`). A scheme that only overrides
  what it feels like inherits the default's `--hover`, shadows and scrollbar
  thumb, which is how the light theme shipped a near-black row hover on white.
  → `theme/contrast.test.ts` (AA on bg-1 AND bg-2 per scheme, registry ↔ CSS
  agreement, swatch ↔ palette agreement)
- Chrome drawn on the Cesium canvas or on its own pinned near-black surface
  carries `.on-dark` (or the `map-foot-item` classes), which keeps the dark text
  ramp under the light-family schemes. The globe is dark in every scheme. A
  surface that means to be dark must be OPAQUE: `bg-black/40` over a white panel
  is a mid grey, which is how the City viewport reached 2.42:1.
- A hue is a FILL or it is INK, never both. `bg-accent` is `--accent`;
  `text-accent` resolves to `--accent-fg` (tailwind.config.js splits
  `textColor`), and text ON a solid fill uses `--on-accent` / `--on-mag` /
  `--on-alert` / `--on-ok` / `--on-warn`, which each scheme states for itself.
  A literal `text-white` on a fill measured 2.14:1 on Night watch's amber.
  → `theme/contrast.test.ts` holds every fill/ink and `-fg`/substrate pair to AA
- The ramp is guaranteed on `bg-1` and `bg-2` ONLY. Text on `bg-3`, on a
  `*-dim` tint or on a `*-bg` tint is a step lighter and has to be checked;
  three of those measured 4.37-4.47:1. When in doubt take one tier brighter.
- Verify a scheme in the BROWSER, not from the tokens: walk every rendered text
  node, composite its real background, and check the ratio. The token guard is
  necessary and not sufficient — it cannot see a tint, a pinned surface or a
  glyph used as a swatch. Baseline 2026-08-05: 7 schemes x 17 surfaces = 119
  sweeps, 42,478 text nodes, 0 failures.
- The browser sweep is not sufficient EITHER: a hover state is not in the DOM
  until something is hovered, and Daylight shipped a `--hover` putting the muted
  tier at 4.39:1 that the sweep could not see. Hover is a token pairing, so the
  token guard owns it. Composite ALPHA when you measure — reading a tint's hue
  and dropping its alpha compares text against a colour never painted at
  strength, and will report every scheme as broken.
- The four `bp-*` schemes are Palantir's published Blueprint ramp
  (`theme/blueprint.ts`, extracted from `@blueprintjs/colors@5.1.16` — the same
  version the console's metrics are calibrated against). `blueprint: true` in
  `schemes.ts` is a CHECKED claim: the guard rejects any token outside the
  published set except `--hover` (no in-ramp step cleared the floor, the call
  gotham.css already documents) and the selection magenta (welded to the globe
  polyline, so it is data). Regenerate with the `npm pack` recipe in that file.

## Auth

- `apiFetch` / `withWsKey` wrap every browser→backend call; raw `fetch` only
  for third-party hosts via scoped eslint ignore. → eslint +
  `invariants.test.ts`

## Controls state what they do

- A control that renders must run. The File/Edit/View bar, the four panel tabs
  and the action bar each shipped as chrome that highlighted and did nothing;
  the tabs stayed clickable under a full-bleed app that had removed the column
  they open into. If a key or a shortcut is PRINTED (a menu hint, a tab
  tooltip), something must be listening for it.
  → `shell/liveControls.test.ts` (every `<button>` under `shell/` has a handler
  or is `disabled`), `shell/Console.test.tsx`, `shell/ActionBar.test.tsx`,
  `shell/TitleBar.menus.test.ts`
- The action bar reports `useFilters` / `useSelection`. Never a literal sentence.
- A surface is reachable at ONE named address. `More` exists so a rail item
  added tomorrow cannot vanish, not as somewhere to leave work: it held six
  surfaces, five of them a second copy of something already homed elsewhere, and
  a duplicate is a second place to find a stale one.
  → `shell/panels.test.ts` (no `pending` list, no panel declared that App.tsx
  does not fill), `shell/rehoming.test.ts` (each address renders, and renders
  once)

## Copy / voice (2026-07-15, docs/decisions.md#dashboard-copy-one-voice-no-em-dashes-2026-07-15)

- Dashboard copy carries NO em dashes. Labels separate with ` · ` (subject-first
  order clusters sibling layers in the rail); prose gets a real rewrite, not a
  blanket colon swap. Comments are NOT copy and keep their em dashes.
- A lone `'—'` means "no value reported" and is the §7 never-guess rule in the
  UI. Never strip it while "removing em dashes".
  → `entity-panel/placeCards.test.tsx`
- Errors the user sees are sentences that keep the code (`Cameras unavailable
  (HTTP 503)`), never raw internals (`cams 503`). Lowercase micro-labels
  (`loading…`, `saving…`) STAY: that register is deliberate, not sloppiness.
- TRACE A STRING TO A RENDER BEFORE REWRITING IT. Three things look like copy
  and are not: state enums (`setStatus('idle')`, build `'failed'`), parsed
  sentinels (`'error:<msg>'` job ids, `=== 'model unavailable'`), and dead text
  thrown into `.catch(() => …)` that never reaches the DOM.
- Model prose is styled server-side, not here — see `apps/api/CLAUDE.md`.

## Environment facts / traps

- `pnpm dev:poll` exists because inotify watch exhaustion makes plain `vite`
  fail with ENOSPC on this machine (it is not a disk-space error). Use it when
  the dev server refuses to start; do not delete the script.
- Playwright: pass FUNCTIONS to `page.evaluate`, never strings. Headless cannot
  measure GPU fps — verify fps on hardware or say unverified. Live DEV globals:
  `window.__viewer` / `__Cesium` / `__useSelection`. A production build has no
  DEV globals, so drive `pnpm dev`, not `pnpm preview`, for those.
- A subagent touching `styles.ts`, `PollGeoJsonAdapter`, `tracks.ts` dedup, or
  `requestRenderMode` must preserve the invariants above. One file, one owner.

## Verification before claiming done

Boot the app and drag to Europe — hundreds of category icons, not dots; click an
aircraft — EntityPanel + magenta track within 4 s; click empty — both clear;
30 s with no blink-off. `pnpm typecheck` and `pnpm test` green.

"Stale/slow/empty" is a BACKEND symptom first — this app faithfully mirrors a
frozen blob, and no change here fixes a frozen upstream. Probe per
`apps/api/CLAUDE.md` before editing anything in this directory.
