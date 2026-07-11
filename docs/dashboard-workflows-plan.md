# Dashboard overhaul: grouped tabs, Workflows app, deeper Foundry, 3D city

Branch `dashboard-workflows-overhaul`. Scope: restructure top-level navigation
into grouped tabs, add a **Workflows** app (user-authored analysis pipelines
with real Python blocks over live platform data), deepen **Foundry** past
list-views (dataset-aware views, SQL console, actionable monitors that can call
the LLM), and add a keyless **City 3D** gaussian-splat view. Everything reuses
the existing substrate; integration points below were read from source this
session.

## 0. Verified integration points (ground truth)

Frontend shell:
- Tab ids/labels: `apps/web/src/state/appView.ts` — `AppId` union (L12), `APP_IDS`
  (L22), `APP_META` (L36, has `label/hint/chrome`). Switch store `useAppView`
  (L82), persisted to `velocity.appView` + `?app=`.
- Tab strip: `apps/web/src/shell/AppSwitcher.tsx` (flat map over APP_IDS).
- Content dispatch: `apps/web/src/shell/AppSurface.tsx` (switch on app id;
  `map`/`sim` render null = globe).
- `chrome: 'full'` collapses right rail + timeline via `App.tsx:233`.

Foundry backend (all in `apps/api/app/foundry/` + `apps/api/app/routes/foundry.py`):
- `FoundryStore` (`store.py:178`), SQLite `./data/foundry.db`, WAL, fresh
  connection per op; tables datasets/versions/rows/transforms/builds/
  dead_letter/schedules/bindings/checks/check_results. Caps: 200k rows, 25MB,
  keep 5 versions.
- DSL executor: `run_steps(steps, base_rows, provider, quarantine=None)`
  (`transforms.py:800`); safe expression AST (`compile_expr` L357,
  `eval_expr` L475). 13 step types.
- Builds: `run_transform_build` (`builds.py:111`), `run_pipeline_build`
  (`builds.py:230`); scheduler `apps/api/app/foundry/scheduler.py` (5 s tick).
- Ontology binding: `sync_binding` (`binding.py:71`) → `get_registry().upsert`
  (`binding.py:119`), `auto_sync_dataset` (`binding.py:139`).
- Ingest: `parse_upload(filename, content)` (`ingest.py:214`),
  `add_version` (`store.py:386`).

LLM / alerts / ontology:
- LLM ladder: `apps/api/app/llm.py` — `chat_json(messages, *, tier="fast", ...)
  -> tuple[Any|None, LlmResult]` (L792); tiers `fast|reason`; backends
  minimax→deepseek→ollama, local-first toggle `/api/ai/local`.
- Tool-loop precedent: `apps/api/app/intel/agent.py` `run_agent` (L646),
  system prompts `_SYS` (L517).
- Alert bus: `apps/api/app/correlate/bus.py` — `bus.publish(Alert)` (L56),
  `subscribe()` (L34); `Alert` dataclass `correlate/types.py:24`
  (severity/lon/lat/title/detail). Surfaced at `GET /api/alerts`, `WS /ws/alerts`.
- Ontology store: `apps/api/app/intel/ontology_local.py` `SqliteRegistry`
  (objects/assertions/links); entry `get_registry(ctx)` (`intel/ontology.py:392`).
  Keyless auth dep: `current_user_or_local`.
- Live feeds in-process: aircraft `global_snapshot()` (adsb module — internal
  consumers call this, never the route), AIS union, quakes, news stores.

Python-subprocess precedent: `apps/api/app/imagery/detect.py:_run_yolo` (L77) —
one-shot `asyncio.create_subprocess_exec`, JSON on stdin, JSON lines on stdout,
timeout, graceful None on failure.

Splats: Cesium 1.141 (installed) exports `GaussianSplat3DTileContent` /
`GaussianSplatPrimitive` (unused). THREE.js viewers exist: Spark `SplatMesh` in
`apps/web/src/studio/StudioPage.tsx:353` (`SplatView({url, cam})`), loading
`/api/recon/jobs/{id}/result.spz|.ply`; recon pipelines in
`apps/api/app/routes/recon.py` (`POST /api/recon/jobs`, `/api/recon/sat`, SSE
events, result.ply/.spz). `apps/web/src/lod1/lod1Layer.ts` = keyless LoD1
building extrusions.

No SQL query surface exists today (verified: no DuckDB, no user SQL endpoint).

