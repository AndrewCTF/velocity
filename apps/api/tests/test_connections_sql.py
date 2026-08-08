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
    for _ in range(100):
        await asyncio.sleep(0.05)
        rows = client.get(f"/api/foundry/datasets/{ds}/rows").json()["rows"]
        if len(rows) >= 3:
            break
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    rows = client.get(f"/api/foundry/datasets/{ds}/rows").json()["rows"]
    assert [r.get("name") for r in rows] == ["SEED", "SQL ROW ONE", "SQL ROW TWO"]
    assert rows[1]["lat"] == 51.9

    hits = client.get("/api/ontology/search", params={"q": "SQL ROW ONE"}).json()
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
