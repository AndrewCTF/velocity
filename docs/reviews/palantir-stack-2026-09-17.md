# Adversarial review — `palantir-stack-2026-09` (f13ed2b^..c5c0596)

Scope: every commit on this branch after `f13ed2b^`
(`git log --oneline f13ed2b^..HEAD` = f13ed2b, 2fa2ff4, c6cdad1, 314087b,
694e5f0, cf3003a, c5c0596). Reviewed by reading each diff and then the code it
calls. No source file was edited; this file is the only output.

Method / evidence tags:

- **VERIFIED** — reproduced this session with the command shown, output pasted.
- **PLAUSIBLE** — code-read only.

Two facts that bound every claim below:

1. The working tree carries an unrelated in-flight wave (`apps/api/app/intel/actions.py`,
   `llm.py`, `routes/ai*.py`, `tools/adsb-globe-feeder/index.js`, …) that is NOT
   part of the commits under review. Test runs therefore = HEAD + that wave. None
   of it touches the files reported here.
2. A real TimescaleDB is running locally (`velocity-timescale`, 127.0.0.1:5433),
   so the skipped-by-default PG suite was run for real, not assumed.

Commands that were run and where the numbers came from are inline per finding.
Wave guards were all green before the findings were written:
`104 passed` (test_clearance_local_reads, test_resolve_review, test_adsb_heatmap,
test_history_backend_switch, test_connections_sql, test_foundry_documents,
test_foundry_connectors, test_project, test_ontology_local, test_audit_mutations),
`17 passed` (test_history_pg with `HISTORY_PG_TEST_DSN`), `28 passed` (vitest:
HistoryPlayback, TimeDock, heatmapChunk, InboxPanel). Every finding below is a
hole the guards do not cover.

---

## Wave 1 — Timescale history backend (`history_pg.py`, `history.py` switch)

### W1-1 · MED · a failed schema apply leaks one Postgres connection per attempt

`apps/api/app/history_pg.py:247-297` (`_ensure_pool`). The pool is assigned to
the module global only AFTER `apply_schema(con)` succeeds (`history_pg.py:285-289`).
If the schema apply raises — the app role can connect but does not own the
hypertable, an older Timescale without `add_compression_policy(..., if_not_exists)`,
any privilege error — the exception propagates while `pool` is still a local, and
nothing ever calls `pool.close()`. Every read and every flush re-enters
`_ensure_pool`, so the process opens a fresh connection per operation until
Postgres answers `too many clients already`, which then masks the original error.

VERIFIED:

```
$ OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/python  # apply_schema monkeypatched to raise InsufficientPrivilegeError
before: 0
attempt 1..5: InsufficientPrivilegeError
after 5 failed _ensure_pool calls: 5 live 'velocity-history' backends
after gc.collect(): 5
```

(`pg_stat_activity WHERE application_name='velocity-history'`.)

Smallest fix: wrap the apply in its own try/except and `await pool.close()` before
re-raising (or set `_pool`/`_pool_loop` before applying and reset them on failure).

### W1-2 · MED · one malformed upstream fix discards the whole 3 s flush batch, silently

`apps/api/app/history_pg.py:406-409` + `:434-455`. `_record` converts the
position with `_i(float(lat) * 1e6)` / `_i(extra.get("baro_alt_m"))`. `_i` bounds
nothing, while the smallint columns DO go through `_clamp_small`. `lat_e6`/`lon_e6`/
`alt_m` are `integer` (int4) in `infra/db/20_history_timescale.sql:59-66`, so a
single garbage value (an upstream fix with `lat=1e9`, or any wild `baro_alt_m`)
overflows and makes asyncpg's COPY reject the ENTIRE batch. `flush_rows` catches
the blanket `Exception`, logs one WARNING with the exception class only, returns
0, and moves on — while the caller has already detached those rows from `_buffer`.
So one bad row costs every good fix buffered in the same 3 s window, forever
repeatable, with no counter that shows it.

VERIFIED:

```
$ OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/python   # one good fix + one fix with lat=1e9
history_pg: flush failed (OverflowError) against 127.0.0.1:5433/velocity_review_scratch
flush_rows returned: 0
rows actually in the hypertable: 0
good row present? 0
```

Same call site, second defect: `records = await loop.run_in_executor(None, _records_for, rows)`
(line 444) sits OUTSIDE the `try` that starts on line 449, so a raise inside
`_record` (rather than inside the COPY) escapes `flush_rows` despite the docstring's
"Never raises" — it would propagate into `_flush_loop`, killing the flush task and
losing every later batch too. (`_record` is only reachable today with well-typed
buffer rows, so this half is PLAUSIBLE; the fix for both halves is the same.)

