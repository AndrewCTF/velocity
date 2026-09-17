# apps/api — invariants for the backend

Repo-wide rules and the operating method: `/CLAUDE.md`. Decision history and
post-mortems: `docs/decisions.md` — read the entry before changing any guarded
behavior below. Frontend-side rules that consume these: `apps/web/CLAUDE.md`.
Sidecar feeder processes live in `tools/` — see `tools/CLAUDE.md`.

Everything here is enforced by a guard; `bash scripts/verify.sh` runs them all
(`--live` adds feed probes against :8000). A guard failure means an operator
decision regressed — fix the code, or revoke the decision deliberately by
changing BOTH the guard and this file.

## Cadence / snapshot

- 1 s poll + sticky snapshot (1.0 s cycle, 10 s fan-out budget); backend hot
  at boot (`start_snapshot()` in lifespan); world payload = pre-rendered
  gzipped `_HOT_BLOB`, `/ws/adsb` push primary + HTTP poll fallback.
  → `tests/test_adsb_hot_blob.py`
- Internal consumers call `global_snapshot()`, never the `adsb_global()` route
  handler in-process. → `tests/test_invariants.py`
- Global snapshot carries **≥8 000 aircraft** (~13 k normal): OpenSky breadth
  (1 pull/UTC-day, cached) + the adsb.lol planet-radius firehose
  (`/v2/point/0/0/20000`, measured 11 441 on 2026-08-21) + grid overlay
  (densify only). airplanes.live is BANNED at the application level from this
  egress — its 403 body carries a contact address, not a challenge — so it is
  last in `_HEAD_HOSTS` and gone from `_FIREHOSE_URLS`. It is NOT deleted — a
  ban is per-deployment, so the operator switches it off with
  `ADSB_DISABLED_HOSTS=api.airplanes.live` (read by `head_hosts()` /
  `firehose_urls()`, never returns an empty list) and a deploy they have not
  banned keeps the tier. Draft outreach: `docs/outreach/airplanes-live-access.md`.
  → `tests/test_adsb_disabled_hosts.py`
  → `OSINT_LIVE_PROBE=1` in `tests/test_invariants.py`
- The snapshot union is FRESHEST-OBSERVATION-wins (`seen_at - seen_pos_s`), not
  merge-order — a cached tier must never clobber a fresher fix — and a fix that
  flies a fast airborne contact backwards along its own `track_deg` is dropped.
  Raw `seen_pos_s` is the age at UPSTREAM serve time and a cached tier reports
  it as fresh forever; never compare it across tiers.
  → `tests/test_adsb_no_reverse.py`
- World-view decimation = stable `md5(id)` subset, never positional stride,
  never age-keyed. → `tests/test_adsb_viewport_stable.py`
- Upstream burst semaphore stays **8**; `_parse_ac` rejects non-JSON bodies
  (airplanes.live throttles with HTTP 200 + text/plain); `load_cell` RAISES on
  all-host failure. → `tests/test_invariants.py`

## AIS

- AIS = ShipXplorer direct httpx (needs `Referer`/`Origin`) + MyShipTracking
  sidecar `:8093`, MMSI-deduped. SHIP_ID-keyed feeders (MarineTraffic,
  VesselFinder) must never run alongside an MMSI source.
- The vessel store is LAST-WRITE-WINS (`ObservationStore.add_many` assigns
  `_latest[id]` unconditionally), so an optimistic `Observation.t` is a
  CORRECTNESS bug, not a rounding one: it steals the MMSI from a live source AND
  pins itself in retention. A tier that can serve a CACHE must publish the age of
  the DATA, never the age of the response — the `:8093` sidecar carries
  `last_good`/`age_s`, the poller stamps `t` from `last_good` and REFUSES a union
  older than 180 s (going silent lets frozen fixes age out). A wedged AIS feeder
  answers `/health` 200 forever, so it must be aged out and evicted, not adopted.
  → `tests/test_ais_keyless.py`, `tests/test_ais_sidecar_reuse.py`,
  `docs/decisions.md` (2026-07-15 post-mortem)