## 1. Grouped top tabs (+ two new apps)

`appView.ts`:
- Add `'workflows' | 'city'` to `AppId`, `APP_IDS`, `APP_META`
  (workflows: label "Workflows", chrome 'full'; city: label "City 3D",
  chrome 'full').
- Add `group` field to `APP_META` entries and export `APP_GROUPS: readonly
  { id: string; label: string; apps: AppId[] }[]`:
  - LIVE: map, sim
  - ANALYZE: explorer, graph, targeting, video
  - DATA: foundry, workflows
  - PRODUCT: reports
  - 3D: city
- `AppSwitcher.tsx`: render groups as labeled clusters (small uppercase group
  caption above/left of each cluster, thin divider between groups). Keep the
  same click/active-underline behavior. Do not regress keyboard/mouse behavior.
- `AppSurface.tsx`: `case 'workflows'` → `<WorkflowsApp />`; `case 'city'` →
  `<CityApp />`.
- `invariants.test.ts` untouched; add a small unit test asserting every AppId
  appears in exactly one group.

## 2. Workflows app — user-programmable analysis pipelines

Palantir-pipeline-grade: a DAG of typed blocks over live platform data, with
three power blocks (Python, SQL, LLM) and sinks that act (alerts, ontology,
datasets, memory). Single-operator local tool: the Python block runs the
operator's own code on their own box in a resource-limited subprocess — that is
BYO-compute, not a hostile-tenant sandbox; documented as such.

### Backend `apps/api/app/workflows/` + `apps/api/app/routes/workflows.py`

`store.py` — mirror FoundryStore exactly (WAL, fresh conn per op,
`override_db_path` test hook), path `./data/workflows.db` (new
`workflows_db_path` in config.py):
- `workflows(id, name, description, spec_json, enabled, created_at, updated_at)`
  — spec = `{blocks: [{id, type, config}], edges: [{from, to}]}` (multi-input
  blocks like join take ordered inputs).
- `runs(id, workflow_id, status queued|running|succeeded|failed, started_at,
  finished_at, trigger manual|schedule, log TEXT, error, output_json)` — log is
  append-only lines `[block_id] rows_in→rows_out in Xms`; output_json holds the
  terminal blocks' row samples (cap 200 rows/block).
- `wf_memory(workflow_id, key, value_json, updated_at, PRIMARY KEY(workflow_id,key))`
  — persistent per-workflow memory for cross-run state (dedup, baselines).
- `schedules(id, workflow_id, interval_s, enabled, last_run, last_error)` —
  run via a scheduler mirroring `foundry/scheduler.py`.

`blocks.py` — block registry. Each block: `type`, `category`, `title`,
`config_schema` (JSON-ish field list the FE renders), and async
`run(config, inputs: list[list[dict]], ctx: BlockCtx) -> list[dict]`.
`BlockCtx` carries user ctx, run logger, workflow memory get/set, row caps.
Catalog (17 blocks — enough to "do most of the stuff"):
- Sources (0 inputs): `source.aircraft` (global_snapshot → rows w/ icao24,
  callsign, lat, lon, alt, speed, track, mil flag…, optional bbox config),
  `source.vessels` (AIS union rows, optional bbox), `source.countries`
  (OSINT World Series catalog rows), `source.dataset` (foundry rows by
  dataset id, latest version), `source.ontology` (objects by kind → id/kind/
  flattened props), `source.alerts` (recent bus buffer), `source.quakes`
  (USGS store).
- Transforms (1-2 inputs): `op.steps` (config = foundry DSL step list; execute
  via `foundry.transforms.run_steps` — full reuse: filter/derive/join/
  aggregate/sort/limit/dedup/select/rename/cast), `op.geo` (mode
  within_bbox|within_radius|near_join: lat/lon col config; near_join takes 2
  inputs and joins rows within N km — haversine), `op.country` (point→ISO
  country via the countries catalog polygons/bboxes; adds `country` col),
  `op.python`, `op.sql`, `op.llm` (below).
- Sinks (1 input, pass rows through): `sink.alert` (publish per-row or
  summary Alert to bus, config severity/title template + max 20/run),
  `sink.ontology` (upsert objects `workflow:{wf_id}:{key}` — reuse binding
  pattern via get_registry().upsert), `sink.dataset` (write rows as new
  version of a named foundry dataset via add_version), `sink.memory`
  (write value to wf_memory key).