Smallest fix: clamp/validate the int4 columns the way `_clamp_small` does for
smallints (drop the row, not the batch), fall back to per-record inserts on
`DataError` so one bad row costs one row, and move the `run_in_executor` line
inside the try.

Not reported but worth knowing: `test_history_pg.py` (17 tests) does run in CI —
`.github/workflows/ci.yml:44-61` adds a real Timescale service + env — so the PG
half is not vacuous. `_maintenance_pass`/`enforce_budget`/`prune` and the
`positions_hourly` reads were checked against the guard tests and behave as
documented (the newest chunk is never dropped; 0 disables the cap; the loop always
terminates via `if not gone: break`).

**Verdict — Wave 1: fix-first.** The storage move is real and the guards are real,
but a connectable-but-unprivileged DB leaks connections per request (W1-1) and a
single malformed fix silently deletes a whole flush batch (W1-2). Both are cheap to
fix and both fail in the "the archive is quietly wrong" direction the repo has
been burned by before.

---

## Wave 2 — heatmap replay proxy (`adsb_heatmap.py`, `routes/history.py`)

### W2-1 · HIGH · a truncated cache file turns `/api/history/upstream/chunk` into a permanent 500

`apps/api/app/adsb_heatmap.py:134-150` (`_read_cache`) catches only `OSError`,
but a gzip stream cut short raises `EOFError` (`gzip.BadGzipFile` is an OSError
subclass; truncation is not). `fetch_chunk` (line 170) awaits that read before it
touches the network and documents "All failures return None, never raise", so the
exception propagates out of the route handler as a 500 — and because the poisoned
file is never removed, it 500s every retry for that (day, index) forever. The file
gets into that state because `_write_cache` (line 152-157) writes gzip in place
rather than to a temp file + `os.replace`, so any kill/ENOSPC mid-write leaves a
partial chunk. The same missing containment has a second trigger: if `_write_cache`
itself raises, `fetch_chunk` throws away a chunk it already fetched successfully.

VERIFIED (real code path, `HEATMAP_HOSTS=''` so no network is involved):

```
$ OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/python
poisoned cache file: /tmp/.../heatmap/2026/09/10/05.bin.ttf.gz 32 bytes
fetch_chunk RAISED: EOFError Compressed file ended before the end-of-stream marker was reached
```

Smallest fix: in `_read_cache`, catch `Exception` (or `OSError, EOFError, zlib.error`)
and `path.unlink(missing_ok=True)` on failure so the next request re-fetches; write
via `tmp = path.with_suffix('.tmp')` + `gzip.open(tmp,'wb')` + `tmp.replace(path)`.
Wrap the `_write_cache` call in `try/except OSError` so a cache-write failure never
fails a good fetch.

Checked and clean: no path traversal (`day` is a `date` from `date.fromisoformat`,
`index` is `int` with `ge=0, le=47`; the formatted `cache_path` cannot escape the
cache root), no SSRF (hosts come from operator config, scheme is hardcoded https),
routes are behind the app-level auth middleware, and the LRU/budget walk keeps the
newest file. The only cache-side nit is that `coverage.json` is exempt from
`enforce_cache_budget` and never evicts entries (unbounded, ~40 B/entry
PLAUSIBLE, low).

**Verdict — Wave 2: fix-first** for W2-1 alone (three lines); everything else in
this wave is solid.

---

## Wave 3 — chunked replay frontend (`HistoryPlayback.ts`, `heatmapChunk.ts`, `heatmapWorker.ts`, `TimeDock.tsx`)

### W3-1 · HIGH · the upstream replay path is dead whenever the backend records to Timescale

`apps/web/src/globe/HistoryPlayback.ts:377-397` resolves "how far back does the
own archive go" from `stats.shards` only:

```ts
const s = (await r.json()) as { shards?: { day: string }[] };
const days = (s.shards ?? []).map(...)...;
if (days.length === 0) return { ms: 0, day: null };   // "treat everything as own archive"
```

On the Timescale backend `history.stats()` returns a literal `"shards": []` (plus
`oldest_ts`) — `apps/api/app/history.py:1286-1310`. So `oldest.ms` is 0,
`chunkStartMs(day,index) < oldest.ms` is false at every call site (`:513`, `:520`,
`:556`, `:558`), `aircraftFromUpstream` is always false, `fetchUpstreamChunk` is
never called, and the headline feature of this wave (replay 2024+ from tar1090
chunks) silently degrades to "own archive only" — with the picker still offering
2024 days and the label still claiming the upstream archive. The frontend tests all
mock the SQLite shape (`HistoryPlayback.test.ts:231,281,296`,
`TimeDock.test.tsx:82,260` all return `{shards:[{day:'2020-01-01'}]}`), so nothing
catches it.

