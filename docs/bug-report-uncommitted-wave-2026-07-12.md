# Bug report — uncommitted working-tree wave (2026-07-12)

Branch `infra-country-facility-wave`. Scope: the uncommitted evidence-locker +
case-export, globe-toolbar / floating-panels, and AI selection-brief fusion
waves plus assorted modified files.

## STATUS: all 11 fixed (2026-07-12)

Every finding below was fixed in the working tree. A 12th bug was found and
fixed while adding the concurrency guard: offloading the blob write to a thread
(the #5 fix) made two identical-content writes race on a shared `.partial` temp
file — `_write_blob` now uses a unique temp name per writer.

Verification this turn: backend `1539 passed + 1 skipped` (up from the 1536
baseline; +3 new guard tests: tampered-export-shows-ALTERED, concurrent-capture
single-created, size-cap-preserves-custody, plus extended SSRF/manifest
assertions). `pnpm -r typecheck` green; eslint clean on the 3 changed FE files;
`ruff check` clean; web unit tests 18/18 on the touched suites. The frontend
fixes (#7–#10) are typechecked + lint-clean but NOT yet browser-verified.

| # | File | Fix |
|---|------|-----|
| 1 | routes/evidence.py | `/blob` now forces `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` + `Content-Security-Policy: default-src 'none'; sandbox` |
| 2 | intel/evidence.py | `_ip_is_blocked` unwraps IPv4-mapped / 6to4 / Teredo IPv6 before the flag checks |
| 3 | intel/evidence.py, case_export.py | manifest adds a real re-hashed `blob_verified`; report labels verified / ALTERED / MISSING off it, never stat-only presence |
| 4 | intel/ontology_local.py | byte-cap prune excludes `prop='custody'` (both count and DELETE), mirroring the per-object cap |
| 5 | routes/evidence.py, intel/evidence.py | blob read+hash and the 200 MB write moved off the event loop via `asyncio.to_thread` |
| 6 | intel/evidence.py | per-content-hash `asyncio` lock serializes the get→upsert→custody section so concurrent identical captures log one `created` |
| 7 | globe/GlobeToolbar.tsx | Move tool grabs a marker only within `GRAB_PX` screen pixels + horizon-occlusion test (zoom-aware; distant/back-of-globe markers ignored, panning restored) |
| 8 | shell/FloatingPanel.tsx | drag/resize use `setPointerCapture` + `pointercancel` teardown; no more stuck-to-cursor / permanent `user-select:none` |
| 9 | evidence/EvidencePanel.tsx | thumbnail re-checks `cancelled` after the blob await so no object-URL leak on unmount |
| 10 | evidence/EvidencePanel.tsx | download defers `revokeObjectURL` (+ in-DOM anchor) so Firefox/Safari don't abort the save |
| 11 | tests | clamp test asserts no un-clamped run survives; `openMode` test asserts the value `is True` |


Method: 8 parallel Opus "finder" agents, one lens each (backend correctness,
security, new-UI React, modified-shell React, Cesium/globe invariants,
cross-layer contracts, async/race/leak, test integrity). **Adversarial
verification was skipped by operator request** — every item below is a
finder's claim, read the cited code before acting. Confidence tags reflect how
concretely the finding is argued and whether multiple independent finders hit
it.

Two lenses (contracts, one backend pass) returned zero findings.

---

## Confirmed-by-multiple-finders / highest confidence

### 1. Case export certifies tampered evidence as "verified" — MEDIUM (3 finders independently)
`apps/api/app/intel/case_export.py:181`, `apps/api/app/intel/evidence.py:567`

`custody_manifest` sets each exhibit's `blob_present` from `blob_exists()` — a
stat-only existence check (`evidence.py:157-160`), never a re-hash.
`render_html` then prints `ok = "verified" if it.get("blob_present") else
"MISSING/ALTERED"`, and the JSON manifest's `berkeley_protocol` note
(`evidence.py:586-590`) asserts "blob_present=true means the stored bytes still
hash to that value" — both false. If a stored blob at
`<evidence_dir>/<ab>/<sha256>` is overwritten in place (corruption or an
attacker with volume access), the shareable, court-facing case report labels
the altered exhibit **verified**. The per-object `/verify` and `/blob` routes
DO re-hash and correctly 409, so the bulk export path is the sole blind spot,
and no test exercises a tampered blob through the manifest. This is the exact
failure the chain-of-custody feature exists to prevent.

**Fix direction:** have `custody_manifest` call `verify_blob()` (re-hash) per
item, or add a distinct `blob_verified` field and never print "verified" off a
stat.

---

## Security

### 2. Stored XSS via evidence `/blob` (attacker-controlled Content-Type, inline, no nosniff) — HIGH
`apps/api/app/routes/evidence.py:272`

The blob route returns the object's stored `media_type` verbatim
(`obj.props.get("media_type") or "application/octet-stream"`) with
`Content-Disposition: inline` (default in `_content_disposition`) and **no
`X-Content-Type-Options: nosniff` / CSP**. `media_type` is fully
attacker-controlled: `CaptureScreenshotIn.media_type` is a free-form unvalidated
`str`, and `upload_evidence` trusts `file.content_type`. On the shipped default
(`docker-compose` sets `ALLOW_UNAUTHENTICATED=1`, and evidence routes are open
even without it), an anonymous attacker POSTs a screenshot with
`media_type='text/html'` and a `<script>` body, gets the sha256, then lures an
analyst to `/api/evidence/<sha>/blob`. Because the API and web app share one
origin, the HTML executes in the app origin and can read the API
key/Supabase token from `localStorage`. `image/svg+xml` uploads are an
equivalent vector.

**Fix direction:** serve blobs with `Content-Disposition: attachment` +
`X-Content-Type-Options: nosniff`, or force a whitelisted/safe Content-Type.

### 3. SSRF guard bypass via IPv4-mapped IPv6 on the pinned 3.12 container — MEDIUM (version-dependent, NOT reproduced this turn)
`apps/api/app/intel/evidence.py:282`

`_ip_is_blocked` classifies resolved addresses purely via stdlib `ipaddress`
flags. For a literal like `http://[::ffff:169.254.169.254]/` (cloud metadata),
the OS routes to 169.254.169.254, but only newer CPython delegates mapped-IPv4
classification to those flags. The finder verified the **host venv (3.14)
blocks it**; the Dockerfile pins `python:3.12-slim`, where the finder believes
delegation is absent so the literal reports non-private and passes the guard,
letting the keyless `capture_url` route fetch metadata/internal services and
serve the bytes via `/blob`. **The 3.12 behavior was inferred, not executed** —
confirm in a 3.12 container before trusting.

**Fix direction:** unwrap `addr.ipv4_mapped` before the flag checks, or reject
any non-`is_global` address explicitly.

---

## Backend correctness / durability

### 4. Byte-budget prune can delete append-only custody assertions — LOW severity tag, HIGH impact
`apps/api/app/intel/ontology_local.py:604`

The evidence wave guarantees `prop='custody'` events are the append-only legal
record and patched the per-object cap (`ontology_local.py:564-576`) to exclude
them (`AND prop!='custody'`). But the soft size cap `_maybe_enforce_size_cap`
(fires above `ontology_db_max_bytes`, default 2 GB) deletes the globally-oldest
10% of **all** assertions with **no** `prop!='custody'` exclusion. Since an
evidence object is captured once and never re-touched, its custody assertions
carry the oldest `observed_at` and sort first under `ORDER BY observed_at ASC,
id ASC` — so the chain-of-custody log is the *first* thing purged, silently
destroying the record the feature promises to keep.

**Fix direction:** mirror the per-object cap's `AND prop!='custody'` exclusion
in `_maybe_enforce_size_cap`.

### 5. Metadata/blob routes read + hash up to 200 MB synchronously on the event loop — MEDIUM
`apps/api/app/routes/evidence.py:252` (and `:267-270`)

`GET /api/evidence/{sha}` calls `verify_blob()`, which does `read_blob()`
(`path.read_bytes()` of the whole file) + `sha256_bytes()` — both synchronous,
no `to_thread`/`run_in_threadpool` — directly on the async loop. Hashing
~150-200 MB takes ~0.5-1 s during which the single loop can't service the
`/ws/adsb` push or the 1 s HTTP poll, regressing the CLAUDE.md 1 s-cadence
invariant. Same blocking pattern in `GET .../blob` and the 200 MB `_write_blob`.

**Fix direction:** wrap the read+hash in `asyncio.to_thread` /
`run_in_threadpool`.

### 6. Concurrent captures of identical bytes append duplicate "created" custody events — LOW
`apps/api/app/intel/evidence.py:234`

`capture_bytes` does `existing = await reg.get(obj_id)` — the `await` yields the
loop before either concurrent request upserts. Two requests capturing the same
content both see `existing is None`, both upsert, and both `_append_custody`
with `action="created"` (`:261`), so the authoritative timeline gets two
"created" events for one object instead of created + re-observed. No
lock/uniqueness guard between the get and the upsert.

---

## Frontend (new UI substrate)

### 7. Move tool grabs the globally-nearest annotation with no distance threshold — MEDIUM
`apps/web/src/globe/GlobeToolbar.tsx:152`

The comment promises a "~40 km" angular threshold but it was never implemented.
`best` is set to the nearest point-annotation and only compared via `d <
best.d`; `if (best)` is true whenever *any* annotation exists. So with the Move
tool active, a mouse-down + drag *anywhere* (e.g. panning over empty ocean)
grabs the single nearest marker — even one on another continent — disables
camera rotate/translate, and `MOUSE_MOVE` teleports that marker to the drop
point. Net: the globe can't be panned while Move is active, and annotation
positions get silently corrupted.

**Fix direction:** add the missing `best.d < THRESHOLD_KM` guard before
capturing `dragId`.

### 8. FloatingPanel drag/resize leaks a `pointermove` listener and sticks to cursor — MEDIUM
`apps/web/src/shell/FloatingPanel.tsx:54`

`onDragDown`/`onResizeDown` register `pointermove`+`pointerup` on `window` and
set `body.userSelect='none'`, but teardown runs only on `pointerup`. No
`setPointerCapture`, no `pointercancel`/`lostpointercapture` handler. Release
outside the viewport or a `pointercancel` (touch/pen/gesture) leaves the `move`
listener attached: the panel keeps calling `setRect` and tracks the cursor with
no button held, and `body.userSelect` stays permanently `'none'` (text
unselectable). Present in both handlers.

**Fix direction:** add `pointercancel` to teardown and/or use pointer capture.

### 9. `EvidenceThumb` leaks an object URL if unmounted during `r.blob()` await — LOW
`apps/web/src/evidence/EvidencePanel.tsx:40`

If the component unmounts (or `sha` changes) while suspended at `await
r.blob()`, cleanup sets `cancelled=true` but `url` is still null so nothing is
revoked. The await then resolves and `URL.createObjectURL(...)` allocates a blob
URL that is never revoked (the `if (!cancelled)` skips `setSrc` but not the
allocation). Leak persists until reload.

### 10. Evidence download revokes the object URL synchronously after `a.click()` — LOW
`apps/web/src/evidence/EvidencePanel.tsx:78`

Creates a fresh object URL, `a.click()`, then `URL.revokeObjectURL(url)` in the
same tick. On Firefox (and Safari with a detached anchor) revoking before the
download's fetch starts can cancel the save, so "download" silently does
nothing.

**Fix direction:** defer the revoke (e.g. `setTimeout(..., 0)` or on the next
tick).

---

## Test integrity (weak assertions that protect nothing)

### 11a. Prompt-clamp test passes even if `_clamp_props` is a no-op — LOW
`apps/api/app/routes/ai_selection.py:69`, `apps/api/tests/test_ai_selection.py:303`

`test_selection_brief_clamps_long_string_props` sends `{"note": "y"*800}` and
asserts `len(content) < len(long_val) + 200` (i.e. < 1000). The *unclamped*
prompt is only ~832 chars, already < 1000 — so the assertion holds whether or
not the clamp truncates. Removing the clamp or raising `_MAX_STRING_LEN` above
800 still passes. Correct bound would be near `_MAX_STRING_LEN` (~600).

### 11b. `openMode` config test checks type only, not the deterministic value — LOW
`apps/api/app/routes/config.py:48`, `apps/api/tests/test_config_route.py:35`

Asserts only `isinstance(body["openMode"], bool)`. In the conftest env
`openMode` is deterministically `True`. An inverted computation (dropping the
`not`, or returning `_auth_enabled(settings)`) still yields a bool and passes,
while the UI open-mode banner silently stops showing on a public box. Assertion
should be `is True`.

---

## Coverage note

Verification (2 adversarial refuters + tie-breaker per finding) and the round-2
coverage-critic pass were **not run** — stopped after round 1 by request. The
contracts lens (FE↔API response-shape drift for the new evidence/case-export/
ai-selection routes, config-key drift, compose/env plumbing) came back clean,
but with only one pass that is weaker evidence than the security/backend
findings above. If you want the confirmations, re-run the workflow without the
early stop.
