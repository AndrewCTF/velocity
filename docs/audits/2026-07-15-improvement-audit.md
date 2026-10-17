# Improvement audit — 2026-07-15

Method: 8 parallel read-only scouts (replay, alerts, ontology, launch packaging,
repo rot, frontend, backend, security) over the current HEAD
(`aircraft-motion-exact-speed-no-reverse`, == origin/master after PR #45), each
returning file:line evidence; load-bearing claims re-verified by hand this
session. Tags: **proven-live** (ran it this turn), **confirmed** (read the
file:line), **reported** (scout claim, plausible, not independently re-run).

Ranked by impact × cheapness. The first block is the one thing to fix before
anything else.

---

## P0 — Security: fix before the launch the roadmap wants

### 1. Unauthenticated remote code execution via `/api/workflows` — **proven-live**

On a fresh self-host with **no `API_KEY`, no Supabase, `ALLOW_UNAUTHENTICATED=0`**
(the fail-closed default), an anonymous caller can `POST /api/workflows` then
`POST /api/workflows/{id}/run` an `op.python` block and execute arbitrary Python.
I ran the full chain in-process this session: `/api/intel/brief` correctly
returns 503 (compute gate works), but `GET/POST /api/workflows` returns 200 with
no credential, and the `op.python` block wrote a marker file to disk.

Root cause: `apps/api/app/ratelimit.py:32-48` (`_COMPUTE_PREFIXES`) does **not**
list `/api/workflows`, so `apps/api/app/auth.py:214` (`is_compute_path`) never
fires for it and `auth.py:221` falls through to open. `op.python` is `exec()` by
design (`apps/api/app/workflows/py_runner.py:66`), resource-limited but **not**
isolated (documented at `py_runner.py:8-11`). `/mcp` was hard-failed-closed for
exactly this reason (`auth.py:200-207`); workflows never got the same treatment.
Fix: add `/api/workflows` (and any other exec/dispatch route) to
`_COMPUTE_PREFIXES` / the fail-closed set, with a guard test.

### 2. `op.http` SSRF allows internal LAN + localhost — **confirmed**

`apps/api/app/workflows/control.py:98-163` blocks only `169.254.0.0/16`; `10.x`,
`192.168.x`, `127.0.0.1` are intentionally allowed (BYO control-server design).
Combined with #1, a remote anonymous caller can pivot into the operator's LAN.
The evidence/news fetch paths (`intel/evidence.py:318-379`, `news/images.py:56-88`)
already do full private-range blocking — port that guard, gated behind an
allowlist env for the deliberate home-automation case.

### 3. No MCP-layer rate limiting — **confirmed** (roadmap W5, unshipped)

`apps/api/app/mcp_server.py` has no throttle. Agent traffic can hammer
rate-limited upstreams (adsb.lol UA rules, airplanes.live 200+text, CelesTrak
403 bursts). Add a per-client limiter before any public MCP listing.

---

## P1 — Repo integrity: a stranger cannot cleanly clone this

### 4. Fresh clone breaks on submodule init — **proven-live**

`apps/ml/fusion/Pi3` and `apps/ml/fusion/map-anything` are committed as gitlinks
(`160000` mode) but there is **no `.gitmodules`**. A clean
`git clone … && git submodule update --init --recursive` fails with
`fatal: No url found for submodule path 'apps/ml/fusion/Pi3'`. The backend
references these paths (`routes/recon.py:243`, `routes/imagery.py:562`). Either
add a proper `.gitmodules` with upstream URLs, or vendor them as plain
directories, or make the recon pipeline degrade when they're absent.

### 5. 55 GB working tree, 30 GB of it vendored ML — **confirmed**

`apps/ml/` = 30 GB (vendored `.mamba-*` conda envs + upstream research repos
gsplat/vggt/EOGS), `data/` = 14 GB, `test_images/` = 171 MB. The vendored envs
are also the source of a misleading TODO/FIXME count (3188 raw → **2 in
first-party code**, both false positives). Move vendored envs/data out of the
tree or into gitignore; commit only what the pipeline imports.

### 6. `.git` carries 6.4 MB `yolov8n.pt` twice + large blobs — **confirmed**

`apps/desktop/src-tauri/yolov8n.pt` and `apps/desktop/sidecar/yolov8n.pt` are
both committed (packed size 157 MB). Model weights belong in a release asset /
git-lfs / download-on-first-run, not history.

---

## P1 — Docs drift: the guard-doc contract is stale

### 7. `docs/decisions.md` missing narrative entries — **confirmed**

PR #42 (strike areas/country intel), PR #44 (AI workspace + watch officer), and
the 12-feed data-layers wave appear only as baseline-count bumps, no `###` entry.
CLAUDE.md's contract says guarded behavior gets a dated decisions entry. Backfill
one paragraph each.

### 8. README test badge stale — **confirmed**

`README.md:30` and `:535` say "1539 passing"; the real inherited baseline is
**1675 + 1 skip** (`CLAUDE.md:117`). Update the badge and the quickstart line.

### 9. `roadmap-users-2026-07.md` is itself stale — **confirmed**

W1 (replay) and W3 (keyless alerts) shipped; it still cites `watch.py:504` as
returning `[]` when the fix landed 2026-07-11 (`docs/decisions.md:582`). It's
already superseded by `roadmap-practitioners-2026-07.md`. Add a superseded-by
banner; the practitioner roadmap is the live one.

### 10. ~25 shipped-feature plan docs should move to `docs/archive/` — **reported**

Candidates (feature merged, doc is a pre-build spec): `foundry-plan.md`,
`foundry-gap-analysis-2026-07-08.md`, `ontology-local-spine-plan.md`,
`ontology-autopopulation-plan.md`, `places-airspace-plan.md`,
`photo-geolocation-pipeline.md`, `osint-sources-plan.md`, `country-osint-spec.md`,
`dashboard-workflows-plan.md`, `rpc-satellite-3dgs-plan.md`,
`velocity-watch-officer-plan.md`, `data-layers-wave-2026-07-14-plan.md`, the two
frozen genesis reports (`research.md`, `research_updated.md`), and the mid-June
one-off stress/dogfood/gotham writeups. 52 top-level docs is hard to navigate.

### 11. Small doc-hygiene fixes — **confirmed**

`decisions.md` mislabels the aircraft-motion wave branch as
`ui-typography-wcag-sidebar` (it was `aircraft-motion-exact-speed-no-reverse`,
PR #45) — copy-paste drift. Local `master` is stale (audit of 2026-07-12 already
asked for the fast-forward); 5 stale local branches remain.

---

## P2 — Backend health

### 12. Two local stores grow unbounded — **confirmed**

`workflows/store.py` (`./data/workflows.db`) and `intel/alert_rules_local.py`
(`./data/alert_rules.db`) have **no** prune/vacuum/cap, unlike history/foundry/
ontology which all cap. Workflow runs + wf_memory rows + delivery logs accumulate
forever. Add the same retention pattern.

### 13. Oversized modules — **confirmed**

`routes/adsb.py` (2212), `foundry/store.py` (2000), `workflows/blocks.py` (1586),
`entity-panel/EntityPanel.tsx` (1647), `globe/adapters/PollGeoJsonAdapter.ts`
(1779). Split by concern; these are the highest-churn files and mix routing,
serialization, and business logic.

### 14. One real blocking call in async code — **reported, verify**

`apps/api/app/intel/lod1.py:96` `time.sleep(1.5)`. Confirm it's on a worker
thread, not the event loop; if the latter, `await asyncio.sleep`.

### 15. No structured logging, no `/metrics` — **confirmed**

Only `/api/status` and `/api/health/memory` give real depth; logs are plain-text,
uvicorn defaults. For a tool strangers will self-host and file bugs against, JSON
logs + a Prometheus endpoint materially cut support cost.

### 16. Ad-hoc `CREATE TABLE IF NOT EXISTS`, no migration versioning — **confirmed**

Six local sqlite stores each DDL themselves; no schema version. The first
breaking schema change on a user's populated archive DB will hurt. A tiny
`user_version`-based migration runner now is cheap insurance.

---

## P2 — Frontend health

### 17. No code-splitting: one 8.8 MB JS bundle — **confirmed**

`vite.config.ts` has no `manualChunks`; `grep lazy( → 0`. All 13 apps
(map/ai/explorer/graph/investigate/targeting/video/sim/reports/foundry/workflows/
city/country) load synchronously (`dist/assets/index-*.js` = 8.8 MB). Route-level
`React.lazy` on the heavy apps (foundry, workflows, city, video) is the single
biggest first-paint win.

### 18. Critical files have zero direct tests — **confirmed**

`PollGeoJsonAdapter.ts` (the live feed poll/WS engine, 1779 lines) and
`EntityPanel.tsx` (1647) — the two largest, most load-bearing files — have no
`*.test.*`. 364 web tests exist but skip exactly the code an invariant regression
would hit.

### 19. Accessibility gaps in the three central surfaces — **confirmed**

`GlobeCanvas.tsx`, `EntityPanel.tsx`, `InvestigationCanvas.tsx` have no
`aria-label`/`role`/`tabIndex`; the link-analysis graph is mouse-only (no
keyboard node nav). Shared `shell/Modal.tsx` does it right — route the big panels
through it.

### 20. zustand filtering-selector loop trap is fragile — **confirmed**

`sim/TrafficSimSection.tsx:37-40` documents the `useSyncExternalStore` infinite
loop workaround inline. One future `.filter()`-in-selector regresses it. An eslint
rule banning inline transforms in zustand selectors would make it structural.

---

## P2 — Launch / growth (the roadmap's stated #1 problem: ~0 users)

### 21. The launch was never executed — **confirmed**

0 git tags, 0 GitHub releases, `launch-posts-draft.md` still a draft, 32 stars.
The 2026-07-12 audit's _primary_ recommendation (post r/selfhosted + Show HN) is
unexecuted. Every capability improvement below competes with this for leverage —
the product is deep and invisible.

### 22. `docker compose up` doesn't match the pitch — **confirmed**

The dev `docker-compose.yml` (what the README tells strangers to run) sets a 48 h
rolling window, **not** the archive profile the README/roadmap headline sells
(that's only in `docker-compose.prod.yml`). It also boots **no sidecars** (ADS-B
tar1090, MyShipTracking) — they sit idle. Fix so the one-liner delivers the
flagship (owned replay) by default.

### 23. GRAPH page still hollow on fresh open — **confirmed**

The crash/401 demo failure is fixed (routes now `current_user_or_local`) and the
watch-officer auto-mints incidents after ~2 min (`promotion.py`, shipped), but the
canvas only fetches when a `rootId` is selected (`InvestigationCanvas.tsx:208`),
so a first-time visitor still sees the empty-state prompt. Auto-seed the graph
view from recent incidents on open.

### 24. No CONTRIBUTING.md / issue / PR templates — **confirmed**

`.github/` has only `ci.yml`. For an open AGPL repo courting self-hosters, these
are table stakes for converting a visitor into a contributor.

### 25. Alert sinks are thin — **confirmed**

Keyless Discord + generic webhook work and fire server-side with no browser
(verified by scout against `test_watch.py:404`), but email is rejected at
creation, there's no ntfy/Telegram, and no retry/backoff on a failed POST
(`watch.py:656`). ntfy especially is the self-hoster default for phone push.

---

## P3 — Capability gaps (real, but gated behind users existing)

### 26. Replay: incident overlay in scrub not built; disk math never measured

Aircraft+vessel scrub ships; incidents are never written to `history.db`
(no `kind="incident"` path). The "GB/day at 13k aircraft + 50k vessels" figure the
archive profile needs is still explicitly unmeasured (`replay-flagship-plan.md`).

### 27. Person/identity OSINT (roadmap Tier 1) — not built

Keyless username enumeration / Gravatar / GitHub-GitLab public API / HIBP
k-anonymity → mint `person:`/`email:` into the ontology. Self-contained, completes
the digital-OSINT layer.

### 28. Imagery CV tip-and-cue loop — not closed

YOLO/SAM2 on Sentinel-2/SAR chips → geo-referenced detections as map entities.
`yolov8n.pt` is already in-tree; the detector→task-imagery→auto-count loop is the
payoff.

### 29. Watch-officer briefs are still an in-memory dict

`watch_officer.py:68` `_BRIEFS` clears on restart. Persist as incident objects
with `evidence_of` links (roadmap W4 half-done — incidents promote, briefs don't).

### 30. History backfill into the graph — not built

No job replays `history.db`/incident store into the ontology, so the graph only
reflects uptime-since-last-restart. Confirmed absent (`grep backfill` → unrelated
hits only).

---

## Suggested order

1. **#1 (auth RCE)** — today, with a guard test. Everything else is moot if a
   stranger who runs this gets owned.
2. **#4, #8, #11** — the clone-breaks + stale-badge + branch-label fixes; an hour,
   removes the worst first-impression failures.
3. **#22, #21** — make the one-liner deliver replay, then actually launch. The
   roadmap is right that zero users is the binding constraint.
4. **#12, #17** — unbounded-DB and bundle-split; the two cheapest health wins.
5. Then P2/P3 by appetite.