VERIFIED (backend half — the frontend half is the one-line inference from it):

```
$ OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/python   # scratch Timescale db, HISTORY_BACKEND=timescale
backend: timescale
shards: []
sharded: False
oldest_ts: None            # empty scratch archive; non-empty returns the epoch float
stats() has key 'shards'? True | has 'oldest_ts'? True
```

Smallest fix: in `resolveOldest`, accept either shape —
`if (!days.length && typeof s.oldest_ts === 'number' && s.oldest_ts > 0) return { ms: s.oldest_ts * 1000, day: dayUtc(s.oldest_ts * 1000) }`
— and add a vitest case that feeds the Timescale payload. (Better still: have the
backend return a backend-neutral `oldest_day`.)

### W3-2 · LOW · the replay label names a host that did not serve the data

`HistoryPlayback.ts:443-447` hardcodes `aircraft · adsb.fi archive · …`.
`heatmap_hosts` defaults to `adsb.lol,globe.adsb.fi` and `config.py` records that
adsb.fi 403s every client from this egress while adsb.lol keeps serving, so the
label is a claim the code cannot back. The route already returns the truth
(`X-Heatmap-Host`, and `host` on `/api/history/upstream/tracks`). Fix: read
`r.headers.get('X-Heatmap-Host')` in `fetchUpstreamChunk` and build the label from
it, or drop the host name from the label.

### W3-3 · LOW · the decode Worker leaks when the viewer is already destroyed

`HistoryPlayback.ts:579-591`: `destroy()` returns early on
`viewer.isDestroyed()` — before `decoder.terminate()` (line 589). That is exactly
the path its own comment describes (HMR teardown / globe ErrorBoundary), so the
Worker thread and its module graph outlive the component. Fix: hoist
`decoder.terminate()` above the `isDestroyed()` early return. Related, same
function: `terminate()` clears the `pending` map without rejecting, so an in-flight
`decode()` promise would hang forever rather than settle (LOW, same fix site).

Everything else here holds the guarded invariants: replay entities are upserted by
id (`ds.entities.getById`) and never `removeAll()`-ed on the automatic chunk
advance, icons come from `aircraftStyle`/`vesselStyle` with a reassigned constant
rotation (no fabricated per-frame motion), `requestRenderMode` is never flipped
off and `maximumRenderTimeChange` is saved/restored, and the chunk cache is a
bounded 24-entry LRU. `heatmapChunk.ts`'s decoder matches the backend decoder on
the same fixture bytes.

**Verdict — Wave 3: fix-first.** W3-1 alone decides it: without it the wave's
stated feature is inert on the very backend this branch introduces, and the tests
are shaped to the old payload so they will keep passing.

---

## Wave 4 — clearance on local reads (`ontology_local.py`, routes)

### W4-1 · HIGH · the read filter is enforced, the WRITE gate is missing on `/api/situations` and `/api/maps`

`apps/api/app/routes/ontology.py:86-108` added `_refuse_overwrite_of_hidden_row`
and applies it to `POST /api/ontology/object` and `POST /api/ontology/promote`,
with the explicit reasoning "an unfiltered `upsert` would let a clearance-0 caller
replace a level-4 object's props (and its classification) wholesale". The other
two routers that upsert by caller-supplied id never got that gate:
`routes/situations.py:219-232` (`POST /api/situations`) and `routes/maps.py:214-238`
(`POST /api/maps`) both build a filtered registry for reads and then call
`reg.upsert(...)`, but `_clearance_sql`/`_visible` are read-path only, so the
upsert lands unconditionally. `props` is a wholesale replace, so the write both
destroys and DECLASSIFIES a row the caller cannot read — and the response body
hands back what was written.

VERIFIED, end to end over HTTP (keyless TestClient, real routes):

```
BEFORE: classification= 4 compartments= ['FVEY'] props= {'kind':'situation','name':'SECRET OP','summary':'classified fact'}
POST /api/situations -> 201 {"id":"situation:deadbeef","name":"pwned by clearance 0",...}
AFTER : classification= 0 compartments= [] props= {'kind':'situation','name':'pwned by clearance 0',...}
```

and the same on maps (note the GET correctly hides the row):

```
BEFORE: 4
GET  /api/maps  -> 200 0 rows visible to clearance 0
POST /api/maps  -> 201 {"id":"map:topsecret","name":"pwned", ...}
AFTER: 0 {'kind': 'map', 'name': 'pwned', 'state': {...}}
```