Power blocks:
- `op.python` (`python_exec.py`): config `{code: str, timeout_s<=60}`. Contract
  shown in the FE editor: the script defines `def run(rows: list[dict],
  memory: dict) -> list[dict] | {"rows": [...], "memory": {...}}`. Execution:
  `asyncio.create_subprocess_exec(sys.executable, runner_path)` — runner is a
  static file `apps/api/app/workflows/py_runner.py` that reads one JSON doc
  {code, rows, memory} on stdin, applies `resource.setrlimit` (CPU 30 s,
  AS 1 GiB, NOFILE 64), execs the code in a fresh module namespace, calls
  `run`, prints one JSON doc {ok, rows, memory, stderr} on stdout. Parent
  enforces wall timeout (kill), 5 MB stdout cap, rows in/out cap 50k.
  Failure → block error in run log, run status failed (never a 500).
- `op.sql` (`sql_exec.py`): config `{query: str}`. Load the block's input rows
  into an in-memory sqlite3 table `t` (t2 for a second input), run the query
  read-only (`PRAGMA query_only=ON`, single statement, must start with
  SELECT/WITH), rows out = fetchall as dicts. 10 s interrupt via
  `conn.interrupt` timer. This is the general SQL surface.
- `op.llm`: config `{tier: fast|reason, system: str, prompt: str, mode:
  per_batch|per_row(max 50), json_mode: bool}`. `prompt` is a template with
  `{rows}` (JSON, capped 100 rows/20 KB) and `{memory}`. Calls
  `llm.chat_json`/`chat`. Output: per_batch → one row `{result...}`; per_row →
  input row + `llm` column. Degrade to error row on LLM failure, never crash
  the run.

`engine.py`: `run_workflow(store, workflow, ctx, trigger) -> run` — validate
DAG (cycle check like foundry `would_cycle`), topo order, execute blocks,
per-block timing/row counts into run log, memory snapshot loaded once and
persisted at end, total wall budget 5 min, row cap 200k between blocks.

Routes (keyless `current_user_or_local`, mounted in main.py like foundry):
- `GET/POST /api/workflows`, `GET/PUT/DELETE /api/workflows/{id}`
- `GET /api/workflows/blocks` — catalog (types + config schemas + docs)
- `POST /api/workflows/{id}/run` — execute now (await, return run)
- `POST /api/workflows/preview` — run an UNSAVED spec capped small (first 500
  rows per source) for the editor
- `GET /api/workflows/{id}/runs`, `GET /api/workflows/runs/{run_id}`
- `GET/POST/PUT/DELETE /api/workflows/schedules...` mirror foundry
- `GET/PUT /api/workflows/{id}/memory` — inspect/reset memory
Scheduler started in main.py lifespan behind OSINT_DISABLE_BACKGROUND, mirroring
foundry's.

Tests `apps/api/tests/test_workflows.py`: store CRUD; engine topo+cycle; steps
block reusing foundry DSL; geo block; sql block (SELECT ok, INSERT rejected,
timeout); python block (echo script, memory round-trip, timeout kill, crash →
failed run not 500); llm block with `llm.chat_json` monkeypatched; sinks
(alert→bus ring, dataset→foundry version, memory persistence); routes smoke via
TestClient.

### Frontend `apps/web/src/workflows/` + `apps/web/src/state/workflows.ts`

