# Gotchas — the traps that already cost real time

Each of these is a real failure from prior sessions. The project memory
(`~/.claude/projects/-home-andrew-Projects-OSINT/memory/`) holds the full write-ups;
the `[[slug]]` pointers below name the file to open. Read the relevant one before
touching that area.

## Feeds (ADS-B / AIS)

- **"Configured" ≠ "working."** A set API key proves nothing — the creds may be expired
  and every call 401s. To claim a source works, hit it and read the status/count.
  [[velocity-stress-test-findings]], the "opensky_authed: true but 401" lesson.
- **Don't declare a coverage ceiling before exhausting the search.** "Keyless aircraft
  caps at ~12.7k" was wrong — open mirrors (theairtraffic, hpradar), the adsb.lol
  full-snapshot quirk, and headless-browser bridges reading tar1090's own store existed.
  "Whole globe" means try harder. [[airplanes-live-ratelimit-200-text]].
- **airplanes.live throttles with HTTP 200 + a text/plain body, not just 429.** The
  parser must reject non-JSON. Upstream burst semaphore is 8. [[airplanes-live-ratelimit-200-text]].
- **Some hosts answer 451 to a non-browser User-Agent** (adsb.lol); send a real browser UA.
  Datacenter IPs are Cloudflare-blocked on airplanes.live/adsb.fi — only theairtraffic +
  hpradar serve open `aircraft.json` from a server. [[adsb-feed-freshness-pipeline]].
- **Freshness ≠ presence.** A snapshot can read median-fresh while <5% of contacts change
  over 8s — a frozen slice served under upstream throttle. Diff two `/api/adsb/global`
  pulls N seconds apart on `seen_pos_s` to actually measure motion. Mirror feeds must stamp
  `_seen_at` or "LAST SEEN" leans on OpenSky's once/day clock and reads ">20min".
  [[all-aircraft-last-seen-20min-frozen-snapshot]], [[adsb-feed-freshness-pipeline]].
- **Never synthesize aircraft motion on the default path.** Teleport-to-real-fix only;
  dead-reckoning is a sanctioned opt-in toggle, off by default. The operator rejected
  synthetic motion 2-3 times. [[adsb-motion-glide-to-fix]].
- **No keyless global AIS exists.** Working keyless = Digitraffic FI + Kystdatahuset NO
  (regional) + the VesselFinder headless sidecar (~21.5k, global). SAR/CDSE is the only
  keyless expansion for AIS-dark regions. [[keyless-ais-sources-exhausted]],
  [[ais-vesselfinder-sidecar]].

## Memory / RSS

- **The "60GB / 54GB leak" is native-allocator ballooning under ~80-thread/sec churn, not
  a Python leak.** Fix = jemalloc `LD_PRELOAD` via `scripts/run-api.sh`. NEVER set glibc
  `M_ARENA_MAX=2` — it made memory WORSE (54GB vs untuned 17GB). Backend RSS is actually
  flat ~0.86GB under load. [[adsb-refresh-stall-memory-envelope-fix-2026-07-04]],
  [[all-aircraft-last-seen-20min-frozen-snapshot]].
- **Check the socket OWNER before blaming the backend.** 1391 CLOSE-WAIT connections were
  the VITE dev-proxy pid, not the API. `ss -ltnp` / check the pid.

## Auth / boot

- **Local tests must run from the repo ROOT** or `.env` auth resolves and you get ~143
  × 401. [[photos-crud-layers-sim-polish-2026-06-30]].
- **Supabase-configured boxes enforce auth on every non-public route** via
  `ApiKeyMiddleware`. For in-process TestClient checks, set `API_KEY=testkey` (env
  overrides `.env`) and send `X-API-Key: testkey`. Route-level "keyless" (no
  `current_user`) only avoids the *Supabase-user* 401 — the middleware still wants a key.
- **Standing detections 401 when Supabase is UNSET locally** — add SUPABASE_URL/ANON_KEY
  to `apps/api/.env` or the geofence reads go quiet. [[standing-detections-level-not-edge]].
- **Boot blocks `accept` until the snapshot warms (~15-25s).** A page load in that window
  can strand the one-shot `/api/config` fetch; it retries with backoff. A config error is
  a transport/timing issue, never auth. [[adsb-refresh-stall-memory-envelope-fix-2026-07-04]].
- **The ROOT `.env` shadows `apps/api/.env`** because pydantic's `env_file` resolves
  against launch CWD. A missing `ADSB_SIDECAR_ONLY=1` there pulled a frozen full union.
  Run from the intended CWD.

## Process discipline

- **Local uvicorn has NO `--reload`.** Restarting 3× gets you egress-429'd by
  airplanes.live and each cold boot's fan-out crawls. Restart ONCE, verify in-process, WAIT.
  [[uvicorn-restart-429-boot-wedge]].
- **Kill servers by PORT holder** (`ss -ltnp | grep :PORT` → kill pid), not a guessed argv
  pattern — `pkill -f "<path>/index.js"` misses a bare `node index.js`.
- A stale Playwright-MCP lock blocks new browsers: `rm ~/.cache/ms-playwright-mcp/*/Singleton{Lock,Cookie,Socket}`.

## Testing / verification

- **Headless Playwright CANNOT measure real GPU fps** (software raster). It CAN measure
  main-thread longtasks/TBT during a scripted pan. Frontend fps is GPU/per-frame-render
  bound (billboards + labels + per-frame position mirror), NOT React. Target the render
  path (decimate/cull/LOD at world zoom), not the panels. [[frontend-perf-gotham-2026-06-30]].
- **jsdom synthetic PointerEvents don't fire React's drag handlers** — verify pointer-drag
  UIs (resizers, graph drag, timeline scrub) with a TRUSTED Playwright drag.
  [[drag-test-jsdom-synthetic-fails]].
- **Cesium ignores Playwright synthetic right-click** — use the `window.__store` /
  `window.__useSelection` DEV hooks to drive selection in tests. [[gotham-situation-playback-build]].
- **`page.evaluate` needs a FUNCTION passed, not a string** — a string is evaluated as an
  expression and the function object is returned but never called.

## Host

- **IPv6 is broken on this host** — pin HTTP clients to IPv4. curl hides it; httpx doesn't.
  [[host-ipv6-broken]].
