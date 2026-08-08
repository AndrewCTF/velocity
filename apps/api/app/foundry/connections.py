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
           out of a backup of either.

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


async def _run_sql(store: FoundryStore, conn: dict[str, Any]) -> None:
    import sqlalchemy  # noqa: PLC0415 - optional dependency

    cfg = conn["config"]
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
    return json.dumps(
        [conn["kind"], conn["dataset_id"], conn["config"]], sort_keys=True
    )


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