## Sidecar supervision

Both sidecars are SUPERVISED (`adsb_sidecar.supervise()` / `ais_sidecar.supervise()`,
lifespan tasks cancelled BEFORE `stop()` or they respawn the teardown).
`start()` alone runs once at boot, so a feeder dying later left the tier
silently empty until the next restart. For `:8090` the trigger is LIVENESS
(`_serving()`) and never `_already_healthy()` (`total > 0`): index.js binds the
port before browser init, so a healthy sidecar reads 0 aircraft for ~20-60 s
while clearing Cloudflare and a `total > 0` trigger respawn-storms the ≥8 000
feed. Same split governs `start()`: adopt a holder that IS serving (mid-warm),
evict only one that holds the port WITHOUT serving (it EADDRINUSEs the
replacement). A dry-but-serving sidecar self-heals internally — leave it.
Sidecar data routes need the per-spawn bearer (`app/sidecar_token.py`, file in
`data/sidecar-tokens/`); adoption also requires that the holder accepts the
token on file, so a pre-token sidecar is evicted once after upgrade. Children get
`app/childenv.py`'s allowlisted env, never `os.environ` (ASVS V13.2.1, V13.3.2).
→ `tests/test_adsb_sidecar_supervise.py`, `tests/test_ais_sidecar_reuse.py`

## Egress tiers (both OFF by default)

2026-08-01, docs/decisions.md#getting-past-cloudflare-what-a-different-address-buys-and-what-it-doesnt-2026-08-01

Cloudflare WARP (`app/warp.py`, keyless `warp-cli mode proxy` → loopback
SOCKS5) and a real-Chrome fetch tier (`tools/browser-fetch` :8095). `warp_hosts`
ships EMPTY on purpose — measured from this egress WARP unblocked nothing and
made OpenSky unreachable; run `tools/probe_warp.py` from the deployment that
is actually blocked before listing a host. `/data/aircraft.json` on
airplanes.live/adsb.fi/adsbexchange is a WAF PATH rule: 403 to every client
from every address INCLUDING real Chrome. Do not "fix" it with headers, a
proxy or TLS impersonation — load the page and read the request IT made
(`/fetch?url=<page>&capture=<regex>`). Browser and poller must share one exit
or a clearance cookie is bound to an address nobody is using. Before spending a
browser on a host, check whether it is blocked at all: airplanes.live's
`/re-api/` answers BARE httpx 200, so the browser there is for DISCOVERY.
→ `tests/test_warp.py`, `tests/test_browser_fetch.py`

Browser-tier pacing and the headful lever are in `tools/CLAUDE.md`.

## Other layers

- Satellites: `/api/space/gp` requests `FORMAT=tle` (JSON variant → 0 sats);
  propagation stays chunked, client-side. → `tests/test_invariants.py`
- Keyless layers keep working with no API key: ADS-B grid, Baltic AIS,
  MyShipTracking, ShipXplorer, USGS quakes, Esri dark-canvas basemap, CelesTrak. FIRMS
  degrades gracefully without MAP_KEY.

## Auth

