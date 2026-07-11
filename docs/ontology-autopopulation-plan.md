# Ontology auto-population — W4 slice 1: incidents flow into the graph automatically

Spec for `docs/roadmap-users-2026-07.md` §W4 / `docs/roadmap-ontology-2026-07.md`
"Phase 2 — The world flows into the graph". Scope is deliberately the smallest
honest slice: the watch-officer's already-running fusion loop also mints each
*actionable* incident into the local ontology as an `incident:<id>` object with
sourced assertions and `evidence_of` reason links to its member entities, so
`GRAPH` is non-empty on a keyless boot with zero operator setup. Everything
else Phase 2 describes (budget/prune pass, detector-bus hook, standing-watch
link, dossier enrichment, history backfill, `/api/ontology/schema`) is named
and deferred to slice 2 in §D — nothing is silently dropped.

All file:line references below were read this session (2026-07-11, branch
`roadmap-first-users`). Where an assumption in the originating brief didn't
survive contact with the source, that is called out explicitly.

## 1. Why this slice, and its boundary

`incidents.brief()` (`apps/api/app/intel/incidents.py`) already fuses
cross-domain signals into ranked, narrated, evidenced incidents. The
watch-officer (`apps/api/app/intel/watch_officer.py`) already runs this every
120 s and files a brief for new/escalated actionable incidents into an
in-memory dict (`_BRIEFS`, line 37) — real sense-making, but it never touches
the ontology. The GRAPH page's `/api/ontology/search-around` and `/traverse`
only ever see what a human explicitly promotes via the one manual path
(`routes/ontology.py:126-152` ← `EntityPanel.tsx:539` ← `actions.py:171-198
_handle_promote_incident`). Zero live incidents have ever become ontology
objects automatically.

This slice adds exactly one automatic mint path, reusing the existing
provenance-first write verb (`assert_props`, not `upsert` — CLAUDE.md's
wholesale-replace/never-merge rule applies to `upsert`, not to this call) and
the existing `evidence_of` relation. It does **not** touch `watch.py` (W3's
hot file), does not add a new background loop, does not add global budgeting/
pruning, and does not add a config setting.

## 2. Substrate already verified

- **`assert_props` is the correct verb, `upsert` is not.**
  `apps/api/app/intel/ontology_local.py:394-467` — merge-style evidenced
  write: each prop lands as a deduped assertion and merges into the
  materialized blob; the object row is created as a stub if absent
  (`kind_of(object_id)` derives `kind="incident"` automatically, line 449).
  `upsert` (lines 160-234) replaces `props` wholesale including removals —
  exactly the behavior CLAUDE.md protects for the Investigation-canvas
  round-trip contract, and exactly why this pipeline must never call it on an
  `incident:*` object.
- **`Link.source` is a first-class field**, default `"analyst"`
  (`ontology.py:174`) — every `evidence_of` link this pipeline creates passes
  `source=` explicitly so it's honestly attributed, not defaulted.
- **`ObjectKind` already has `"incident"`** (`ontology.py:58`) and
  `KNOWN_RELS` already has `"evidence_of"` (`ontology.py:83`, comment: `#
  signal/track → incident it supports`) — no schema change needed.
