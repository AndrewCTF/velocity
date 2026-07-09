# Foundry layer — plan + frozen API contract (2026-07-08)

Goal: a full Foundry-style layer on Velocity — **users bring their own data**,
transform it through governed pipelines with lineage, bind it into the
existing ontology, and operate it from a real Foundry dashboard with
workflows/builds. Keyless-local first, same discipline as the rest of the
repo (SQLite store, guard tests, no new heavyweight deps).

Pillars (mirroring Foundry's architecture):

1. **Datasets** (Foundry: Data Connection + datasets) — upload CSV / JSON /
   NDJSON; schema inference; immutable versions (each upload or build = new
   version, like Foundry transactions); preview + per-column stats.
2. **Transforms / Pipeline** (Foundry: Pipeline Builder / code repos) —
   declarative step DSL (select, rename, filter, derive, join, aggregate,
   union, sort, limit) mapping input dataset(s) → output dataset. Lineage
   graph is derived from transform definitions.
3. **Builds + Workflows** (Foundry: builds/schedules) — run one transform or
   the whole downstream DAG topologically; build history with status, row
   counts, duration, error log; interval schedules (background task, disabled
   under `OSINT_DISABLE_BACKGROUND=1`).
4. **Ontology binding** (Foundry: ontology layer — the moat) — map a dataset
   to an object kind (key column → object id, columns → props); sync mints
   objects through the existing local ontology registry with
   `source='foundry:<dataset_id>'`, so BYO data lands in the same graph as
   the live world.
5. **Foundry dashboard** (Foundry: Workshop) — a FOUNDRY surface in the web
   app: home (stat cards + recent builds), Datasets browser (upload, preview
   table, schema, stats), Pipeline canvas (lineage DAG, SVG, no new deps),
   Builds view (history + run), Ontology sync view, transform editor.

## Storage — `data/foundry.db` (SQLite, WAL, same idiom as history.py)

```sql
CREATE TABLE datasets (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'raw',          -- raw | derived
  schema_json TEXT NOT NULL DEFAULT '[]',    -- [{name, type}] latest version
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE versions (
  id INTEGER PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id),
  version INTEGER NOT NULL, row_count INTEGER NOT NULL,
  source TEXT NOT NULL,                      -- upload | build:<build_id>
  schema_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(dataset_id, version));
CREATE TABLE rows (
  dataset_id TEXT NOT NULL, version INTEGER NOT NULL,
  idx INTEGER NOT NULL, data TEXT NOT NULL,  -- JSON object per row
  PRIMARY KEY(dataset_id, version, idx));
CREATE TABLE transforms (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '',
  inputs_json TEXT NOT NULL,                 -- [dataset_id, ...]
  output_dataset_id TEXT NOT NULL,
  steps_json TEXT NOT NULL,                  -- [step, ...] see DSL
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE builds (
  id TEXT PRIMARY KEY, transform_id TEXT,    -- null = full-pipeline build
  scope TEXT NOT NULL DEFAULT 'transform',   -- transform | pipeline
  status TEXT NOT NULL,                      -- running | succeeded | failed
  started_at TEXT NOT NULL, finished_at TEXT,
  rows_out INTEGER, error TEXT, log_json TEXT NOT NULL DEFAULT '[]',
  input_versions_json TEXT NOT NULL DEFAULT '{}');  -- {dataset_id: version}
CREATE TABLE schedules (
  id TEXT PRIMARY KEY, transform_id TEXT NOT NULL, interval_s INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, last_run TEXT, created_at TEXT NOT NULL);
CREATE TABLE bindings (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, object_kind TEXT NOT NULL,
  key_column TEXT NOT NULL, prop_map_json TEXT NOT NULL,  -- {column: prop}
  enabled INTEGER NOT NULL DEFAULT 1, last_sync TEXT,
  last_result_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE checks (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL, params_json TEXT NOT NULL,   -- row_count_min|max,
  severity TEXT NOT NULL DEFAULT 'warn',           -- not_null, unique,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);  -- column_exists
CREATE TABLE check_results (
  dataset_id TEXT NOT NULL, version INTEGER NOT NULL, check_id TEXT NOT NULL,
  passed INTEGER NOT NULL, detail TEXT, created_at TEXT NOT NULL);
```

`input_versions_json` is added by an idempotent `ALTER TABLE` guard
(`store._ensure_migrations`) for any `foundry.db` created before it existed —
`CREATE TABLE IF NOT EXISTS` alone never adds a column to an existing table.

Bounding: per-dataset row cap 200,000; keep last 5 versions per dataset
(older versions' rows deleted, version records kept); upload size cap 25 MB.

## Transform step DSL (`steps_json`)

Steps run in order over a list of dict rows. Types (`type` field):

- `{"type":"select","columns":[...]}`
- `{"type":"rename","map":{"old":"new"}}`
- `{"type":"filter","expr":"speed > 10 and country == 'DE'"}`
- `{"type":"derive","column":"kmh","expr":"speed * 1.852"}`
- `{"type":"join","right":"<dataset_id>","on":"col","right_on":"col","how":"left|inner"}`
- `{"type":"aggregate","group_by":["col"],"aggs":{"out":"count|sum:col|avg:col|min:col|max:col"}}`
- `{"type":"union","right":"<dataset_id>"}`
- `{"type":"sort","by":"col","desc":true}`
- `{"type":"limit","n":1000}`
- `{"type":"dedup","by":["col",...]}` — keep the first row of each distinct
  key; `by` omitted → dedup on the whole row (2026-07-09)
- `{"type":"cast","column":"c","to":"str|int|float|bool"}` — coerce a column
  in-place using the same information-preserving coercion as upload type-pinning;
  unconvertible → None, str never fails (2026-07-09)
- `{"type":"window","fn":"row_number|rank|lag:col|running_sum:col","into":"out",
  "partition_by":["col",...]?,"order_by":"col"?,"desc":false?}` — analytic
  window function per partition, ordered; output preserves input row order
  (2026-07-09)
- `{"type":"pivot","index":["col",...],"column":"c","value":"v",
  "agg":"sum|count|avg|min|max|first"}` — long→wide: one row per index tuple,
  one column per distinct value of `c` (2026-07-09)

Expression funcs added 2026-07-09: `regex_replace(value, pattern, repl)`.
Regex funcs are ReDoS-guarded: patterns >500 chars or with a nested-quantifier
shape (`(a+)+`) are rejected (return None/False/unchanged), and the input a
pattern runs against is capped at 100k chars — `re` has no timeout and steps run
in an executor thread where `signal.alarm` is unavailable.

**Row-level quarantine / dead-letter (2026-07-09):** a row whose `filter`/
`derive` expression RAISES (e.g. `'hello' - 5`) is routed to a dead-letter list
and dropped, instead of aborting the whole build for every row. `preview`
returns `quarantined` (count) + `quarantine_sample`; a build logs the count,
records `quarantined` on the build row, and persists the offending rows to the
`dead_letter` table (latest build only — a clean rebuild clears it).

Expressions: safe evaluator via Python `ast` whitelist (BoolOp, Compare,
BinOp +-*/%, UnaryOp, Name=column, constants, `and/or/not`, `in`, plus funcs
`len`, `lower`, `upper`, `str`, `int`, `float`, `round`, `abs`). NO eval().
Missing columns evaluate as None; comparison with None → False, arithmetic
with None → None.

## API contract — prefix `/api/foundry`, keyless (`current_user_or_local`)

All responses JSON. Errors: FastAPI HTTPException with `detail`.

- `GET  /summary` → `{datasets, total_rows, transforms, builds_24h,
  failed_builds_24h, objects_synced, recent_builds:[Build×10],
  checks_failing}` (`checks_failing` = count of enabled checks whose most
  recent recorded result has `passed=false`)
- `GET  /datasets` → `[Dataset]`  (Dataset = row + `latest_version`,
  `row_count`)
- `POST /datasets` `{name, description?}` → Dataset (empty, version 0)
- `GET  /datasets/{id}` → Dataset
- `DELETE /datasets/{id}` → `{ok:true}` (refuses if a transform depends on it
  → 409)
- `POST /datasets/upload` multipart: `file`, `name` (form), `description?`;
  also `POST /datasets/{id}/upload` (new version of existing) — optional form
  field `mode`: `snapshot` (default, replaces) or `append` (new version =
  latest version's rows + new rows, schema re-inferred over the union;
  `source='upload:append'`; 410 if the latest version's rows were pruned by
  retention). CSV (header row), JSON (array of objects), NDJSON. Type
  inference: int/float/bool/str — **non-lossy**: `int`/`float` are applied only
  when the string round-trips exactly, so leading-zero/`+`/underscore IDs
  ("007", MMSI) stay `str` (2026-07-09). Optional form field `types` (JSON
  `{column: "str|int|float|bool"}`) pins a column's type — force MMSI/ICAO24
  to `str`. `{id}/upload` also takes `cascade` (bool): after the new version,
  rebuild downstream stale transforms immediately (file-arrival sensor). →
  Dataset
- `POST /datasets/{id}/rollback` `{version:int}` → Version (creates a NEW
  latest version copying `version`'s rows/schema, `source='rollback:<n>'`;
  404 unknown dataset, 422 unknown version, 410 if pruned)
- `GET  /datasets/{id}/rows?version=&limit=50&offset=0` →
  `{schema:[{name,type}], rows:[{}], total, version}`
- `GET  /datasets/{id}/versions` → `[{version,row_count,source,created_at}]`
- `GET  /datasets/{id}/stats?version=` → `[{name,type,nulls,distinct,min,max}]`
- `GET  /datasets/{id}/checks/results?version=` (default latest) →
  `[{check_id,passed,detail,created_at}]`
- `GET  /datasets/{id}/dead-letter?limit=100` → `[{build_id,step,step_type,
  error,row,created_at}]` — rows the most recent build quarantined (2026-07-09)
- `GET  /datasets/{id}/docs` → Data Docs: `{dataset, schema, versions, checks,
  check_results, lineage:{produced_by,upstream_datasets,downstream,stale},
  dead_letter_present}` (2026-07-09)
- `GET  /datasets/{id}/column-lineage` → `{dataset_id, produced_by,
  primary_input, columns:{out_col:[src_col,...]}}` — one-hop column lineage;
  identity for a raw dataset (2026-07-09)
- `GET/POST /checks?dataset_id=`, `PUT/DELETE /checks/{id}` — data
  expectations (body: `{dataset_id, name, type, params, severity?:'warn'|
  'fail', enabled?}`; types: `row_count_min{min}`, `row_count_max{max}`,
  `not_null{column}`, `unique{column}`, `column_exists{column}`,
  `freshness{column, max_age_s}` (newest parsed timestamp — epoch or ISO — in
  `column` within `max_age_s` of now), `schema_contract{columns[],
  types?{col:type}}` (required columns present + optional per-column type match,
  i.e. schema-drift detection) (both 2026-07-09); 422 bad
  type/params, 404 bad dataset). Enforced on every version write (upload,
  append, rollback, transform build): an enabled `fail` check that fails
  blocks the write (422 for uploads/rollback, build status `failed`); `warn`
  failures are recorded but do not block.
- `GET/POST /transforms`, `GET/PUT/DELETE /transforms/{id}`
  (POST/PUT body: `{name, description?, inputs:[dataset_id], output_name,
  steps:[...]}` — output dataset auto-created as kind='derived'; 422 if the
  write would introduce a cycle in the dataset<->transform DAG)
- `POST /transforms/{id}/preview` `{limit?:20}` → `{schema, rows}` (runs
  steps, does NOT write a version)
- `POST /transforms/{id}/build` → Build (synchronous; writes new version of
  output dataset)
- `POST /pipeline/build` `{only_stale?:false}` → Build (topological run of
  every transform; `only_stale` skips transforms that are not stale)
- `GET  /builds?limit=50` → `[Build]`; `GET /builds/{id}` → Build
  (Build = `{id, transform_id, scope, status, started_at, finished_at,
  rows_out, error, log:[str], input_versions:{dataset_id:version}}`)
- `GET  /lineage` → `{nodes:[{id,type:'dataset'|'transform',name,row_count?,
  kind?,stale?:bool}], edges:[{src,dst}]}` — transform nodes and their
  derived-dataset outputs carry `stale`: true if the transform has no
  successful build, or any input dataset's latest version differs from what
  its most recent successful build consumed.
- `GET/POST /bindings`, `PUT/DELETE /bindings/{id}`
  (body: `{dataset_id, object_kind, key_column, prop_map:{col:prop},
  enabled?}`)
- `POST /bindings/{id}/sync` → `{minted, updated, skipped, errors:[str]}`
- `GET/POST /schedules`, `PUT/DELETE /schedules/{id}`
  (body: `{transform_id, interval_s, enabled?}`)

Object ids minted by binding sync: `foundry:{dataset_id}:{key_value}`;
assertions/props written with `source='foundry:{dataset_id}'`.

## Frontend — `apps/web/src/foundry/`

New FOUNDRY surface wired like the existing EXPLORER/GRAPH tabs. Views
(left mini-nav inside the page): Home, Datasets, Pipeline, Builds, Ontology.
Cobalt/Ink tokens only (`theme/tokens.css`); dense 24-28 px rows, tabular
numerals; steel-blue accent for interactive, magenta reserved for selection.
All HTTP through `apiFetch`. Lineage DAG rendered as plain SVG (layered
left→right by topological depth) — no new npm deps. Upload via
drag-and-drop + file input (FormData through apiFetch).

## Guards / acceptance

- `apps/api/tests/test_foundry.py` (+ friends): upload CSV→schema inferred;
  transform build produces new version; filter/derive/join/aggregate
  correctness; safe-expression evaluator rejects `__import__`/attribute
  access; lineage graph correct; binding sync mints objects visible through
  `/api/ontology` routes; keyless (no auth env) end-to-end; dependent-delete
  409.
- `apps/web/src/foundry/foundry.test.tsx`: views render from mocked apiFetch;
  no raw fetch (eslint).
- `bash scripts/verify.sh` green; backend baseline (718 passed) only rises.