WS handlers call `require_ws_key` BEFORE `accept`. The web client sends the WS
credential in `Sec-WebSocket-Protocol` (`velocity.v1`, `key.<credential>`);
`WsSubprotocolMiddleware` copies it to `Authorization` and selects `velocity.v1`
on accept (a browser drops the socket otherwise). `?key=` is still honoured on
WS only, for older clients: on HTTP it lands in proxy logs and browser history,
so HTTP reads headers only, and `RedactKeyFilter` scrubs `key=` from
`uvicorn.access` AND `uvicorn.error`. ES256/RS256 sessions verify against the
project JWKS (`SUPABASE_JWT_ALGORITHMS` allowlist). HS256 session tokens must
carry header `alg` HS256, `aud` "authenticated", a required `exp` and `sub`, a
past `nbf`, `exp - iat` ≤ `JWT_MAX_LIFETIME_S`, and `iss` = `SUPABASE_URL/auth/v1`
when a URL is set; the GoTrue path applies the same claim rules after its 200.
The MCP's internal token has `aud`/`iss` `velocity-internal` and is accepted at
`ApiKeyMiddleware`/`require_api_key` ONLY — never on a WS, never as a user
(`current_user`). Failed credentials lock a client out (429 + Retry-After) after
`AUTH_FAILURE_LIMIT_PER_MIN`; the lifespan refuses an `API_KEY` or JWT secret
under 32 characters. Full pathway table: `docs/security/auth-and-sessions.md`.
→ `tests/test_auth_query_key_and_jwt.py`, `tests/test_auth_asvs.py`

`POST /api/ingest/{dataset_id}` is the ONE route with no session dependency — an
external sender has no session, so a per-dataset token is the whole gate, and
`/api/ingest/` is in `auth.PUBLIC_PREFIXES` so the middleware does not 401 the
sender first (it did until 2026-09-13). Bad tokens count toward the lockout. Only
the token's sha256 is stored, comparison is `compare_digest`, the token is never
logged or echoed after the response that mints it, the body is capped BEFORE it
is parsed (Content-Length AND a running total, since chunked declares neither),
and an unknown dataset and an unarmed one answer with the identical 404 so the
route cannot enumerate dataset ids. → `tests/test_ingest_webhook.py`

`/api/foundry` fails CLOSED on a keyless deployment — the router carries
`Depends(require_compute_enabled)`, NOT a `ratelimit._COMPUTE_PREFIXES` entry.
The prefix list also drives the inbound limiter, which buckets by the second
path segment, so a prefix entry would put all 55 Foundry routes in one 60/min
bucket shared with `BuildsView`'s 5 s build poll. Auth posture identical, blast
radius not. → `tests/test_security_hardening.py` (both the fail-closed case and
`test_foundry_is_not_a_compute_prefix`, which pins the reasoning)

Every response carries `nosniff` / `X-Frame-Options: DENY` /
`Referrer-Policy: no-referrer` from `SecurityHeadersMiddleware` — pure ASGI (the
ADS-B blob path must not gain a buffering wrapper), fill-if-absent (so
`/api/evidence`'s stricter CSP wins), and NO HSTS (the front proxy terminates
TLS; the app cannot truthfully assert it). It is the OUTERMOST middleware (added
last) so 401/429/503/preflight answers carry the headers too, and it fills
`Cache-Control: no-store` on `/api/`, `/mcp`, `/tiler/` when a route set none
(auth-gated imagery says `private`, never `public`). Next inside it,
`OriginHostGuardMiddleware` (pure ASGI) refuses unknown `Host` headers
(`ALLOWED_HOSTS`) and cross-site writes/WS upgrades by `Origin`/`Referer`; the
suite runs with `ALLOWED_HOSTS=*` (conftest) and `tests/test_asvs_v1_v5.py`
exercises it. `/tiler?url=` goes through `imagery/tiler.check_cog_url` (public
http(s) only, redirect hops re-checked), fails closed keyless, and shares the
general limiter. → `tests/test_asvs_v11_v17.py` List routes bound `limit` with
`Query(..., ge=1, le=N)`. → `tests/test_security_hardening.py`

The rate limiter believes `X-Forwarded-For` ONLY from a peer inside
`TRUSTED_PROXIES` (default `127.0.0.1,::1` — the CF Worker → Caddy → uvicorn
shape, where an empty default would collapse every prod client into one loopback
bucket). Unconditional trust let any caller mint a fresh bucket per request.
Behind the prod compose nginx the peer is a bridge address, so
`docker-compose.prod.yml` sets `TRUSTED_PROXIES` to its fixed `front` subnet.
Besides the compute cap, EVERY `/api/` path shares a per-client
`API_RATELIMIT_PER_MIN` (default 3000; health/status/config exempt; 0 disables).
→ `tests/test_security_hardening.py`, `tests/test_api_ratelimit.py`