- **The manual template, and a direction inconsistency in it.**
  `actions.py:171-198 _handle_promote_incident` mints `incident:<uuid>` and
  writes `Link(src=p.target_id, dst=incident_id, rel="promoted_to")` then
  `Link(src=incident_id, dst=p.target_id, rel="evidence_of")` (line 191) —
  **incident → target**. That is backwards from `ontology.py:83`'s own
  documented canonical direction (`signal/track → incident`), and backwards
  from this task's instruction ("`evidence_of` links from each translated
  member entity → the incident object"). Three sources agree on
  member→incident (the `KNOWN_RELS` docstring, `roadmap-ontology-2026-07.md`
  Phase 2's "object with `evidence_of` links to the incident", and this
  brief); the existing manual handler is the outlier. **This slice follows
  the documented canonical direction — `member_entity --evidence_of--> incident`
  — not `actions.py`'s inverted edge.** Flagging this rather than silently
  perpetuating or silently fixing the older handler (out of scope: `actions.py`
  is not in this slice's touch list).
- **`incidents.brief()`'s `inc["id"]` is NOT stable across cycles.**
  `incidents.py:421`: `"id": uuid.uuid4().hex[:10]` — freshly generated every
  time `brief()` clusters signals, including for the same real-world
  convergence. Minting `incident:<inc["id"]>` every 120 s would create a new
  object every cycle — the exact firehose this slice must avoid. The stable
  identity already exists one module over:
  `apps/api/app/intel/incident_store.py:24-28 incident_key()` — "0.5°
  centroid grid + sorted domain set", already used by `watch_officer.py` as
  the `_BRIEFS` dict key (line 37) and by `incident_store.record()`'s new/
  escalated diff (`incident_store.py` `_summary()`/`record()`). This slice
  hashes `incident_key(inc)` into the deterministic id — reuse, not a new
  concept. Note: `incident_key`'s domain-set component is only stable
  because `incidents.py:425` emits `"domains": sorted(domains)` — if that
  call site ever stopped sorting, the same convergence could hash to a
  different key across cycles and this slice's determinism claim would
  quietly break.
- **Evidence `ref` shapes — which are translatable, which are not.**
  `incidents.py` `_gather()` builds each `Signal.ref` differently per domain;
  `brief()` copies it verbatim into `evidence[i]["ref"]` (`incidents.py:406-412`):
  - `air-emergency` (line 107-110) and `military` (line 111-116): `ref` has
    `icao24` → translates to `aircraft:<icao24>`.
  - `dark-vessel` (line 132-138): `ref` has `mmsi` → translates to
    `vessel:<mmsi>`.
  - `gps-jamming` raw cells (line 120-129): `ref = {"cell": [lon, lat],
    "percent_bad": ...}` — **no entity id, not translatable.**
  - `quake` (line 141-160): `ref = {"mag": mag}` — **no entity id.**
  - `event` (EONET/GDELT/ACLED, line 205-239): `ref = {"source": src, "id":
    f.get("id")}` — the `id` is the EXTERNAL feed's id (a GDELT/EONET/ACLED
    key), not a canonical Velocity ontology id — **not translatable** without
    a new `event:<source>:<id>` kind this slice does not add.
  - `spoofing` (line 195-199): `ref = {"type": f["type"]}` — **no entity id.**
  - Alert-bus-sourced signals (`ais_gap_in_aoi`, `proximity_mil_vessel`,
    `mil_in_aoi`, `gps_jam_cluster`, `emergency_squawk`, `major_quake` — the
    `rule_domain` map, line 164-171): `ref = {"alert_id": al.id, "rule":
    al.rule_id}` (line 178-183) — the alert's own id, **not** the underlying
    aircraft/vessel id, so **not translatable** even though some of these
    logically concern a specific airframe (the id isn't carried through).
  Net: **only `air-emergency`, `military`, and `dark-vessel` evidence items
  are translatable this slice.** An incident whose evidence is entirely
  `quake`/`event`/`gps-jamming`/`spoofing`/alert-only has zero translatable
  members and — per §3.A below — is skipped, not minted with zero reason
  links.
- **Keyless-ctx precedent (the Q7 answer).** `get_registry(ctx, settings)`
  (`ontology.py:392-402`) needs a `UserCtx`; the browser path resolves one via
  `current_user_or_local` (`apps/api/app/keys.py:157-173`), which needs a
  `Request` the background loop doesn't have. Two other headless background
  modules already solved exactly this, with the identical fallback:
  - `apps/api/app/workflows/scheduler.py:29`: `_LOCAL_CTX =
    UserCtx(user_id="local", token="")`, comment: "Same shared local identity
    Foundry's build-runner defaults to (keys.py:172's keyless fallback) —
    schedules run headless, with no request/caller ctx." Used at line 48.
  - `apps/api/app/foundry/builds.py:21`: identical `_LOCAL_CTX =
    UserCtx(user_id="local", token="")`, comment: "Default identity for
    auto-sync when a caller doesn't thread one through yet … same fallback
    `current_user_or_local` uses on a keyless boot, keys.py:172." Used at
    line 169.
  This is the exact, already-blessed pattern — not a new idea. **Honest
  limitation, inherited, not novel to this slice**: on a Supabase-configured
  (per-user) deployment, `current_user_or_local` resolves the *signed-in
  user's* ctx, but this background loop always uses `"local"` — auto-minted
  incidents would land in a graph no real per-user session queries. Since
  `get_registry()` is the *only* store as of 2026-07-07 (Supabase/PostgREST
  backend deleted, `docs/decisions.md`) and always returns a `SqliteRegistry`
  scoped by `ctx.user_id` regardless of Supabase config, this only matters as
  a *data-visibility* question, not an availability one — and it's the
  identical tradeoff `scheduler.py`/`builds.py` already accepted. On the
  target scenario this slice exists for (a keyless boot — CLAUDE.md: "Keyless
  layers keep working with no API key"; W4's stated goal: "kills the
  photographed empty-graph demo failure" on exactly that boot), `"local"` is
  precisely the id `current_user_or_local` itself returns
  (`keys.py:172`), so the auto-minted graph and the browser's GRAPH page are
  the SAME graph. Multi-user Supabase deployments are out of scope for this
  slice, exactly as they are for `scheduler.py`/`builds.py` today.
- **Test isolation idiom.** `apps/api/tests/conftest.py:75-88`
  `_isolate_ontology_db` is `autouse=True` and points
  `app.intel.ontology_local.override_db_path()` at a per-test temp file — any
  new test file under `apps/api/tests/` gets this for free, no explicit
  fixture use needed. `apps/api/tests/test_ontology_local.py:27-30` `_reg()`
  helper (`get_registry(UserCtx(user, ""), Settings(supabase_url=""))`) and
  line 163 (`await reg._links_touching([...])` to assert an edge exists) are
  the idioms to reuse.
- **Baseline measured this session** (branch `roadmap-first-users`, not the
  939 figure recorded in `CLAUDE.md` for an earlier branch point):
  `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q` →
  **1209 passed, 1 skipped**. This is the number the new guard test must not
  drop below; `CLAUDE.md`'s baseline line is stale for this branch and
  updating it is out of scope for this doc-only task.

## 3. Design

### A. New module `apps/api/app/intel/promotion.py`

```python
"""Auto-promotion — incidents flow into the ontology graph (W4 slice 1).

Turns incidents.brief()'s deterministic convergences into `incident:<id>`
ontology objects: sourced assertions (assert_props — merge, never upsert)
plus `evidence_of` reason links from each translatable member entity to the
incident. No new background loop; called from watch_officer.run_once().
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

from app.intel.incident_store import incident_key
from app.intel.ontology import Link
from app.intel.ontology_local import SqliteRegistry

log = logging.getLogger("app.intel.promotion")

# Firehose guard (CLAUDE.md "every mint carries a reason link", roadmap Phase 2
# "a promotion pipeline, not a firehose"). incidents.brief() itself caps at 25
# incidents (incidents.py _MAX_INCIDENTS); this is a stricter per-cycle ontology-
# write budget, deliberately well under that. Hardcoded — no config.py setting
# this slice (see §E).
MAX_INCIDENT_MINTS_PER_CYCLE = 10

# Evidence ref keys that translate to a canonical Velocity ontology id.
# gps-jamming cells, quakes, spoofing findings, GDELT/EONET/ACLED events, and
# alert-bus-sourced signals (ref={"alert_id","rule"}) carry NO translatable
# entity id — see docs/ontology-autopopulation-plan.md §2 for the verified
# per-domain ref shapes.


def _entity_id_from_evidence(ev: dict[str, Any]) -> str | None:
    ref = ev.get("ref") or {}
    icao24 = ref.get("icao24")
    if icao24:
        return f"aircraft:{icao24}"
    mmsi = ref.get("mmsi")
    if mmsi:
        return f"vessel:{mmsi}"
    return None


def _stable_incident_id(incident: dict[str, Any]) -> str:
    """Deterministic incident:<id> so re-running UPDATES the same object.

    incidents.py's own inc["id"] (uuid4 hex) is fresh every brief() call —
    NOT usable (see plan §2). incident_store.incident_key() (0.5° centroid
    grid + sorted domain set) is the already-computed stable identity for
    "same real-world convergence" and is what watch_officer._BRIEFS is
    already keyed by.
    """
    key = incident_key(incident)
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    return f"incident:{digest}"


async def promote_incident(
    reg: SqliteRegistry, incident: dict[str, Any], *, source: str
) -> str | None:
    """Mint/update one incident object + evidence_of links.

    Returns the object id, or None if the incident has zero translatable
    evidence members — an incident:<id> object with no reason link is the
    exact firehose junk CLAUDE.md's "every mint carries a reason link" rule
    forbids, so we skip the mint entirely rather than create an orphan.
    """
    evidence = incident.get("evidence") or []
    member_ids = sorted(
        {mid for ev in evidence if (mid := _entity_id_from_evidence(ev))}
    )
    if not member_ids:
        return None

    incident_id = _stable_incident_id(incident)
    key = incident_key(incident)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    await reg.assert_props(
        incident_id,
        {
            "threat_level": incident.get("threat_level"),
            "score": incident.get("score"),
            "domains": incident.get("domains"),
            "narrative": incident.get("narrative"),
            "centroid": incident.get("centroid"),
        },
        source=source,
        observed_at=now,
        derivation={"incident_key": key, "brief_id": incident.get("id")},
    )
    for mid in member_ids:
        # Canonical direction per ontology.py KNOWN_RELS docstring
        # ("signal/track → incident it supports") — member entity →
        # incident, NOT actions.py._handle_promote_incident's inverted edge
        # (see plan §2 for the discovered inconsistency).
        await reg.link(Link(src=mid, dst=incident_id, rel="evidence_of", source=source))
    return incident_id


async def promote_incidents(
    reg: SqliteRegistry, incidents: list[dict[str, Any]], *, source: str
) -> list[str]:
    """Promote up to MAX_INCIDENT_MINTS_PER_CYCLE incidents (best-first order
    — incidents.brief() already sorts by threat_level/score descending, so
    capping the front of the list keeps the most actionable ones). Logs, does
    not silently drop, whatever it declines to process.
    """
    minted: list[str] = []
    budget = MAX_INCIDENT_MINTS_PER_CYCLE
    dropped = incidents[budget:]
    for inc in incidents[:budget]:
        oid = await promote_incident(reg, inc, source=source)
        if oid:
            minted.append(oid)
    if dropped:
        log.info(
            "promotion: per-cycle cap (%d) hit, dropped %d incident(s) this cycle",
            budget, len(dropped),
        )
    return minted
```

Notes on this design:
- `reg` is typed as the concrete `SqliteRegistry` (`ontology.py:392`'s
  `get_registry` return type), not a protocol — none exists yet
  (`roadmap-ontology-2026-07.md` Phase 1 mentions extracting one; it hasn't
  happened). Matches how every other call site types it.
- `promote_incident` is idempotent by construction: same `incident_key` →
  same `incident_id`; `assert_props` dedups identical `(value, source)` pairs
  (`ontology_local.py:522-536 _insert_assertion_sync`) so a steady incident
  re-processed every cycle adds **zero** new assertion rows once its props
  stop changing, and `reg.link`'s `UNIQUE(user_id, src, dst, rel)` upsert
  (`ontology_local.py:307-362`) makes re-linking a no-op update, not a
  duplicate row.
- The per-cycle cap is enforced in the **caller wrapper**
  (`promote_incidents`), not in `promote_incident` itself, and not in
  `ontology_local.py` — no batch verb or count method is added to the
  registry this slice (§E).

### B. The one wiring change — `apps/api/app/intel/watch_officer.py`

Insertion point: inside `run_once()`, after the existing diff line (currently
line 104: `diff = incident_store.record(_SCOPE, incs)`), before the
new/escalated brief-filing loop (currently starts line 107). `incs` (line
102: `incs = br.get("incidents") or []`) is already the best-first-sorted,
already-fetched incident list — reuse it, don't re-fetch.

Imports to add at the top (currently lines 17-24):
```python
from app.config import get_settings
from app.intel import promotion
from app.intel.ontology import get_registry
from app.keys import UserCtx
```

Module constant, mirroring `scheduler.py:29` / `builds.py:21` verbatim:
```python
# Same shared local identity Foundry's build-runner / workflow scheduler
# default to (keys.py:172's keyless fallback) — this loop runs headless, with
# no request/caller ctx. See docs/ontology-autopopulation-plan.md §2.
_LOCAL_CTX = UserCtx(user_id="local", token="")
```

The one added call inside `run_once()`, isolated exactly like the existing
`brief()` call (line 96-100) and `_playbook()` call (line 63) already are —
a promotion bug must not sink the loop that files briefs:
```python
    actionable = [i for i in incs if i.get("threat_level") in _ACTIONABLE]
    try:
        reg = get_registry(_LOCAL_CTX, get_settings())
        minted = await promotion.promote_incidents(
            reg, actionable, source="agent:watch_officer"
        )
        if minted:
            log.debug("watch_officer: promoted %d incident object(s)", len(minted))
    except Exception as exc:  # noqa: BLE001 — a promotion bug must not sink the loop
        log.debug("watch_officer: promotion failed: %s", exc)
```

`source="agent:watch_officer"` is not an invented string — it's the exact
example already listed in `roadmap-ontology-2026-07.md`'s assertions-table
spec: `source TEXT NOT NULL, -- feed:adsb | detector:ais_gap | analyst |
agent:watch_officer | osint:whois`.

This promotes ALL actionable incidents every cycle (threat_level in
`_ACTIONABLE = {"high", "elevated"}`, the same set the existing brief-filing
loop already filters on, line 31), not just `diff`'s new/escalated — a
steady high-severity incident should keep its ontology object current
(fresh `observed_at`, corroborating assertions if a source repeats a
changed value) even on cycles where no NEW brief is filed. Because
`assert_props` dedups and `link` upserts, this costs nothing extra in steady
state — it's a re-assert of the same values, is a no-op DB-wise, so is a
correctness improvement rather than causing repeated writes.

One added call, one new import block, one module constant — the rest of
`run_once()`, `_playbook()`, `_make_brief()`, `_BRIEFS`, `start()`/`stop()`
are untouched.

### C. Guard test `apps/api/tests/test_promotion.py`

Reuse the `_reg()` / `Settings(supabase_url="")` idiom from
`test_ontology_local.py:24-30`; the autouse `_isolate_ontology_db` fixture
(`conftest.py:75-88`) needs no explicit invocation. Cases:

1. **Build a fake incident dict** with `threat_level="high"`, `domains=
   ["air-emergency", "dark-vessel"]`, a `centroid`, a `narrative`, a `score`,
   and `evidence=[{"domain": "air-emergency", "ref": {"icao24": "4ca7b3",
   "squawk": "7700"}, ...}, {"domain": "dark-vessel", "ref": {"mmsi":
   "636092000", ...}, ...}]` — ≥2 translatable members.
2. **Call `promotion.promote_incident(reg, incident, source="agent:watch_officer")`.**
   Assert it returns a non-`None` `incident:<id>` string.
3. **The object exists**: `await reg.get(incident_id)` is not `None`, `kind
   == "incident"`.
4. **≥1 assertion carries the passed source**, not the generic `"analyst"`
   default: `rows = await reg.get_assertions(incident_id)`; assert
   `any(r.source == "agent:watch_officer" for r in rows)`.
5. **≥1 `evidence_of` link exists from a translated member to the incident**:
   `links = await reg._links_touching(["aircraft:4ca7b3"])`; assert one has
   `.src == "aircraft:4ca7b3"`, `.dst == incident_id`, `.rel ==
   "evidence_of"` (direction per §3.A — NOT `actions.py`'s inverted
   convention; a regression here silently flips which node is "evidence for"
   which, so assert the direction explicitly, not just link existence).
6. **Determinism / no duplication**: call `promote_incident` a second time
   with the same incident dict (same `centroid`/`domains` → same
   `incident_key`/`incident_id`). Assert the returned id is identical (no
   new `incident:*` row minted — `len(await reg.list_by_kind(...))` or a
   direct count query stays the same), and `get_assertions` for a prop whose
   value didn't change gains no new row (`_insert_assertion_sync`'s
   `(value, source)` dedup — `ontology_local.py:522-536`).
