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
  (1 pull/UTC-day, cached) + airplanes.live grid overlay (densify only).
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
  MyShipTracking, ShipXplorer, USGS quakes, Carto basemap, CelesTrak. FIRMS
  degrades gracefully without MAP_KEY.

## Auth

WS handlers call `require_ws_key` BEFORE `accept`.

`POST /api/ingest/{dataset_id}` is the ONE route with no session dependency — an
external sender has no session, so a per-dataset token is the whole gate. Only
the token's sha256 is stored, comparison is `compare_digest`, the token is never
logged or echoed after the response that mints it, the body is capped BEFORE it
is parsed (Content-Length AND a running total, since chunked declares neither),
and an unknown dataset and an unarmed one answer with the identical 404 so the
route cannot enumerate dataset ids. → `tests/test_ingest_webhook.py`

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
  routes must keep working keyless (`current_user_or_local`).
  → `tests/test_ontology_local.py`
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
  HTTP 200+text; firehose URLs dead from datacenter egress; OpenSky is the
  breadth source; CelesTrak 403-rate-limits bursts (2 h cache).
- Wikidata SPARQL (country leadership): query-shape traps are documented in
  `intel/country_profile.py` — a global rdfs:label join or `P279*` with a
  non-constant class 504s; label service needs a language fallback chain;
  serialize queries (bursts 429). Don't "simplify" the query.
- "Stale/slow/empty" reports land HERE first: diff two `/api/adsb/global` pulls
  on `seen_pos_s` and check sidecar `:8090`/`:8093` health
  (`scripts/verify.sh --live` does both).
- Backend lag/cycle attribution is live at `/api/status/perf`.