Mirror the foundry FE architecture (nav zustand store w/ URL params `wv/wid`,
`useFoundryPoll`-style polling, `ui.tsx` primitives reused via import from
foundry or small local copies):
- `WorkflowsApp.tsx`: left rail — Workflows | Runs | Blocks (docs).
- `EditorView.tsx`: DAG canvas (reuse PipelineView's pan/zoom SVG pattern);
  block palette grouped Sources/Transforms/Power/Sinks; click block → right
  config panel with schema-driven fields; `op.python` and `op.sql` get a
  monospace code textarea (tab-key inserts spaces, no external editor dep) with
  the `run(rows, memory)` contract shown; `op.llm` gets tier select + system
  prompt + prompt template textareas. Preview button → `POST /preview`
  showing per-block row counts + sample rows of the selected block. Save, Run.
- `RunsView.tsx`: run history, expandable log + output sample table.
- `BlocksView.tsx`: rendered catalog docs (what each block does, config,
  Python/SQL contracts) — the "coding method" reference.
- Vitest: nav store + one render test of the palette from a mocked catalog.

## 3. Foundry deepening — from lists to a workbench

Backend additions (routes in `routes/foundry.py`, logic in `app/foundry/`):
- `GET /api/foundry/datasets/{id}/geo` — auto-detect lat/lon columns (name
  heuristics + numeric range check), return `{lat_col, lon_col, features:
  GeoJSON FeatureCollection}` capped 5k points. 404-shaped `{ok:false}` if no
  geo columns.
- `POST /api/foundry/sql` — `{dataset_ids: [..], query}` → load latest-version
  rows of each dataset into in-memory sqlite tables named by slugified dataset
  name, SELECT/WITH-only, same guard as `op.sql` (share `sql_exec.py` from
  workflows — put it in `app/foundry/sqlrun.py` and have workflows import it,
  foundry owns it).
- Monitors (`monitors.py` + store tables `monitors`, `monitor_events`):
  monitor = `{id, dataset_id, trigger: build_failed|check_failed|row_condition|
  new_version, condition_expr (safe DSL expr for row_condition), action:
  alert|llm|both, llm_tier, llm_system, llm_prompt, severity, enabled}`.
  Evaluated after add_version / builds (hook where auto_sync_dataset runs) and
  from the foundry scheduler tick. Actions: publish bus Alert
  (`rule_id="foundry:monitor:{id}"`); llm → `chat_json` over up to 50
  matching/context rows with the configured system prompt, result stored in
  `monitor_events(id, monitor_id, at, kind, summary, detail_json)` and included
  in the Alert detail. Routes: CRUD `/api/foundry/monitors`,
  `GET /api/foundry/monitors/{id}/events`.
- Tests: geo detection, sql guard, monitor row_condition + llm action with
  chat_json monkeypatched, events recorded, alert published to bus ring.

Frontend:
- DatasetDetail gains tabs `map` (maplibre-gl already in deps? verify — else
  lightweight SVG equirect plot of /geo points; whichever, plus "View on
  globe" button that upserts a temporary CustomDataSource via the captures
  pattern only if trivially wireable — else skip, name the skip), `sql`
  (console: textarea + run + result table + row count, per-dataset preloaded
  `SELECT * FROM {table} LIMIT 50`), `monitors` (rule builder + events feed).
- HomeView: replace bare stat tiles with: pipeline health strip, latest
  monitor events feed, per-dataset freshness sparkline (from versions), quick
  SQL entry.
- Keep every existing view/test green; nav DetailTab union extends
  `map|sql|monitors`.

## 4. City 3D (keyless gaussian splats)

New app `apps/web/src/city/CityApp.tsx` (full chrome):
- Reuse the Spark `SplatView` — extract it from `StudioPage.tsx` into
  `apps/web/src/studio/SplatView.tsx` and import from both (do NOT duplicate).
- Scene sources (all keyless): (a) recon job results — list via existing
  `GET /api/recon/jobs`, load `result.spz|ply`; (b) local file open
  (`.ply/.splat/.spz/.ksplat` via file input + object URL); (c) URL paste;
  (d) "Build from satellite AOI" launcher deep-linking the existing
  `/studio?lat=&lon=&radius=` flow (uses wired CDSE creds, no user key).
- Left: scene list/launcher; center: SplatView with orbit controls + fps stat;
  right: scene info (splat count, source).
- Do NOT touch GlobeCanvas or attempt Cesium GaussianSplatPrimitive in this
  wave (available in 1.141, noted as follow-up) — zero risk to globe invariants.

## 5. Skipped deliberately (named)

- Cesium in-globe splat tiles (GaussianSplat3DTileContent) — follow-up.
- Workflow webhooks/email actions; per-row LLM > 50 rows; multi-tenant
  sandboxing of op.python (single-operator machine by design).
- Foundry dataset map → live globe layer auto-sync (button-jump only unless
  trivial).
- Drag-to-connect edge UX polish beyond PipelineView parity.

## 6. Verification

- `bash scripts/verify.sh` green; pytest ≥ inherited baseline (measured this
  session before work started); `pnpm -r typecheck` green at every commit.
- Live: boot API+Vite; create a workflow (source.aircraft → op.sql "SELECT
  country, COUNT(*)..." wait aircraft rows have no country — use op.steps
  filter alt>10000 → op.python dedup via memory → sink.alert) and run it;
  observe the alert in the Alerts rail. Foundry: upload CSV with lat/lon →
  map tab renders points; SQL tab query returns rows; monitor with
  row_condition fires an LLM event (local ollama or ladder). City: load a
  recon .ply → splats render.