7. **Per-cycle cap drops extras, and logs the drop, not silently**: build
   `MAX_INCIDENT_MINTS_PER_CYCLE + 3` distinct fake incidents (distinct
   centroids so each has a distinct `incident_key`/id and ≥1 translatable
   member each), each with a distinct `score`/`threat_level` so best-first
   order is unambiguous. Call `promotion.promote_incidents(reg, incidents,
   source=...)`. Assert `len(result) == MAX_INCIDENT_MINTS_PER_CYCLE`. Since
   `brief()` already returns incidents best-first (sorted by threat_level/
   score descending) and the cap slices `incidents[:budget]`, also assert
   WHICH incidents survive: the minted ids correspond to the highest-ranked
   leading slice of the input list, and the dropped tail is specifically the
   lowest-threat 3 — not merely that the count is right. Use `caplog` at
   `INFO` on logger `"app.intel.promotion"` and assert a record mentioning
   the dropped count is present (not just that fewer than input were minted
   — the log line itself must exist, per the "no silent truncation"
   requirement).
8. **An incident with zero translatable evidence is skipped, not minted with
   an orphan object**: an incident whose `evidence` is entirely
   `{"domain": "quake", "ref": {"mag": 6.1}}` → `promote_incident` returns
   `None`, and no `incident:*` row for its `incident_key` exists.
