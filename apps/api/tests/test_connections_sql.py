"""The SQL connection, against a real database engine.

``test_connections.py`` proves the configuration boundary — that a connection
string can never be stored in place of an environment-variable name — but it
never opens a database. This does, using SQLAlchemy against SQLite, which is a
real engine driven by the real code path and needs no server to exist.

What that buys over a mock: the DSN actually resolves from the environment, the
query actually executes through ``exec_driver_sql``, ``.mappings()`` actually
produces the row dicts the batcher expects, and a driver error actually carries
whatever SQLAlchemy chooses to put in it — which is the thing the scrubber has
to defeat.

Skipped rather than failed when the optional extra is absent: ``sqlalchemy`` is
an opt-in install and a keyless deployment is expected not to have it.
"""

from __future__ import annotations

import asyncio
import sqlite3

import pytest

from app.foundry import connections as C

sqlalchemy = pytest.importorskip("sqlalchemy", reason="optional extra: pip install -e '.[sql]'")


@pytest.fixture
def source_db(tmp_path):  # type: ignore[no-untyped-def]
    """A database standing in for the operator's own, with rows to pull."""
    path = tmp_path / "warehouse.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE sites (mmsi INTEGER, name TEXT, lat REAL, lon REAL)")
    con.executemany(
        "INSERT INTO sites VALUES (?,?,?,?)",
        [(636092333, "SQL ROW ONE", 51.9, 4.4), (636092444, "SQL ROW TWO", 30.5, 32.3)],
    )
    con.commit()
    con.close()
    return f"sqlite:///{path}"


def test_availability_reports_sql_as_present_when_it_is_installed() -> None:
    """The positive half of the optional-dependency contract. Without this, a
    probe that always answered 'unavailable' would satisfy every other test."""
    assert C.availability()["sql"] == {"available": True, "detail": "sqlalchemy"}


@pytest.mark.anyio
async def test_a_query_lands_rows_and_mints_ontology_objects(
    source_db: str, client, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    """The whole path: env var → engine → query → dataset version → binding →
    ontology object."""
    monkeypatch.setenv("OSINT_SQL_DSN_TEST", source_db)
    ds = client.post(
        "/api/foundry/datasets/upload",
        files={"file": ("seed.csv", b"mmsi,name\n1,SEED\n", "text/csv")},
        data={"name": "sql_target"},
    ).json()["id"]
    assert client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": ds,
            "object_kind": "vessel",
            "key_column": "mmsi",
            "prop_map": {"name": "name"},
        },
    ).status_code == 200

    from app.config import get_settings
    from app.foundry.store import FoundryStore

    conn = {
        "id": "conn_sql",
        "name": "warehouse",
        "kind": "sql",
        "dataset_id": ds,
        "config": {
            "dsn_env": "OSINT_SQL_DSN_TEST",
            "query": "SELECT mmsi, name, lat, lon FROM sites ORDER BY mmsi",
            "interval_s": 30,
        },
    }
    task = asyncio.create_task(C._run_sql(FoundryStore(get_settings()), conn))
    # Wait for BOTH effects: rows land first and the ontology mint follows, so
    # cancelling on rows alone raced the mint on a slow 4-core CI runner.
    hits: list = []
    for _ in range(200):
        await asyncio.sleep(0.05)
        rows = client.get(f"/api/foundry/datasets/{ds}/rows").json()["rows"]
        hits = client.get("/api/ontology/search", params={"q": "SQL ROW ONE"}).json()
        if len(rows) >= 3 and any(o["props"].get("name") == "SQL ROW ONE" for o in hits):
            break
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    rows = client.get(f"/api/foundry/datasets/{ds}/rows").json()["rows"]
    assert [r.get("name") for r in rows] == ["SEED", "SQL ROW ONE", "SQL ROW TWO"]
    assert rows[1]["lat"] == 51.9

    assert any(o["props"].get("name") == "SQL ROW ONE" for o in hits), hits


@pytest.mark.anyio
async def test_a_query_against_a_missing_table_never_leaks_the_dsn(
    source_db: str, client, monkeypatch
) -> None:
    """SQLAlchemy puts a good deal into its exception text. Whatever the runner
    records on the row must not include the connection string, because that row
    is returned by the list route."""
    monkeypatch.setenv("OSINT_SQL_DSN_TEST", source_db)
    ds = client.post(
        "/api/foundry/datasets/upload",
        files={"file": ("seed.csv", b"a\n1\n", "text/csv")},
        data={"name": "sql_bad"},
    ).json()["id"]
    created = client.post(
        "/api/foundry/connections",
        json={
            "name": "bad-query",
            "kind": "sql",
            "dataset_id": ds,
            "config": {
                "dsn_env": "OSINT_SQL_DSN_TEST",
                "query": "SELECT * FROM no_such_table",
                "interval_s": 30,
            },
            "enabled": False,
        },
    ).json()

    from app.config import get_settings
    from app.foundry.store import FoundryStore

    store = FoundryStore(get_settings())
    conn = {**created, "id": created["id"]}
    task = asyncio.create_task(C._run_forever(conn))
    for _ in range(100):
        await asyncio.sleep(0.05)
        row = await store.get_connection(created["id"])
        if row and row["last_error"]:
            break
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    row = await store.get_connection(created["id"])
    assert row is not None
    assert row["last_error"], "the failure was never recorded on the connection"
    assert "no_such_table" in row["last_error"]
    assert source_db not in row["last_error"]
    assert str(row["last_error"]).count("sqlite:///") == 0

    listed = client.get("/api/foundry/connections").text
    assert source_db not in listed


