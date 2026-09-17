# Gap analysis — where the console should be, where it is (2026-09-13)

Measured this session against the running stack (`scripts/run-api.sh` + Vite,
branch `release-basemap-schemes-2026-09`). Every number below has its command.
Nothing here is fixed yet; this is the map for the next wave.

## 1. Should be

Operator, verbatim: *"palantir level of shit and a lot more detailed data, better
UI, no more BS in the UI, easily readable. no more clipping"* and *"some places
like above the strait of hormuz, planes refresh time is too slow"*.

The spine for "Palantir level" is already written and not re-derived here:
`docs/plan-99-2026-08.md` §0 (provenance tiers, clean primary data, no
narrative) and `docs/palantir-reference-2026-07.md` §11 (panel-by-panel Gaia /
Gotham inventory). Read as acceptance criteria:

1. Live contacts refresh on a steady cadence; staleness is visible, never silent.
2. Zero clipped text at 1440x900 and above. A label is either whole or wraps.
3. A readable floor: no body copy under 11 px.
4. Every block on screen earns its pixels: no repeated boilerplate, no raw ids,
   no test fixtures, no "nothing here" canvases as a default state.
5. Depth: an object view answers who / what / where / since when / says who,
   joined across sensor, registry and filing tiers.

## 2. Is — the refresh complaint (backend first, per root CLAUDE.md rule 5)

**The slow refresh is global, not Hormuz-specific. Hormuz is additionally thin
on receivers.**

`/api/adsb/global` polled every ~3.5 s for 90 s, positions changed per pull,
with nothing else loading the box:

    (1,17533) (4,8239) (10,3784) (13,13645) (17,8427) (21,5) (24,13697) (28,3450)
    (32,8307) (36,3581) (39,0) (43,0) (47,0) (50,0) (55,10044) (58,14149) ...

A first run (under Playwright load) froze from t=8 to t=28: **20 s with zero
position changes worldwide**. The unloaded run froze t=39 to t=50. The
`:8090` sidecar's `/health` at the first probe read `pump_ms_last: 20211` with
`airplanes.live age_s: 32` while adsbexchange and adsb.lol were fresh; later
`pump_ms_last: 1634`. Plumbed-unverified cause: one upstream stalls and the pump
waits on it instead of publishing the sources that answered. The globe polls at
`ttlSec: 1` (`registry/defaults.ts:109`), so worst-case visible staleness is the
pump stall plus one second.

Per region, same 90 s window (`tools/perf/adsb_region_refresh.py`, bbox Hormuz 23-30N 50-60E):

| Region | Aircraft | Updates / 90 s (median) | No update in 90 s | seen_pos_s p90 |
|---|---|---|---|---|
| Hormuz / Gulf | 136 | 9 | 16% | 106 s |
| India | 332 | 8 | 11% | 80 s |
| Europe | 3,173 | 11 | 16% | 30 s |
| CONUS | 4,239 | 12 | 9% | 12 s |

