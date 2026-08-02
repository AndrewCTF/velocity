# tools — feeders, browser tier, perf harnesses

Repo-wide rules: `/CLAUDE.md`. The backend contracts these processes must
satisfy (supervision, freshness stamping, MMSI dedup): `apps/api/CLAUDE.md`.
Decision history: `docs/decisions.md`.

These are standalone Node/Python processes with their own dependencies. They
are started and supervised by the API, not by you — see the supervision rules in
`apps/api/CLAUDE.md` before changing how any of them bind a port or report
health.

## Feeders

- `adsb-globe-feeder` (`:8090`) and `ais-myshiptracking-feeder` (`:8093`) are
  the live ones. `index.js` binds its port BEFORE browser init, so a healthy
  sidecar reports 0 contacts for ~20-60 s while it clears Cloudflare. Anything
  that treats "0 contacts" as dead will respawn-storm the feed.
- A sidecar that can serve from CACHE must publish the age of the DATA, not the
  age of the response: `:8093` carries `last_good`/`age_s`. Never stamp a fresh
  timestamp on a cached read — the vessel store is last-write-wins and an
  optimistic timestamp steals the MMSI from the live source.
- `ais-marinetraffic-feeder` and `ais-vesselfinder-feeder` are SHIP_ID-keyed and
  must never run alongside an MMSI source — they cannot be deduped against it.
  They stay off; the directories are kept deliberately, not by neglect.

## browser-fetch (`:8095`)

Real Chrome, off by default. The whole trick is real Chrome plus a
returning-visitor profile — never add a stealth plugin or a UA override.

- One load at a time per host, jittered floor, per-host cookie profile saved
  after EVERY load. Playwright's own SIGTERM handler kills Chrome before a
  shutdown-only flush can run, so a flush-on-exit design silently loses the
  profile.
- Against a REAL managed challenge ("Just a moment", adsb.fi) headless Chrome
  fails and `browser_headful` (headful under `xvfb-run`) is the ONE lever that
  worked — not the proxy, not headers, not the exit address.
- Headful NEVER touches the operator's session: `xvfb-run -a` picks its own
  display, and headful pins `--ozone-platform=x11` because `WAYLAND_DISPLAY` is
  inherited even inside `xvfb-run` and a Chrome that preferred Wayland would
  draw on the real desktop. Never launch it on `:0` and never drop the pin.
- `selftest.js` runs inside `scripts/verify.sh`. → `apps/api/tests/test_browser_fetch.py`

## perf

For PERFORMANCE claims the harnesses already exist — use them, don't invent a
number: `perf/measure_ui.mjs` (real Chrome on the GPU, `--profile all-toggles`,
reads `window.__perf`), `perf/measure_api.py` (/proc sampling + per-route cost
table), `perf/measure_sidecars.sh --soak`, `perf/measure_llm.py`.

A before/after is only a comparison if BOTH runs had the same tiers live — see
`docs/decisions.md` (2026-07-27) for the retraction that rule came from.

## probe_warp.py

Run it from the deployment that is actually blocked before adding any host to
`warp_hosts`. Measured from the dev egress, WARP unblocked nothing and made
OpenSky unreachable, which is why the list ships empty.
