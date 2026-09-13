# scripts — how this repo is booted and verified

Repo-wide rules: `/CLAUDE.md`. Decision history: `docs/decisions.md`.

Run all of these from the repo ROOT. Several resolve paths and `.env` relative
to the working directory and fail in confusing ways from elsewhere.

- `verify.sh` — typecheck + lint + web unit + api tests in one command, and the
  gate for "done". `--live` adds feed probes against :8000, which is what you
  want for any stale/slow/empty report. It is also where the browser-tier
  selftest runs.
- `run-api.sh` — boots the API on :8000, preloading jemalloc IF `ldconfig` finds
  it and printing which allocator it took. The preload is PROBED, not assumed:
  jemalloc is not a declared prerequisite, and an unconditional `LD_PRELOAD` on
  a box without it makes glibc print a loader ERROR ahead of uvicorn's first
  line, which reads as "already broken" to a first-time self-hoster. Never set
  `M_ARENA_MAX=2`; sidecar children scrub `LD_PRELOAD` and that is guarded.
  Restart the backend ONCE and wait — repeated restarts get the egress
  rate-limited, which then looks like a code bug.
- `kill-port.sh <port>` — kill dev servers by port holder. Never `pkill -f` on
  an argv guess. It escalates TERM → verify → SIGKILL of the process GROUP, and
  must keep doing so: Playwright installs a SIGTERM listener, and once any
  listener exists Node stops doing its default terminate, so the browser
  sidecars (:8090, :8093, :8095) SWALLOW a plain `kill` and keep serving. A
  silent no-op here reads as "the supervisor resurrected it" and sends you
  debugging the wrong component (measured 2026-08-02; the AIS twin taught it
  first on 2026-07-15).
- `preflight.sh` — pre-PR local gate. The Cloudflare gateway deploy path
  (`site/`, `deploy.sh`) was deleted 2026-09-13; releases ship as ghcr images
  behind `.github/workflows/release-gate.yml`.
- `warp.sh` — Cloudflare WARP proxy control for the egress tier, OFF by default.
  See `apps/api/CLAUDE.md` for why `warp_hosts` ships empty.
- `smoke-release.cjs` — the release gate's browser probe
  (`.github/workflows/release-gate.yml`; `publish.yml` pushes nothing without
  it). Drives the booted `docker-compose.prod.yml` stack: stops the api, loads
  the page, requires the globe to render, starts the api, requires in-place
  recovery. DOM-only, since a production build has no DEV globals. Rehearse
  locally from a copy WITHOUT the root `.env` (CI has none), and check
  `web-build` exited 0: a failed build leaves the previous bundle in the volume
  and the probe then tests stale code. → `apps/api/tests/test_release_gate.py`
- `screenshot-*.mjs` — drive the running dev server, not a production build:
  they depend on the `window.__viewer` / `__Cesium` DEV globals.