@pytest.mark.anyio
async def test_an_unset_environment_variable_is_reported_not_crashed(
    client, monkeypatch
) -> None:
    monkeypatch.delenv("OSINT_SQL_DSN_ABSENT", raising=False)
    with pytest.raises(ValueError, match="OSINT_SQL_DSN_ABSENT is not set"):
        await C._run_sql(None, {"config": {"dsn_env": "OSINT_SQL_DSN_ABSENT", "query": "SELECT 1"}})  # type: ignore[arg-type]


# ── table mode: an incremental cursor pull, not a federated query ────────────
# The other half of the "ERP table becomes a dataset without copying the whole
# table every cycle" claim: config.table + config.cursor_column instead of
# config.query. Same engine, same env-var-name DSN discipline.


@pytest.fixture(autouse=True)
def _no_stray_connection_tasks():  # type: ignore[no-untyped-def]
    """Connections created through the route below are ``enabled: False`` so
    the real supervisor never also runs them (it would race the manually
    driven ``_run_sql`` task in these tests for the same rows). Belt and
    braces against anything reconcile() did start."""
    yield
    C._tasks.clear()
    C._fingerprints.clear()


@pytest.fixture
def flight_logs_db(tmp_path):  # type: ignore[no-untyped-def]
    """Stands in for an operator's flight-logs table, with an integer id
    cursor — the ordinary case (an autoincrement primary key or a monotonic
    timestamp column)."""
    path = tmp_path / "erp.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE flight_logs (id INTEGER PRIMARY KEY, tail TEXT, dest TEXT)")
    con.executemany(
        "INSERT INTO flight_logs (id, tail, dest) VALUES (?,?,?)",
        [(1, "N101", "KJFK"), (2, "N102", "KLAX"), (3, "N103", "KORD")],
    )
    con.commit()
    con.close()
    return path, f"sqlite:///{path}"


@pytest.fixture
def tied_logs_db(tmp_path):  # type: ignore[no-untyped-def]
    """The W6-1 case (docs/reviews/palantir-stack-2026-09-17.md): three rows
    share ONE cursor value, so a batch of 2 ends mid-way through the run of
    equals. With the old strict ``>`` filter the cursor pinned at that value
    and the third row was never pulled again."""
    path = tmp_path / "tied.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE tied_logs (seq INTEGER, note TEXT)")
    con.executemany(
        "INSERT INTO tied_logs (seq, note) VALUES (?,?)",
        [(1, "T1"), (1, "T2"), (1, "T3")],
    )
    con.commit()
    con.close()
    return path, f"sqlite:///{path}"