On a keyless box this is the local clearance-0 principal; on a Supabase deployment
the identical code path means any signed-in analyst declassifies/erases a level-4
situation or COP by id.

Smallest fix: move `_refuse_overwrite_of_hidden_row` (and
`_refuse_write_above_clearance`) into a shared helper — e.g.
`app/intel/ontology.visible_to`'s module or a small `routes/_clearance.py` — and
await it before every id-keyed `upsert`/`assert_props` (situations create, maps
save, and the same call sites in `routes/osint.py:1162/1236`,
`routes/countries.py:82`, `intel/actions.py` if they can land on an arbitrary id).

Everything the wave claims to have fixed on the read side does hold:
`get`/`list_by_kind`/`search`/`traverse`/`path_between`/`get_assertions` all pass
through `visible_to` (or `_clearance_sql` + `_visible`), `_links_touching` filters
edges on BOTH persisted endpoints so a level-0 edge cannot leak a hidden id as a
derived stub, out-of-clearance reads answer like absence (404 / no rows), and the
compartments half is correctly case-insensitive via `clf.can_read`. `classification`
is `INTEGER NOT NULL DEFAULT 0` in both tables, so the `classification <= ?` clause
cannot silently drop NULL rows.

**Verdict — Wave 4: fix-first.** The read predicate is the right shape and is
applied thoroughly; the wave stops one function short of its own threat model, and
the miss is a destruction/declassification path rather than a mere disclosure.

---

## Wave 5 — merge review (`intel/resolve.py`, `routes/resolve.py`)

### W5-1 · LOW · the new list route carries no auth dependency at all

`apps/api/app/routes/resolve.py:36-40`: `GET /api/resolve/candidates` depends only
on the router-level `audit_mutation`; the two POSTs each add
`Depends(require_operator)`. Verified against the app's own dependency tree:

```
$ ...python    # walk route.dependant for the resolve router
['GET'] /api/resolve/candidates -> ['audit_mutation', 'get_candidates']
['POST'] /api/resolve/candidates/{a}/{b}/approve -> [... 'current_principal_or_local', 'current_user_or_local', 'require_operator']
['POST'] /api/resolve/candidates/{a}/{b}/reject  -> [... same ...]
```

`resolve.db` has no user scoping at all (`resolve.py:95-140`: no `user_id` column,
process-global `_resolved_db_path()`), so on a multi-user deployment the queue of
entity collisions — ids, kinds and display names of the vessels/aircraft someone
else is tracking — is readable by any credential the middleware admits (including a
machine static key). The anti-rot walk in
`tests/test_clearance_local_reads.py:259-292` only walks the ontology / situations /
evidence / maps routers, so this route is outside the guard.

Smallest fix: `p: Principal = Depends(current_principal_or_local)` on
`get_candidates`, and add `resolve` to that anti-rot walk's router list.

The scoring and merge logic itself is sound: `decide` is the only path that merges,
it is operator-gated on both verbs, it is audited with an explicit `audit(...)` row,
the pair lookup is order-insensitive (`sorted`) while winner/loser follow the
caller's order, and the frontend passes the stored order so the winner is
deterministic. `_conflict_score`'s bands and the name-similarity bonus are clamped
to [0,1]. No auto-merge regression: `test_resolve_still_never_auto_merges_on_a_collision`
still holds.

**Verdict — Wave 5: ship after the one-line dependency** (W5-1); no correctness
defect found in the merge path.

---

## Wave 6 — Foundry cursor pull + documents (`foundry/connections.py`, `foundry/documents.py`, `routes/foundry.py`)

### W6-1 · MED · the cursor pull permanently drops every row that shares the last cursor value

`apps/api/app/foundry/connections.py:326-338`: the table mode pages with
`ORDER BY cursor_column LIMIT batch`, then persists `rows[-1][cursor_column]` and
next cycle filters `cursor_col > :cursor_after`. Nothing enforces that the cursor
column is unique or that a batch does not end mid-tie, so when more rows share the
final cursor value than fit in the batch, the remainder are never pulled again —
and because the cursor is written from the page's last row, it pins at that value
and every later cycle returns 0 rows while the connection keeps reporting healthy
(`mark_connection(ok=True, rows_added=0)`). The tests all use a distinct integer id
cursor, so the guard cannot see it.

VERIFIED (six rows, all with `seq = 1`, `batch = 3`):

```
$ OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/python   # drives _run_sql_table_cycle directly
cycle 1: pulled 3, cursor_value=1
cycle 2: pulled 0, cursor_value=1
rows ever written into the dataset: ['row1', 'row2', 'row3']
```