Every `/api/workflows` route except `/blocks` (reads too, since 2026-09-13:
the store is not owner-scoped), the mutating `/api/ai/models` routes, and every
Foundry POST/PUT/DELETE carry `Depends(require_operator)`. It passes
unconditionally when Supabase is unconfigured (static key or open mode = one
user, who is the operator); when Supabase can tell two humans apart it requires
the `admin` role, an `aal2` (MFA) session unless `OPERATOR_REQUIRE_MFA=0`, and
the account still active in GoTrue (cached ≤ 60 s). Multi-user owner scoping of
alerts, deliveries, proposals and COP rooms: `tests/test_multi_user_scoping.py`. It does NOT
widen `current_principal_or_local`'s `analyst` default — the clearance-gated
routes read that. → `tests/test_security_hardening.py`, whose anti-rot walk
goes over the ROUTERS: `app.routes` hides leaves behind `_IncludedRouter` and an
app-level walk passes vacuously.

`op.python` runs inside a `bwrap` jail when bubblewrap works here: no network
(default; `WORKFLOWS_PYTHON_NET=1` restores it), read-only system, private
/tmp, minimal env. The bind list is SURGICAL — `sys.prefix` and `py_runner.py`
sit inside the repo next to `apps/api/.env`, so binding any parent of them hands
every key on the box to block code. bubblewrap is probed by RUNNING it with the
real bind list (`_JAIL_BINDS`, shared with the spawn), because it installs fine
on kernels with userns disabled and a cut-down probe reports "absent" on a box
that has it. `sandbox_tier()` is reported in the block help, never assumed.
At the `rlimits-only` tier (including the prod container on kernels with
`apparmor_restrict_unprivileged_userns=1`) `op.python` answers 503 unless
`WORKFLOWS_PYTHON_UNSANDBOXED=1`: unjailed, the child shares the API's uid and
reads its secrets from `/proc/<pid>/environ`. The test conftest sets the opt-in
so no-bwrap CI still exercises op.python.
→ `tests/test_python_exec_sandbox.py`, `tests/test_python_exec_unsandboxed_gate.py`

Outbound URLs go through ONE classifier, `app/netguard.is_non_public_ip`
(mapped/6to4/Teredo unwrapped, CGNAT blocked). `op.http`/drone/device are
operator-gated and keep the LAN reachable (link-local/IMDS refused). Alert-rule
`sink_url` is NOT operator-gated, so it is public-only unless its host is in
`WORKFLOWS_HTTP_ALLOW_HOSTS`, checked at create AND again at delivery.
→ `tests/test_sink_ssrf.py`

Uploads stream through `app/uploads.py` with a cap (foundry = `store.MAX_UPLOAD_BYTES`,
shared with ingest; recon = `recon_upload_max_bytes`); over the cap is 413 and
nothing is left on disk. Every mutating route on workflows, foundry, evidence,
ai_models, ingest and alert_rules carries `Depends(audit_mutation)` (written
before the handler: an attempt, not an outcome), and MCP tool calls audit with
argument NAMES only. → `tests/test_upload_caps.py`, `tests/test_audit_mutations.py`

## Connections (operator-configured sources)

`foundry/connections.py` runs MQTT / Kafka / SQL sources the operator points at
their own infrastructure. Two rules:

- A `sql` connection stores the **NAME of an environment variable** holding the
  DSN, never the DSN. The row is returned by the list route and sits in
  `foundry.db`; a password in it is a leak with several copies. Driver
  exceptions are scrubbed of the DSN before they reach `last_error`.
- `aiokafka` and `sqlalchemy` are OPTIONAL extras, import-guarded like
  `titiler-core`. An absent client makes its kind report unavailable; it never
  stops the app booting. The guard simulates absence with a `__import__` shim,
  because once the extra is installed a test that merely imports proves nothing.
  → `tests/test_connections.py`