Hormuz gets ~25% fewer updates than CONUS and its oldest decile is 9x staler.
That part is community-receiver density over the Gulf (all three sources are
volunteer feeders) and no code change creates receivers. What code can do: show
fix age on the icon itself (styles.ts has no age-based alpha today; the age
appears only in the Selection panel's FRESHNESS block), and fold in the
OpenSky-authenticated tier the top banner says is unconfigured.

**Fixed the same day** (`docs/decisions.md`, "One wedged tar1090 source froze every
aircraft"): `tools/adsb-globe-feeder/index.js` gave each source its own loop. The
sidecar log showed one `evaluate timeout - reinit` every 1-1.5 min, and the old loop
waited for all sources before rebuilding. After, 5 min with the same tiers live:
longest zero-change run went from 4 pulls to 1, and Hormuz aircraft with no update
fell from 16% to 6%. Receiver density over the Gulf is unchanged.

Also noted, not asserted: `:8090` RSS 188 → 905 → 1016 MB over ~10 min of
uptime. Needs `tools/perf/measure_sidecars.sh --soak` before anyone calls it a
leak.

## 3. Is — clipping and readability

`node tools/perf/ui_clip_sweep.mjs 1920 1080` and `... 1440 900`: all 14 apps
plus the 4 left panels plus a selected aircraft. Limits: no scrolling, no hover,
first clipping ancestor only, and it does not model occlusion: the "overlapping" column is not trusted: on AI, Workflows, City and Reports it counts the hidden TimeDock under the opaque app overlay (`AppSurface.tsx:121`), not visible defects. Content below the fold (Explorer's 2,500 list rows)
is excluded; it is scroll, not clipping.

| Surface | Truncated @1920 | Truncated @1440 | Text < 11 px | Overlapping text |
|---|---|---|---|---|
| Map, default | 3 | 8 | 41 | 0 |
| Map, aircraft selected | 6 | 13 | 49 | 0 |
| Info panel | 8 | 15 | 41 | 0 |
| AI | 0 | 0 | **107** | 12 |
| Explorer | 6 | 13 | **572** | 0 |
| Country | 12 | 12 | **305** | 0 |
| Markets | 5 | 5 | 60 | 0 |
| Reports | 6 | 13 | 66 | 13 @1440 |
| Workflows | 0 | 0 | 49 | 7 |
| City | 0 | 0 | 49 | 5 @1440 |

Source: `rg 'text-\[10px\]'` = **781** occurrences in `apps/web/src`,
`text-[9px]` = **31**. The small-text floor is a codebase habit, not a few
stragglers. The 41 on every surface are the shell itself: the OpenSky banner,
the map legend, the compass N, all 10 px.

### Named offenders

| What the operator sees | Where |
|---|---|
| Every feed name in Info cut to 153 px: "Aircraft · Emergency squ…", "Vessels · live (all AIS sou…" | `shell/panels/InfoPanel.tsx:170,219` (`span.block.truncate` in a 38 px row) |
| At 1440 AOI subtitles cut: "Red Sea / Gulf of…", "Atlantic / Mediter…" | same rows |
| World summary "Oldest fix · Vessels · live (all AIS sources, 24/7)" 267/233 px | `shell/panels/WorldPanel.tsx:173` |
| Markets: all 5 instrument names in 68 px ("Nasdaq Composite" needs 99, "US Dollar / Japanese Yen" 131) | `markets/SnapshotCard.tsx:42` |
| Country list: 12 names cut ("Congo, Democratic Republ…") at 12 px in a 240 px nav | `country/CountryApp.tsx:178,212` |
| Timeline hour label overruns its tick box by 32 px on every surface | `shell/TimeDock.tsx` |
| Selection panel: "Claim-tier reports within 50 km" 178/165 px; altitude "10668" exceeds its svg by 11 px | Selection dossier |
| At 1440 the command box on the globe cuts "correlat", its footer "⌘J console" wraps, and "center 15.00°E" / "alt" sit under the box and the TimeDock | map furniture, `console.css` banner rules |
| Reports situation title cut mid-word: "Vessel(s) went silent / dark near reported activ" | Reports, Situations list |

### Wasted space (the other half of "readable")

`shell/console.css:312` caps five apps (`MEASURED` in `AppSurface.tsx:35`: ai,
investigate, video, reports, country) at `max-width: 820px`. At 1920 that leaves
a **1,080 px empty band** to the right of AI and Country
(`docs/media/gap-2026-09-13/1920-app-ai.png`) while Country squeezes a 240 px
nav, a list and the dossier into the 820. The measure was deliberate (forms
should not stretch); the result reads as a broken layout. A reading column is
right for prose, not for a dossier with tables.

## 4. Is — "BS in the UI"

Each item was on screen during the sweep.

1. **AI > Answers repeats one paragraph seven times.** Hormuz, Suez, Bab-el-Mandeb,
   Bosphorus, Malacca, Panama, Gibraltar all read `UNKNOWN · no evidence recorded ·
   confidence low · No recorded vessel history in this strait yet` followed by the
   same two-line methodology. One line would say it: "7 straits need 3 days of
   recording before they answer." (`api/app/intel/answers.py`,
   `web/src/answers/AnswersCard.tsx`.) Meanwhile the AOI panel on the left shows
   live vessel counts for the same straits, so the page contradicts itself.
2. **Raw ids and dead defaults in Info > Feeds**: `hazards.usgs.quakes · no reason
   given` with an empty bar (`InfoPanel.tsx:179`). An id is not a label, and "no
   reason given" is the UI apologising for not knowing.
3. **Leftover test records in this deployment's local state** (data, not shipped
   code): Reports > Situations lists "Riley test case - example.com"; Workflows
   lists `probe` and `live-e2e-high-alt`. The gap is that nothing marks or prunes
   records created by e2e runs.
4. **Reports opens on a drawing form.** Tab "Case files" lands on "Territorial
   control / Faction / Draw area / Draw line / Import GeoJSON" before any case
   (`1440-app-reports.png`).
5. **Empty instruments as the default state**: Graph is a full-width blank canvas
   under "No investigation open"; Workflows is "No blocks yet"; Country is
   "Select a country" over 1,000 px of nothing. Rendered characters: Workflows
   1,221, City 1,206 (plan-99 §2.1 flagged these same two as thinnest on
   2026-08-05; unchanged).
6. **Permanent chrome that is not information**: the OpenSky banner on every
   surface; Integrity rows `NIC 0 · SIL 0 · NACv 0` drawn as zero-length bars
   (likely unreported, rendered as measured zeros — the timeline `gaps` bug class
   from the honesty wave); Provenance `Tier —` on a live ADS-B contact whose layer
   is tiered `sensor`.
7. **The globe default is a yellow carpet**: ~22k identical icons plus teal
   cluster rings over Europe; nothing in the frame says what is unusual.
   Palantir's Map opens on a selection or an AOI, not on everything.

## 5. Is — data depth versus the Palantir spine

Not re-listed; the open items are already enumerated with evidence:

- `docs/plan-99-2026-08.md` §4.1 "Not done": ~15 `build` sources in §3 (FAA
  registry, ITU/MARS, EU TED, SAM.gov, UN Comtrade, port state control, Cloudflare
  Radar, ENTSO-E, AGSI, INTERMAGNET, GOES...), two known-bad (IRIS FDSN 410,
  Copernicus STAC collection id), and **the tier-to-tier join (T0 observation ↔
  T2 filing about the same object) not built**. That join is the single feature
  that separates an object view from a map tooltip.
- `docs/honesty-wave-2026-08-30.md` "Still open": 18 of 26 phases, largest being
  archive contiguity, the replay-window map gesture, and photo geolocation's
  missing surface.
- `git log --since=2026-08-30`: 19 commits, all security/release/website/basemap.
  **No data-depth or console-UI work has landed since 2026-08-30.**

What the selected aircraft shows today (`1440-map-selected-aircraft.png`):
identity, kinematics, integrity, freshness, provenance. What a Gotham object view
would add, all from sources the repo already has or plans: owner chain
(registration → FAA/national registry → GLEIF parent → sanctions hit), 24 h track
history and pattern of life inline (the button exists; the data is not in the
card), airport pair, prior-visit count to the current AOI, corroborating claims
with lag.

## 6. Priority order

| # | Gap | Why first | Check that proves it |
|---|---|---|---|
| 1 | **DONE 2026-09-13.** ADS-B pump publishes what answered instead of waiting on the slowest source | Operator-reported, measured 12-20 s global freezes | `tools/perf/adsb_region_refresh.py`: no pull with 0 changes; `verify.sh --live` refresh ≥ 20% |
| 2 | Fix age visible on the icon (dim by `seen_pos_s`) | Makes Gulf coverage honest instead of looking frozen | invariants test on style alpha; screenshot over Hormuz |
| 3 | Zero truncation at 1440: Info rows, Markets, Country, TimeDock, map furniture | "no more clipping" | `ui_clip_sweep.mjs 1440 900` truncated = 0 on the rows in §3 |
| 4 | 11 px floor; drop the 820 px measure for dossier-style apps | "easily readable" | sweep `tiny` column; 781 → 0 `text-[10px]` for body copy |
| 5 | Kill the BS list in §4 (collapse repeated answers, labels not ids, remove fixtures, Reports opens on cases, unreported ≠ 0) | "no more BS" | per-item guard or screenshot |
| 6 | Object view depth: registry/owner chain + inline track history in Selection | "Palantir level", "more detailed data" | selected aircraft shows owner + 24 h history live |
| 7 | T0 ↔ T2 join and the remaining plan-99 §3 sources | the moat | plan-99 §3 row status |

Reproduce: boot the stack, then `node tools/perf/ui_clip_sweep.mjs 1440 900`
(writes screenshots + `metrics-<w>.json` to `$OUT`, default `scratchpad/sweep`).