9. **All keyless**: no Supabase config anywhere in the test (`Settings(
   supabase_url="")`, matching every other test in the file this mirrors).

Existing tests that must stay green: **the whole of
`test_ontology_local.py`** (it is the guard for the `assert_props`/`upsert`
provenance contract this module depends on and must not regress), plus the
full suite — `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api
-q` at or above the 1209-passed/1-skipped baseline measured in §2.

### D. Explicitly deferred to slice 2 (named, not dropped)

- **Global object-count budget (1,000-5,000 band) + prune/tombstone pass**
  (`roadmap-ontology-2026-07.md` Phase 2's "Minting budget… Pruning: objects
  with zero analyst interaction… compacted to a tombstone summary"). This
  slice's `MAX_INCIDENT_MINTS_PER_CYCLE` is a per-cycle write-rate guard
  only, not a store-wide count/prune mechanism. The two existing store caps
  prune assertions/bytes only, never object rows (ontology_local.py:554 caps
  assertions-per-object; :573 drops oldest assertions + VACUUM on byte
  overflow), so incident-object count grows monotonically — realistically
  tens–low-hundreds of distinct incident_keys/day after dedup (theoretical
  ceiling 720 cycles × 10 = 7,200 mint-calls/day, but bounded to distinct
  keys). Acceptable for the keyless-boot/demo scenario this slice targets; a
  long-running instance will exceed the 1–5k band until slice 2's
  object-count prune lands.
- **Detector-bus hook** (`bus.on_publish`, `apps/api/app/correlate/bus.py:42`
  — real, verified this session) and **standing-watch link**
  (`apps/api/app/intel/watch.py:537-566 _persist_firing`, `apps/api/app/
  intel/watch.py:585 reg = get_registry(ctx, s)` — already writes
  `source=f"rule:watchbox:{rule.get('id')}"` assertions per firing, a second,
  independent precedent for the ontology-write pattern). Wiring either into
  auto-promotion is slice 2, not this one; `watch.py` is not touched here
  (W3's hot file, per the task's out-of-scope list).
- **Dossier/POL enrichment as assertions** (`intel/dossier.py`, `app/osint/`
  outputs routed into `assert_props` instead of ad-hoc payloads —
  `roadmap-ontology-2026-07.md` Phase 2).
- **History/incident-store BACKFILL job** — a one-shot walk over
  `history.db` + `incident_store`'s snapshot history to mint the graph the
  platform "should have had" from day one (`roadmap-ontology-2026-07.md`
  Phase 2). This slice only mints going forward from the next watch-officer
  cycle after deploy.
- **`/api/ontology/schema` work** — Phase 3 (Ontology Home), explicitly not
  pulled forward per `roadmap-users-2026-07.md` §4's disposition table.

### E. Out of scope / do not touch

- `apps/api/app/intel/watch.py` — W3's hot file; untouched.
- `apps/api/app/intel/ontology_local.py` — no batch verb, no count method
  added this slice; the per-cycle cap lives entirely in `promotion.py`.
- `apps/api/app/main.py` — no new background loop/task registration; this
  rides inside the existing `watch_officer._run_forever()` 120 s cycle
  (`watch_officer.py:160-168`).
- `apps/api/app/config.py` — no new `Settings` field; the cap is the
  hardcoded `promotion.MAX_INCIDENT_MINTS_PER_CYCLE` module constant.
- `apps/api/app/intel/actions.py` — the direction inconsistency in
  `_handle_promote_incident` (§2) is named, not fixed, in this slice.
- Any guarded live-path/globe file (`styles.ts`, `PollGeoJsonAdapter`,
  `tracks.ts`, viewer opts, `apiFetch`/`withWsKey`) — this slice is
  backend-only, no frontend change.

### F. Slice check / acceptance

- **Offline (proven by the guard test, §C):** `promote_incident`/
  `promote_incidents` mint a deterministic `incident:<id>` object with a
  `source="agent:watch_officer"` assertion and a correctly-directed
  `evidence_of` link from each translatable member, re-runs update rather
  than duplicate, and the per-cycle cap drops-and-logs rather than
  silently truncating — all on a keyless (`Settings(supabase_url="")`)
  in-process `SqliteRegistry`, no live feeds needed.
- **Runtime acceptance (plumbed-unverified until exercised live):** boot the
  keyless backend (`bash scripts/run-api.sh`, repo root), let the
  watch-officer loop run a couple of 120 s cycles with at least one live
  actionable incident present (needs real cross-domain convergence —
  e.g. a live GPS-jamming+dark-vessel cluster or an emergency squawk — which
  is not guaranteed to exist at any given moment; this is a **probe**, not a
  deterministic live test). Verify: `curl -s localhost:8000/api/ontology/
  search-around/incident:<id>` (or the GRAPH page) shows the incident object
  with ≥1 assertion and ≥1 `evidence_of` link. This runtime check is honestly
  **not exercised as part of this spec** — it requires a live incident to
  exist during the observation window, which the implementer must probe for
  separately, not assume.
- `bash scripts/verify.sh` green (typecheck unaffected — backend-only change;
  `pnpm -r typecheck` should be a no-op here, but the full script is still
  the contract).

## 4. Final file list for the implementer

| File | Change |
|---|---|
| `apps/api/app/intel/promotion.py` | **New.** `promote_incident`, `promote_incidents`, `_entity_id_from_evidence`, `_stable_incident_id`, `MAX_INCIDENT_MINTS_PER_CYCLE`. |
| `apps/api/app/intel/watch_officer.py` | **Edit.** Add 4 imports, one `_LOCAL_CTX` module constant, one isolated `try/except` block inside `run_once()` after the existing `diff = incident_store.record(...)` line. No other line touched. |
| `apps/api/tests/test_promotion.py` | **New.** Guard test per §C, reusing `test_ontology_local.py`'s `_reg()`/`Settings(supabase_url="")` idiom and the autouse `_isolate_ontology_db` fixture. |

No changes to `apps/api/app/intel/ontology.py`, `ontology_local.py`,
`actions.py`, `watch.py`, `main.py`, `config.py`, or any frontend file.