Smallest fix: page INSIDE one cycle until a short page comes back
(`while len(page) == batch: keep pulling`), which also makes a large backlog catch
up in one go; or key the cursor on `(cursor_column, primary_key)` and resume with
a row-value comparison; or, at minimum, validate at the route boundary that
`cursor_column` is unique+not-null and refuse with 422 otherwise.

### W6-2 · MED · document extraction runs synchronously on the event loop

`apps/api/app/routes/foundry.py:405-408`: `read_capped` is awaited (good) but
`documents_mod.document_row(...)` is then called inline in the async handler, and
it does `hashlib.sha256(data)` plus a zip+XML parse (`_extract_docx`) or a full
pypdf pass (`_extract_pdf`) over a body up to `store.MAX_UPLOAD_BYTES`. That is
seconds of blocking on the loop the 1 s ADS-B tick, the `/ws/adsb` push and every
other request share — the same hazard the repo already handles elsewhere
(`routes/evidence.py` re-hashes blobs in a thread precisely because "a synchronous
hash here would block the 1 s ADS-B poll"). PLAUSIBLE (by construction, not timed).

Smallest fix: `row = await asyncio.to_thread(documents_mod.document_row, name, content)`.
While there, consider a decompressed-size cap in `_extract_docx` so the upload byte
cap is not defeatable by a zip bomb (LOW).

Auth/audit posture of the new routes is correct: `upload_document` carries
`Depends(require_operator)` and lives on a router with
`Depends(require_compute_enabled), Depends(audit_mutation)`; `table`/`cursor_column`
are rejected unless they are bare identifiers at create AND update, and the query is
built through `sqlalchemy.table()/select()` with a bound parameter (no string SQL);
`_fingerprint` correctly excludes `cursor_value` so recording progress does not
bounce the task; DSNs remain env-var names and the tests prove the scrubber.

**Verdict — Wave 6: fix-first for W6-1** (silent, permanent row loss in the
feature's core loop) and W6-2; the rest of the wave is well-built.

---

## Wave 7 — projection (`intel/project.py`, `routes/projection.py`, `scripts/backtest_projection.py`)

No findings worth an entry. The analytic is derived only from the contact's own
fixes with the same `pol.py` gating (>=30 s segments, plausible-speed filter),
heading uses a proper circular mean/std with a bounded fan, a too-short or too-static
track answers `status: "insufficient"` with a reason rather than a guess, the cone
polygon is a well-formed ring in both the wedge and the annular case, and both the
tests and `scripts/backtest_projection.py` score the cone with a real
point-in-polygon check over real fixes (the script's sampling is bounded to one
1-hour window on purpose, per the 2026-07-16 WAL post-mortem). Two nits only:
`scripts/backtest_projection.py`'s docstring still says it "opens `data/history.db`
directly" although `app.history` now follows `HISTORY_PG_DSN`, and the projection
route answers for an entity regardless of the caller's clearance — consistent with
`routes/history.py` (the position archive has no classification columns), but it is
one more place where "clearance reaches every read" is not yet true.

**Verdict — Wave 7: ship.**

---

## Summary

| # | Wave | Sev | File | One-line |
|---|------|-----|------|----------|
| W4-1 | clearance | HIGH | routes/situations.py:226, routes/maps.py:226 | write-side clearance gate missing → declassify + erase a hidden row |
| W3-1 | replay UI | HIGH | apps/web/src/globe/HistoryPlayback.ts:377-397 | `stats.shards` is `[]` on Timescale → upstream replay never runs |
| W2-1 | heatmap proxy | HIGH | apps/api/app/adsb_heatmap.py:134-157 | truncated cache file → permanent 500 for that chunk (contract says never raise) |
| W1-2 | timescale | MED | apps/api/app/history_pg.py:406-455 | one malformed fix drops the whole flush batch; executor outside the try |
| W1-1 | timescale | MED | apps/api/app/history_pg.py:247-297 | failed schema apply leaks a PG connection per call |
| W6-1 | foundry | MED | apps/api/app/foundry/connections.py:326-338 | cursor tie straddling a batch → rows never pulled, cursor pinned |
| W6-2 | foundry | MED | apps/api/app/routes/foundry.py:407 | docx/pdf/sha256 extraction blocks the event loop |
| W5-1 | resolve | LOW | apps/api/app/routes/resolve.py:36-40 | new GET has no principal/session dependency |
| W3-2/3 | replay UI | LOW | HistoryPlayback.ts:443, :589 | label claims adsb.fi regardless of host; Worker leaks on early-return destroy |

Fix-first: Waves 1, 2, 3, 4, 6. Ship: Waves 5 (after one line) and 7.