@pytest.mark.anyio
async def test_table_cursor_pull_writes_the_delta_as_its_own_version(
    flight_logs_db: tuple, client, monkeypatch
) -> None:
    """One cycle over a 3-row table: version 1 (the delta) has exactly 3 rows,
    the persisted cursor is the max id pulled, and the dataset's schema is the
    REFLECTED table schema, not something inferred only from the seed upload.
    A second cycle after 2 more rows land writes version 2 with EXACTLY those
    2 rows — never the cumulative 5 — which is the "incremental cursor pull,
    not a copy of the whole table" claim made executable."""
    db_path, dsn = flight_logs_db
    monkeypatch.setenv("OSINT_SQL_DSN_ERP", dsn)

    from app.config import get_settings
    from app.foundry.store import FoundryStore

    store = FoundryStore(get_settings())
    ds = client.post(
        "/api/foundry/datasets", json={"name": "flight_logs_ds"}
    ).json()
    created = client.post(
        "/api/foundry/connections",
        json={
            "name": "erp",
            "kind": "sql",
            "dataset_id": ds["id"],
            "config": {
                "dsn_env": "OSINT_SQL_DSN_ERP",
                "table": "flight_logs",
                "cursor_column": "id",
                "interval_s": 30,
            },
            # Driven manually below via C._run_sql — enabled=False keeps the
            # real supervisor (started by the route's own reconcile() call)
            # from ALSO running this connection and racing the manual task
            # for the same rows.
            "enabled": False,
        },
    ).json()
    assert created["config"]["table"] == "flight_logs"

    task = asyncio.create_task(C._run_sql(store, dict(created)))
    for _ in range(200):
        await asyncio.sleep(0.05)
        versions = client.get(f"/api/foundry/datasets/{ds['id']}/versions").json()
        if versions:
            break
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    versions = client.get(f"/api/foundry/datasets/{ds['id']}/versions").json()
    assert len(versions) == 1, versions
    v1 = versions[0]
    assert v1["version"] == 1
    assert v1["row_count"] == 3
    assert v1["source"] == "sql:table"

    ds_row = client.get(f"/api/foundry/datasets/{ds['id']}").json()
    types = {c["name"]: c["type"] for c in ds_row["schema"]}
    assert types == {"id": "int", "tail": "str", "dest": "str"}
    rows = client.get(f"/api/foundry/datasets/{ds['id']}/rows").json()["rows"]
    assert [r["tail"] for r in rows] == ["N101", "N102", "N103"]

    conn_after = await store.get_connection(created["id"])
    assert conn_after["config"]["cursor_value"] == 3

    # A second cycle only picks up rows past the persisted cursor.
    con = sqlite3.connect(db_path)
    con.executemany(
        "INSERT INTO flight_logs (id, tail, dest) VALUES (?,?,?)",
        [(4, "N104", "KDEN"), (5, "N105", "KSEA")],
    )
    con.commit()
    con.close()

    task2 = asyncio.create_task(C._run_sql(store, dict(conn_after)))
    for _ in range(200):
        await asyncio.sleep(0.05)
        versions = client.get(f"/api/foundry/datasets/{ds['id']}/versions").json()
        if len(versions) >= 2:
            break
    task2.cancel()
    await asyncio.gather(task2, return_exceptions=True)

    versions = client.get(f"/api/foundry/datasets/{ds['id']}/versions").json()
    assert len(versions) == 2, versions
    v2 = next(v for v in versions if v["version"] == 2)
    assert v2["row_count"] == 2, "the second cycle must write only the delta, not all 5 rows"
    rows = client.get(f"/api/foundry/datasets/{ds['id']}/rows").json()["rows"]
    assert [r["tail"] for r in rows] == ["N104", "N105"]

    conn_final = await store.get_connection(created["id"])
    assert conn_final["config"]["cursor_value"] == 5


@pytest.mark.anyio
async def test_table_cycle_never_clobbers_a_concurrent_operator_edit(
    flight_logs_db: tuple, client, monkeypatch
) -> None:
    """A cycle is handed the connection dict it started with. If the stored
    row changed by the time the pull finishes (an operator PUT landed mid-
    cycle), persisting the cursor must not silently overwrite that edit with
    the stale values the task was created with."""
    _db_path, dsn = flight_logs_db
    monkeypatch.setenv("OSINT_SQL_DSN_ERP3", dsn)

    from app.config import get_settings
    from app.foundry.store import FoundryStore

    store = FoundryStore(get_settings())
    ds = client.post("/api/foundry/datasets", json={"name": "flight_logs_edit_ds"}).json()
    created = client.post(
        "/api/foundry/connections",
        json={
            "name": "erp-edit",
            "kind": "sql",
            "dataset_id": ds["id"],
            "config": {
                "dsn_env": "OSINT_SQL_DSN_ERP3",
                "table": "flight_logs",
                "cursor_column": "id",
                "interval_s": 30,
            },
            "enabled": False,
        },
    ).json()

    # The operator flips it on WHILE the (stale) `created` dict below still
    # says disabled — standing in for an edit landing mid-cycle.
    await store.update_connection(
        created["id"], dataset_id=ds["id"], config=created["config"], enabled=True
    )

    n = await C._run_sql_table_cycle(sqlalchemy, store, dict(created), dsn)
    assert n == 3

    after = await store.get_connection(created["id"])
    assert after["enabled"] is True, "the cycle clobbered a concurrent operator edit"
    # The rows are still safely versioned even though the cursor write was
    # skipped for this cycle — reconcile() picks the connection back up.
    versions = client.get(f"/api/foundry/datasets/{ds['id']}/versions").json()
    assert versions and versions[0]["row_count"] == 3


def test_a_table_name_with_a_space_is_rejected_at_the_route(client) -> None:
    ds = client.post("/api/foundry/datasets", json={"name": "bad_table_ds"}).json()
    r = client.post(
        "/api/foundry/connections",
        json={
            "name": "bad-table",
            "kind": "sql",
            "dataset_id": ds["id"],
            "config": {
                "dsn_env": "OSINT_SQL_DSN_ERP",
                "table": "flight logs",
                "cursor_column": "id",
            },
        },
    )
    assert r.status_code == 422, r.text
    assert "table" in r.json()["detail"]


