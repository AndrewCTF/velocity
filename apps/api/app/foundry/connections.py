"""Operator-configured sources: an MQTT topic, a Kafka topic, a SQL query.

Everything this platform ingests today is a source someone wrote code for. A
connection is the other half: the operator points it at THEIR broker or THEIR
database and it lands in a Foundry dataset, after which the ordinary version +
binding machinery carries it into the ontology. Nothing downstream needs to know
where a row came from.

Three kinds, and the reason each is shaped the way it is:

``mqtt``   Dependency-free. The MQTT 3.1.1 codec already existed for one
           hard-coded broker; ``app/mqtt_client.py`` is that codec with the
           broker taken out.
``kafka``  Needs ``aiokafka``, which is an OPTIONAL extra. Absent, the kind
           reports itself unavailable and the app still boots — keyless boot is
           a product requirement, not a dev convenience, and a deployment that
           does not use Kafka must not be made to install a Kafka client.
``sql``    Needs ``sqlalchemy`` (Core only, no ORM), same optional treatment.
           **The connection stores the NAME of an environment variable holding
           the DSN, never the DSN.** Credentials stay in the process
           environment, out of foundry.db, out of API responses, out of logs and
           out of a backup of either. Two sub-modes, both under ``kind: sql``:

           ``query``  (``config.query`` set) the whole answer becomes one new
                      version every cycle, unchanged since this module's first
                      version.
           ``table``  (``config.table`` set, plus ``cursor_column`` and
                      optionally ``batch``) an incremental CURSOR PULL of one
                      named table: columns are reflected with
                      ``sqlalchemy.inspect``, rows are selected where
                      ``cursor_column`` is past the last persisted
                      ``cursor_value``, and each cycle's DELTA — never a copy
                      of the table — becomes its own version
                      (``_run_sql_table_cycle``). This is what makes "an
                      operator's ERP table" a Foundry source without a nightly
                      full-table pull. ``table``/``cursor_column`` are
                      validated as bare identifiers at the route boundary
                      (``routes/foundry.py``); the query itself is always
                      built through ``sqlalchemy.table()``/``select()`` with a
                      bound parameter, never an f-string.

Batching, not row-at-a-time: a Foundry version is an immutable snapshot, so
writing one per message would turn a busy topic into a million versions. Rows
accumulate and flush on whichever comes first, a row count or a deadline.

The supervisor follows the same rule the sidecars learned the hard way
(``apps/api/CLAUDE.md``): reconcile on a loop, not once at boot, or a connection
that dies at 03:00 stays dead until the next restart.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import time
from typing import Any

from app.config import get_settings
from app.foundry import binding as binding_mod
from app.foundry.store import FoundryStore
from app.keys import UserCtx

log = logging.getLogger("app.foundry.connections")

KINDS: tuple[str, ...] = ("mqtt", "kafka", "sql")

# A connection writes on behalf of the deployment, not a signed-in analyst.
_LOCAL_CTX = UserCtx(user_id="local", token="")

# Flush thresholds. 500 rows keeps a version a reasonable size; 10 s keeps a
# quiet topic from sitting unwritten for minutes.
_BATCH_ROWS = 500
_BATCH_AGE_S = 10.0

# How often the supervisor reconciles running tasks against the table.
RECONCILE_EVERY_S = 20.0

# Reconnect backoff for the streaming kinds, doubling to a ceiling.
_BACKOFF_START_S = 2.0
_BACKOFF_MAX_S = 300.0

# An env var name, and nothing that could be a DSN typed into the wrong box.
_ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def valid_dsn_env(name: str) -> bool:
    """True for something that is an environment-variable NAME.

    Deliberately strict rather than clever: anything with a scheme, a slash, a
    space or lower case is far more likely to be a connection string pasted
    into the wrong field than an unusual variable name, and the cost of being
    wrong in that direction is a password in the database.
    """
    return bool(_ENV_NAME_RE.match(name))


# ── optional dependencies ─────────────────────────────────────────────────────


def _probe(module: str) -> str | None:
    """None when importable, else a sentence naming what to install."""
    try:
        __import__(module)
    except Exception:  # noqa: BLE001 - a broken install is also unavailable
        return f"unavailable: pip install {module}"
    return None


def availability() -> dict[str, dict[str, Any]]:
    """Which connection kinds this deployment can actually run.

    Reported rather than assumed, so the UI can grey out a kind instead of
    letting an operator configure one that will only fail at run time.
    """
    kafka = _probe("aiokafka")
    sql = _probe("sqlalchemy")
    return {
        "mqtt": {"available": True, "detail": "built in"},
        "kafka": {"available": kafka is None, "detail": kafka or "aiokafka"},
        "sql": {"available": sql is None, "detail": sql or "sqlalchemy"},
    }


# ── batching ──────────────────────────────────────────────────────────────────


class _Batch:
    """Rows on their way to one dataset, flushed by count or by age."""

    def __init__(self, store: FoundryStore, conn: dict[str, Any]) -> None:
        self._store = store
        self._conn = conn
        self._rows: list[dict[str, Any]] = []
        self._opened = time.monotonic()

    @property
    def due(self) -> bool:
        return bool(self._rows) and (
            len(self._rows) >= _BATCH_ROWS
            or time.monotonic() - self._opened >= _BATCH_AGE_S
        )

    def add(self, row: dict[str, Any]) -> None:
        self._rows.append(row)

    async def flush(self) -> int:
        if not self._rows:
            return 0
        rows, self._rows = self._rows, []
        self._opened = time.monotonic()
        await self._store.append_version(self._conn["dataset_id"], rows)
        await binding_mod.auto_sync_dataset(
            self._store, self._conn["dataset_id"], _LOCAL_CTX
        )
        await self._store.mark_connection(
            self._conn["id"], ok=True, rows_added=len(rows)
        )
        return len(rows)


def message_row(topic: str, payload: bytes) -> dict[str, Any]:
    """One broker message as a dataset row.

    A JSON object becomes the row itself, which is what makes a binding work
    without a transform in between. Anything else is kept verbatim under
    ``payload`` rather than dropped, because a message this code could not read
    is exactly the one an operator needs to see to fix their topic.
    """
    text = payload.decode("utf-8", errors="replace")
    row: dict[str, Any] = {}
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        parsed = None
    if isinstance(parsed, dict):
        row.update(parsed)
    else:
        row["payload"] = text
    row.setdefault("_topic", topic)
    return row


# ── per-kind runners ──────────────────────────────────────────────────────────


async def _run_mqtt(store: FoundryStore, conn: dict[str, Any]) -> None:
    from app import mqtt_client

    cfg = conn["config"]
    url = str(cfg.get("url") or "")
    topic = str(cfg.get("topic") or "")
    if not url or not topic:
        raise ValueError("an mqtt connection needs a url and a topic")
    batch = _Batch(store, conn)
    async for msg_topic, payload in mqtt_client.subscribe(
        url, topic, client_id=str(cfg.get("client_id") or "osint-geoint")
    ):
        batch.add(message_row(msg_topic, payload))
        if batch.due:
            await batch.flush()


async def _run_kafka(store: FoundryStore, conn: dict[str, Any]) -> None:
    from aiokafka import AIOKafkaConsumer  # noqa: PLC0415 - optional dependency

    cfg = conn["config"]
    topic = str(cfg.get("topic") or "")
    servers = str(cfg.get("bootstrap_servers") or "")
    if not topic or not servers:
        raise ValueError("a kafka connection needs bootstrap_servers and a topic")
    consumer = AIOKafkaConsumer(
        topic,
        bootstrap_servers=servers,
        group_id=str(cfg.get("group_id") or "osint-geoint"),
        # Only what arrives from now on: a connection is a live feed, and
        # replaying a retained topic from the beginning would write a version
        # per 500 messages of history nobody asked for.
        auto_offset_reset=str(cfg.get("auto_offset_reset") or "latest"),
        enable_auto_commit=True,
    )
    await consumer.start()
    batch = _Batch(store, conn)
    try:
        while True:
            # A timed poll rather than `async for`, so an idle topic still lets
            # the age-based flush fire.
            got = await consumer.getmany(timeout_ms=1000)
            for _tp, messages in got.items():
                for m in messages:
                    batch.add(message_row(getattr(m, "topic", topic), m.value or b""))
            if batch.due:
                await batch.flush()
    finally:
        with contextlib.suppress(Exception):
            await consumer.stop()


def _resolve_dsn(cfg: dict[str, Any]) -> str:
    """The DSN behind the configured environment-variable NAME.

    The name, not the value, is what a connection row is allowed to hold: a
    dump of foundry.db, an API response listing connections, and a log line are
    all places a DSN with a password in it must never reach.
    """
    env_name = str(cfg.get("dsn_env") or "")
    if not _ENV_NAME_RE.match(env_name):
        raise ValueError(
            "dsn_env must be the NAME of an environment variable holding the "
            "connection string (upper case, e.g. OSINT_SQL_DSN_WAREHOUSE), "
            "never the connection string itself"
        )
    dsn = os.environ.get(env_name)
    if not dsn:
        raise ValueError(f"environment variable {env_name} is not set")
    return dsn


_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def valid_identifier(name: str) -> bool:
    """True for something safe to interpolate as a bare SQL identifier via
    ``sqlalchemy.table()``/``sqlalchemy.column()`` (never an f-string)."""
    return bool(_IDENT_RE.match(name))


def _sql_type_to_schema_type(sa_type: Any) -> str:
    """Map a reflected SQLAlchemy column type to the dataset schema vocabulary
    (``ingest.infer_schema``'s ``int|float|bool|str``), so a table-backed
    dataset's schema reads the same as an uploaded one."""
    import sqlalchemy  # noqa: PLC0415 - optional dependency

    if isinstance(sa_type, sqlalchemy.Boolean):
        return "bool"
    if isinstance(sa_type, sqlalchemy.Integer):
        return "int"
    if isinstance(sa_type, (sqlalchemy.Float, sqlalchemy.Numeric)):
        return "float"
    return "str"


def _reflect_table_schema(
    sqlalchemy_mod: Any, engine: Any, table: str
) -> tuple[list[dict[str, str]], list[str]]:
    """``([{name, type}], [column names in table order])`` via
    ``sqlalchemy.inspect``. Raises whatever the driver raises on an unknown
    table — the caller's usual scrub-and-record path handles it."""
    inspector = sqlalchemy_mod.inspect(engine)
    cols_meta = inspector.get_columns(table)
    schema = [
        {"name": c["name"], "type": _sql_type_to_schema_type(c["type"])} for c in cols_meta
    ]
    return schema, [c["name"] for c in cols_meta]


async def _run_sql_table_cycle(
    sqlalchemy_mod: Any, store: FoundryStore, conn: dict[str, Any], dsn: str
) -> int:
    """One incremental pull of a named table: reflect its columns, select rows
    where ``cursor_column`` is past the last persisted ``cursor_value``, write
    them as ONE new version (the delta only, never the whole table), and
    persist the new cursor on the connection's config.

    Bound parameters only — ``table``/``cursor_column`` are validated as bare
    identifiers at the route boundary (``routes/foundry.py``) and are never
    spliced into a query string; the value side goes through SQLAlchemy Core
    exactly like the existing query-mode path.
    """
    cfg = conn["config"]
    table = str(cfg.get("table") or "")
    cursor_column = str(cfg.get("cursor_column") or "")
    if not cursor_column:
        raise ValueError("a table-mode sql connection needs a cursor_column")
    batch = max(1, min(int(cfg.get("batch") or 5000), 50_000))
    last_cursor = cfg.get("cursor_value")

    def _pull() -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        engine = sqlalchemy_mod.create_engine(dsn)
        try:
            schema, col_names = _reflect_table_schema(sqlalchemy_mod, engine, table)
            tbl = sqlalchemy_mod.table(
                table, *(sqlalchemy_mod.column(n) for n in col_names)
            )
            cursor_col = tbl.c[cursor_column]
            stmt = (
                sqlalchemy_mod.select(*tbl.c)
                .select_from(tbl)
                .order_by(cursor_col)
                .limit(batch)
            )
            params: dict[str, Any] = {}
            if last_cursor is not None:
                stmt = stmt.where(cursor_col > sqlalchemy_mod.bindparam("cursor_after"))
                params["cursor_after"] = last_cursor
            with engine.connect() as c:
                result = c.execute(stmt, params)
                rows = [dict(zip(col_names, r, strict=True)) for r in result]
            return rows, schema
        finally:
            engine.dispose()

    rows, schema = await asyncio.get_running_loop().run_in_executor(None, _pull)
    if rows:
        # Each cycle's delta is its own version — this is the whole point of a
        # cursor pull over a table: growth by the new rows only, never a copy
        # of the table. `source` names the mode so the dataset's version
        # history states it without a schema/kind change this file cannot make
        # (`foundry/store.py` is not owned here; see connections.py module doc).
        await store.add_version(conn["dataset_id"], rows, schema, source="sql:table")
        await binding_mod.auto_sync_dataset(store, conn["dataset_id"], _LOCAL_CTX)
        new_cursor = rows[-1].get(cursor_column, last_cursor)
        # JSON-safe: a timestamp/Decimal cursor column round-trips through
        # config_json, so anything that is not already a JSON scalar is
        # stringified rather than raising and silently re-pulling this same
        # delta forever.
        if not isinstance(new_cursor, (str, int, float, bool)) and new_cursor is not None:
            new_cursor = str(new_cursor)
        # Re-read the row rather than trust the `conn` this task started with:
        # an operator PUT (disable, retarget the dataset, edit the query) in
        # the meantime must not be clobbered by this cycle writing back a
        # stale `enabled`/`dataset_id`/`config`. reconcile() cancels a task
        # whose fingerprint changed, but that is a race against this exact
        # write, so check it here rather than assume the cancellation always
        # wins it.
        fresh = await store.get_connection(conn["id"])
        if fresh is not None and _fingerprint(fresh) == _fingerprint(conn):
            await store.update_connection(
                conn["id"],
                dataset_id=fresh["dataset_id"],
                config={**fresh["config"], "cursor_value": new_cursor},
                enabled=fresh["enabled"],
            )
            # Keep the in-process copy in step so a second cycle inside the
            # same `_run_sql` call (before the next reconcile re-reads the
            # row) starts from the cursor just persisted, not the one it was
            # created with.
            cfg["cursor_value"] = new_cursor
        # else: the connection was edited or deleted out from under this
        # cycle; the rows are already safely versioned, and reconcile() will
        # cancel/restart (or leave stopped) this task on its next tick.
    return len(rows)


async def _run_sql(store: FoundryStore, conn: dict[str, Any]) -> None:
    import sqlalchemy  # noqa: PLC0415 - optional dependency

    cfg = conn["config"]
    table = str(cfg.get("table") or "")

    if table:
        # Validated before the DSN resolves so a misconfigured table-mode
        # connection reports its own mistake, not an unrelated env var.
        if not str(cfg.get("cursor_column") or ""):
            raise ValueError("a table-mode sql connection needs a cursor_column")
        dsn = _resolve_dsn(cfg)
        interval = max(30.0, float(cfg.get("interval_s") or 300))
        while True:
            n = await _run_sql_table_cycle(sqlalchemy, store, conn, dsn)
            await store.mark_connection(conn["id"], ok=True, rows_added=n)
            await asyncio.sleep(interval)

    query = str(cfg.get("query") or "")
    if not query.strip():
        raise ValueError("a sql connection needs a query")
    interval = max(30.0, float(cfg.get("interval_s") or 300))
    dsn = _resolve_dsn(cfg)

    def _pull() -> list[dict[str, Any]]:
        # Core, not the ORM, and a fresh engine per cycle: a poll every few
        # minutes does not justify holding a pool open against someone else's
        # database between runs.
        engine = sqlalchemy.create_engine(dsn)
        try:
            with engine.connect() as c:
                result = c.exec_driver_sql(query)
                return [dict(r) for r in result.mappings()]
        finally:
            engine.dispose()

    while True:
        rows = await asyncio.get_running_loop().run_in_executor(None, _pull)
        if rows:
            # A SQL pull is a whole answer, so it is one version, not a batch.
            await store.append_version(conn["dataset_id"], rows)
            await binding_mod.auto_sync_dataset(
                store, conn["dataset_id"], _LOCAL_CTX
            )
        await store.mark_connection(conn["id"], ok=True, rows_added=len(rows))
        await asyncio.sleep(interval)


_RUNNERS = {"mqtt": _run_mqtt, "kafka": _run_kafka, "sql": _run_sql}


def _scrub(text: str, secret: str | None) -> str:
    return text.replace(secret, "***") if secret else text


async def _run_forever(conn: dict[str, Any]) -> None:
    """One connection, restarted with backoff until it is disabled or removed.

    Errors are recorded on the row, not raised: a broker that is down is an
    operator's problem to see in the UI, not a reason to take a task out of the
    supervisor's hands.
    """
    store = FoundryStore(get_settings())
    runner = _RUNNERS[conn["kind"]]
    backoff = _BACKOFF_START_S
    while True:
        started = time.monotonic()
        try:
            await runner(store, conn)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - every failure is reportable
            # Never let a driver's exception carry the DSN into the database.
            secret = os.environ.get(str(conn["config"].get("dsn_env") or "")) or None
            detail = _scrub(f"{type(exc).__name__}: {exc}", secret)
            log.warning("connection %s failed: %s", conn["name"], detail)
            with contextlib.suppress(Exception):
                await store.mark_connection(conn["id"], ok=False, error=detail)
        # A session that ran for a while was real; only a fast-failing one keeps
        # doubling, so a broker outage backs off to minutes instead of hammering.
        if time.monotonic() - started > 60.0:
            backoff = _BACKOFF_START_S
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, _BACKOFF_MAX_S)


