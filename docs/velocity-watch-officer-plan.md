# Watch-Officer Agent — implementation spec

## Context

The platform senses far more than the operator can manually correlate. Detectors
(`intel/detectors.py`), cross-domain fusion (`intel/incidents.py`), and tip-and-cue
(`intel/cue.py`) already exist, but the operator still watches the map and runs
playbooks by hand. The watch-officer is a standing background loop that turns the
existing fusion output into finished, cited draft briefs and queues them in the
Inbox for operator triage (dismiss / acknowledge) — no operator labor to produce them.

First build target of the 2026-07 roadmap (`~/.claude/plans/if-you-need-to-mellow-pebble.md`).

## What already exists (verified this session, file:line)

- `incidents.brief(bbox=None, ...)` → `{incidents: [{id, threat_level, score, domains,
  centroid:{lon,lat}, narrative, evidence:[{domain,severity,summary,lon,lat,ref,kind,basis?}],
  follow_up:[...], signal_count, span_km, emitter_estimate}], top_threat_level, ...}`
  (`intel/incidents.py:379`). Already narrates + cites; convergence rule = ≥2 domains
  OR a lone high/critical signal.
- `incident_store` singleton + `record(scope, incidents)` → diff `{new, escalated,
  deescalated, resolved, ...}` of summaries keyed by stable `incident_key`
  (0.5° grid + domain set) (`intel/incident_store.py:51`).
- `cue.run(lon, lat)` → `{status, aoi, ...}` tasks SAR on a point (`intel/cue.py:38`).
- Background-task idiom: module `_TASK`/`_STARTED` + `start()`/`stop()` + `_run_forever()`
  with `asyncio.sleep(cycle)`, registered in `main.py` lifespan `if background:` block
  and torn down in `finally` (`intel/watch.py:663-705`, `main.py:243/313`).
- Inbox renders `useAlerts` items with slew-to + read/archive; empty-state copy already
  says "subscriptions post here when they fire" (`apps/web/src/inbox/InboxPanel.tsx`).
- `/api/alerts` is keyless (no `current_user`) — matches a personal tool; avoids the
  Supabase-unset 401 trap (memory: standing-detections-level-not-edge).

## Design

### Backend — `apps/api/app/intel/watch_officer.py` (new)

In-memory brief store + loop. Single-process, restart drops open briefs (acceptable —
the loop re-derives them next cycle; same tradeoff as `_PROPOSALS`).

- `_BRIEFS: dict[str, dict]` keyed by `incident_key`; `_MAX_BRIEFS = 100` (drop oldest).
- Brief record: `{id, key, created, threat_level, domains, centroid, title, narrative,
  evidence, follow_up, playbook, status: "open"}`.
- `async def run_once() -> int`:
  1. `br = await incidents.brief()` (global).
  2. `by_key = {incident_key(i): i for i in br["incidents"]}`.
  3. `diff = incident_store.record("watch-officer", br["incidents"])` (own scope — no
     collision with the geofence/intel_watch scopes).
  4. For each summary in `diff["new"] + diff["escalated"]` whose `threat_level` is
     `high`/`elevated` and whose key is not already an open brief: pull the full incident
     from `by_key`, run the playbook, store the brief.
  5. Return count of briefs created.
- Playbook (MVP = one, extensible): if `"dark-vessel"` in domains → `await cue.run(centroid)`
  and record `{sar: <status>}`. Other playbooks (POL pull, OSINT investigate) are
  follow-ups — the incident already carries `follow_up[]` for the operator meanwhile.
  <!-- ponytail: one playbook wired; brief() already narrates+cites, so no extra LLM call
       on the default path — add llm.chat(tier="reason") enrichment only if the canned
       narrative proves thin. -->
- `list_briefs()`, `dismiss(bid)`, `ack(bid)` (ack = mark acknowledged + drop; both remove
  from open set for a personal tool — ack is the "I saw it, keep the finding" vs dismiss
  "noise"; MVP stores neither long-term, both just clear).
- `start()`/`stop()`/`_run_forever()` mirroring `watch.py`; `_CYCLE_S = 120`.

### Routes — `apps/api/app/routes/watch_officer.py` (new), keyless

- `GET  /api/watch-officer/briefs` → `{briefs: [...]}` (open, newest first).
- `POST /api/watch-officer/briefs/{bid}/dismiss` → `{ok, id}` (404 if unknown).
- `POST /api/watch-officer/briefs/{bid}/ack` → `{ok, id}`.
- Register router in `main.py create_app()`.

### Lifespan — `main.py`

- `if background:` after `watch_eval.start()`: `from app.intel import watch_officer;
  await watch_officer.start()`.
- `finally` `if background:`: `await watch_officer.stop()`.

### Frontend

- `apps/web/src/state/watchOfficer.ts` (new): tiny `apiFetch` poller hook
  (`useWatchOfficerBriefs`) — GET every 30 s; `dismiss`/`ack` POST helpers.
- `InboxPanel.tsx`: add a "Watch Officer" section at the top rendering each brief —
  threat badge, title, narrative (line-clamp), top-2 evidence lines with `kind` tag,
  `follow_up` chips, slew-to centroid, Dismiss/Ack buttons.

## Verification

1. `cd apps/api && .venv/bin/pytest -q tests/test_watch_officer.py` — pure-logic test:
   monkeypatch `incidents.brief` to return one high incident + `cue.run` to a stub;
   `run_once()` creates 1 brief; second `run_once()` dedups (0 new); `dismiss` clears it.
2. `cd apps/api && .venv/bin/pytest -q` stays ≥25 passed.
3. `pnpm -r typecheck` green.
4. Live: boot `bash scripts/run-api.sh`, `GET /api/watch-officer/briefs` returns JSON;
   open the app, confirm the Watch Officer section renders (or is cleanly empty when no
   high incidents), Dismiss removes a brief.