- Both wire paths are proven against something real, not mocked: MQTT against a
  forty-line asyncio broker in the test (`tests/test_mqtt_client.py`), SQL
  against SQLite through SQLAlchemy (`tests/test_connections_sql.py`, which is
  why `sqlalchemy` is also a DEV dependency). **Kafka has no equivalent** — it
  needs a broker this box cannot run — so its runner is configured and
  supervised but unproven on the wire.

Supervised, not started once (same rule as the sidecars): the reconcile loop
restarts a connection that dies later and applies an edit made in the UI.

## Ontology (2026-07-07, docs/decisions.md#ontology-local-first-store-2026-07-07)

- The ONLY backend = local SQLite (`intel/ontology_local.py`, via
  `get_registry()`); the Supabase/PostgREST ontology backend was deleted the
  same day (operator invoked the kill criterion). Ontology/situations/maps
  routes must keep working keyless (`current_principal_or_local`: the local
  principal is clearance 0, and every read goes through ONE predicate,
  `intel/ontology.visible_to`; `principal=None` is the internal unfiltered path
  for writers). `/api/ontology/schema` is static and stays exempt.
  → `tests/test_ontology_local.py`, `tests/test_clearance_local_reads.py`
- `objects.props` stays the exact last-written blob (wholesale replace,
  removals included — the frontend round-trip contract); provenance lives in
  the append-only `assertions` table, written by `upsert`'s diff /
  `assert_props`. Never make upsert merge.

## Model prose

Model prose rendered in the dashboard (selection brief, pattern-of-life, watch
officer, country brief, news) goes through `llm.with_prose_style()`, appended
LAST so the caller's format contract wins, and BEFORE `_INJECTION_GUARD` so the
security boundary stays the final instruction. → `tests/test_prose_style.py`
The style rules it enforces are in `apps/web/CLAUDE.md`.

## Environment facts / traps

- Run the tests from the **repo ROOT**, never from here — from `apps/api` the
  `.env` auth resolves and you get a wall of 401s. Command and baseline are in
  `/CLAUDE.md`.
- Upstreams: adsb.lol 451s non-browser UAs; airplanes.live throttles with
  HTTP 200+text AND is now app-level banned (see above); firehose URLs dead
  from datacenter egress; OpenSky is the breadth source.
- **CelesTrak does not rate-limit bursts** (this line said so until 2026-08-21
  and it was wrong). It answers a repeat pull inside its 2 h publish window with
  **403 plus the body `GP data has not updated since your last successful
  download of GROUP=<g> at <ts>`** — a conditional GET wearing a 403, keyed by
  (source IP, GROUP), identical for our UA and a browser UA. `routes/space.py`
  reads that body and serves its on-disk last-good copy; treating it as an
  outage is what emptied the satellite layer on every restart.
  → `tests/test_space_gp_not_modified.py`
- **The shared client follows redirects** (`upstream.py`, httpx ships this OFF).
  Do not turn it off to "fix" something: with it off, plain-`http://` GDELT died
  on its 301 and took the whole conflict layer to zero silently, and a 3xx with
  an empty body scored as a healthy upstream. The four callers that legitimately
  opt out re-check SSRF on every hop and pass `follow_redirects=False`
  per-request. → `tests/test_feed_honesty.py`
- Wikidata SPARQL (country leadership): query-shape traps are documented in
  `intel/country_profile.py` — a global rdfs:label join or `P279*` with a
  non-constant class 504s; label service needs a language fallback chain;
  serialize queries (bursts 429). Don't "simplify" the query.
- "Stale/slow/empty" reports land HERE first: diff two `/api/adsb/global` pulls
  on `seen_pos_s` and check sidecar `:8090`/`:8093` health
  (`scripts/verify.sh --live` does both).
- Backend lag/cycle attribution is live at `/api/status/perf`.