# ── supervision ───────────────────────────────────────────────────────────────

_tasks: dict[str, asyncio.Task[None]] = {}
_fingerprints: dict[str, str] = {}
_supervisor: asyncio.Task[None] | None = None


def _fingerprint(conn: dict[str, Any]) -> str:
    # `cursor_value` is written by the table-mode runner itself every cycle
    # (the only way a cursor survives a restart); excluded here so recording
    # progress does not read as "an edit made in the UI" and bounce the task
    # every reconcile tick instead of only on a REAL config change.
    cfg = {k: v for k, v in conn["config"].items() if k != "cursor_value"}
    return json.dumps([conn["kind"], conn["dataset_id"], cfg], sort_keys=True)


async def _cancel(conn_id: str) -> None:
    task = _tasks.pop(conn_id, None)
    _fingerprints.pop(conn_id, None)
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task


async def reconcile() -> None:
    """Make the running tasks match the enabled rows.

    Also restarts a connection whose config changed, which is the only way an
    edit in the UI takes effect without a reboot.
    """
    store = FoundryStore(get_settings())
    rows = await store.list_connections()
    wanted = {c["id"]: c for c in rows if c["enabled"] and c["kind"] in _RUNNERS}

    for conn_id in list(_tasks):
        conn = wanted.get(conn_id)
        if conn is None or _fingerprints.get(conn_id) != _fingerprint(conn):
            await _cancel(conn_id)
        elif _tasks[conn_id].done():
            # _run_forever only returns if it was cancelled; a finished task is
            # a crash in the supervision layer itself, so restart it.
            _tasks.pop(conn_id, None)
            _fingerprints.pop(conn_id, None)

    availability_now = availability()
    for conn_id, conn in wanted.items():
        if conn_id in _tasks:
            continue
        if not availability_now[conn["kind"]]["available"]:
            continue
        _tasks[conn_id] = asyncio.create_task(
            _run_forever(conn), name=f"connection:{conn['name']}"
        )
        _fingerprints[conn_id] = _fingerprint(conn)


async def supervise() -> None:
    while True:
        try:
            await reconcile()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.warning("connection reconcile failed", exc_info=True)
        await asyncio.sleep(RECONCILE_EVERY_S)


async def start() -> None:
    global _supervisor
    if _supervisor is None or _supervisor.done():
        _supervisor = asyncio.create_task(supervise(), name="connections-supervisor")


async def stop() -> None:
    global _supervisor
    if _supervisor is not None:
        _supervisor.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await _supervisor
        _supervisor = None
    for conn_id in list(_tasks):
        await _cancel(conn_id)


def running_ids() -> list[str]:
    """Connection ids with a live task. Used by the routes to report state."""
    return [cid for cid, t in _tasks.items() if not t.done()]