def test_a_cursor_column_with_a_semicolon_is_rejected_at_the_route(client) -> None:
    ds = client.post("/api/foundry/datasets", json={"name": "bad_cursor_ds"}).json()
    r = client.post(
        "/api/foundry/connections",
        json={
            "name": "bad-cursor",
            "kind": "sql",
            "dataset_id": ds["id"],
            "config": {
                "dsn_env": "OSINT_SQL_DSN_ERP",
                "table": "flight_logs",
                "cursor_column": "id; DROP TABLE flight_logs",
            },
        },
    )
    assert r.status_code == 422, r.text
    assert "cursor_column" in r.json()["detail"]


@pytest.mark.anyio
async def test_table_mode_requires_a_cursor_column(monkeypatch) -> None:
    monkeypatch.setenv("OSINT_SQL_DSN_ERP2", "sqlite:///does-not-matter")
    with pytest.raises(ValueError, match="cursor_column"):
        await C._run_sql(
            None,  # type: ignore[arg-type]
            {"config": {"dsn_env": "OSINT_SQL_DSN_ERP2", "table": "flight_logs"}},
        )


@pytest.mark.anyio
async def test_table_cycle_pulls_every_row_sharing_the_boundary_cursor(
    tied_logs_db: tuple, client, monkeypatch
) -> None:
    """W6-1 regression: three rows at seq=1, batch 2. With the old strict
    ``>`` filter, cycle 1 pulled two rows, pinned cursor_value=1, and the
    third row was lost FOREVER — every later cycle returned 0 rows while
    the connection kept marking itself healthy. The fix re-fetches
    ``>=`` the boundary and pages until a short page, so the row the batch
    left behind surfaces in the SAME cycle; the persisted full-row hash
    set drops exactly the rows already ingested at that value, so the next
    cycle is a no-op — and a fresh row arriving at the still-pinned value
    still lands (dedupe is per (cursor value, row), not per cursor value)."""
    db_path, dsn = tied_logs_db
    monkeypatch.setenv("OSINT_SQL_DSN_TIED", dsn)

    from app.config import get_settings
    from app.foundry.store import FoundryStore

    store = FoundryStore(get_settings())
    ds = client.post("/api/foundry/datasets", json={"name": "tied_ds"}).json()
    created = client.post(
        "/api/foundry/connections",
        json={
            "name": "tied",
            "kind": "sql",
            "dataset_id": ds["id"],
            "config": {
                "dsn_env": "OSINT_SQL_DSN_TIED",
                "table": "tied_logs",
                "cursor_column": "seq",
                "batch": 2,
                "interval_s": 30,
            },
            "enabled": False,
        },
    ).json()

    # Cycle 1: the batch of 2 ends mid-tie, and the catch-up pagination
    # inside the cycle surfaces the straggler in the SAME cycle.
    n1 = await C._run_sql_table_cycle(sqlalchemy, store, dict(created), dsn)
    assert n1 == 3, "the row the batch left behind must not wait for a cycle"
    conn1 = await store.get_connection(created["id"])
    assert conn1["config"]["cursor_value"] == 1
    assert len(conn1["config"].get("cursor_hashes", [])) == 3, (
        "the boundary-dedupe bookkeeping must be persisted next to the cursor"
    )

    # Nothing new since: the re-fetched boundary rows are fully deduplicated
    # — zero rows, no second version (no duplicate re-ingest).
    n2 = await C._run_sql_table_cycle(sqlalchemy, store, dict(conn1), dsn)
    assert n2 == 0, "the re-fetched boundary rows must dedupe, not re-land"
    counts = {
        v["version"]: v["row_count"]
        for v in client.get(f"/api/foundry/datasets/{ds['id']}/versions").json()
    }
    assert counts == {1: 3}, counts

    # A fresh row arrives at the still-pinned value: it is not a re-fetch
    # of an ingested row, so it lands.
    con = sqlite3.connect(db_path)
    con.execute("INSERT INTO tied_logs (seq, note) VALUES (1, 'T4')")
    con.commit()
    con.close()
    conn2 = await store.get_connection(created["id"])
    n3 = await C._run_sql_table_cycle(sqlalchemy, store, dict(conn2), dsn)
    assert n3 == 1, "a NEW row at the pinned value must still be pulled"
    conn3 = await store.get_connection(created["id"])
    assert conn3["config"]["cursor_value"] == 1, "the boundary stays pinned"
    assert len(conn3["config"].get("cursor_hashes", [])) == 4, (
        "with the boundary pinned the hash set accumulates, so a row "
        "ingested two cycles ago at this value is still recognised"
    )
    counts = {
        v["version"]: v["row_count"]
        for v in client.get(f"/api/foundry/datasets/{ds['id']}/versions").json()
    }
    assert counts == {1: 3, 2: 1}, counts
