"""Guards for operator-configured sources (foundry/connections.py).

Three things are worth pinning and one of them is the reason the file exists:

1. **A keyless boot survives a missing optional client.** Absence is SIMULATED
   with a sys.modules sentinel rather than trusted to the dev venv, because the
   moment ``aiokafka`` is installed here a test that merely imports it would
   pass while proving nothing.
2. **A SQL connection can never hold a connection string.** The row is returned
   by the list route and sits in foundry.db, so a password in it is a leak with
   several copies.
3. The supervisor reconciles, rather than starting things once.
"""

from __future__ import annotations

import asyncio
import builtins
import json

import pytest
from fastapi.testclient import TestClient

from app.foundry import connections as C


@pytest.fixture
def dataset(client: TestClient) -> str:
    r = client.post(
        "/api/foundry/datasets/upload",
        files={"file": ("seed.csv", b"a\n1\n", "text/csv")},
        data={"name": "conn_target"},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


@pytest.fixture(autouse=True)
def _no_stray_tasks():  # type: ignore[no-untyped-def]
    yield
    C._tasks.clear()
    C._fingerprints.clear()


# ── optional dependencies ─────────────────────────────────────────────────────


def _hide(monkeypatch, module: str) -> None:  # type: ignore[no-untyped-def]
    """Make ``import <module>`` fail even when it is installed."""
    real_import = builtins.__import__

    def _fake(name, *args, **kwargs):  # type: ignore[no-untyped-def]
        if name == module or name.startswith(module + "."):
            raise ModuleNotFoundError(f"No module named {module!r}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _fake)


def test_mqtt_never_needs_an_install() -> None:
    assert C.availability()["mqtt"]["available"] is True


def test_probe_says_available_for_something_importable() -> None:
    """The positive half. Without it, a ``_probe`` that always reported absence
    would pass every other test in this section."""
    assert C._probe("json") is None
    assert C._probe("a_module_that_does_not_exist") is not None


@pytest.mark.anyio
async def test_the_mqtt_runner_refuses_an_incomplete_config() -> None:
    with pytest.raises(ValueError, match="url and a topic"):
        await C._run_mqtt(None, {"config": {"url": "mqtt://h:1883"}})  # type: ignore[arg-type]


@pytest.mark.anyio
async def test_the_sql_runner_refuses_an_empty_query(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import sys
    import types

    # sqlalchemy is not installed here, so stand one in: the assertion is about
    # the runner's own validation, not about the driver.
    monkeypatch.setitem(sys.modules, "sqlalchemy", types.ModuleType("sqlalchemy"))
    with pytest.raises(ValueError, match="needs a query"):
        await C._run_sql(None, {"config": {"dsn_env": "X", "query": "  "}})  # type: ignore[arg-type]


def test_kafka_reports_unavailable_when_its_client_is_absent(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _hide(monkeypatch, "aiokafka")
    kafka = C.availability()["kafka"]
    assert kafka["available"] is False
    assert "aiokafka" in kafka["detail"]


def test_sql_reports_unavailable_when_its_client_is_absent(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _hide(monkeypatch, "sqlalchemy")
    sql = C.availability()["sql"]
    assert sql["available"] is False
    assert "sqlalchemy" in sql["detail"]


def test_the_route_reports_availability(client: TestClient) -> None:
    body = client.get("/api/foundry/connections").json()
    assert set(body["availability"]) == {"mqtt", "kafka", "sql"}


@pytest.mark.anyio
async def test_reconcile_skips_a_kind_whose_client_is_missing(
    client: TestClient, dataset: str, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    """The keyless-boot guard: an unavailable kind is left unstarted instead of
    crashing the supervisor."""
    client.post(
        "/api/foundry/connections",
        json={
            "name": "k",
            "kind": "kafka",
            "dataset_id": dataset,
            "config": {"bootstrap_servers": "localhost:9092", "topic": "t"},
        },
    )
    _hide(monkeypatch, "aiokafka")
    C._tasks.clear()
    await C.reconcile()
    assert C.running_ids() == []


# ── the DSN never lands in the database ───────────────────────────────────────


@pytest.mark.parametrize(
    "dsn_env",
    [
        "postgresql://user:hunter2@db.internal/prod",
        "postgres://localhost/x",
        "lower_case_name",
        "HAS SPACE",
        "",
    ],
)
def test_a_sql_connection_refuses_anything_but_a_variable_name(
    client: TestClient, dataset: str, dsn_env: str
) -> None:
    r = client.post(
        "/api/foundry/connections",
        json={
            "name": f"sql-{abs(hash(dsn_env))}",
            "kind": "sql",
            "dataset_id": dataset,
            "config": {"dsn_env": dsn_env, "query": "SELECT 1"},
        },
    )
    assert r.status_code == 422, r.text
    assert "environment variable" in r.json()["detail"]


def test_a_variable_name_is_accepted(client: TestClient, dataset: str) -> None:
    r = client.post(
        "/api/foundry/connections",
        json={
            "name": "warehouse",
            "kind": "sql",
            "dataset_id": dataset,
            "config": {"dsn_env": "OSINT_SQL_DSN_WAREHOUSE", "query": "SELECT 1"},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["config"]["dsn_env"] == "OSINT_SQL_DSN_WAREHOUSE"


def test_no_listing_can_contain_a_password(client: TestClient, dataset: str) -> None:
    client.post(
        "/api/foundry/connections",
        json={
            "name": "warehouse",
            "kind": "sql",
            "dataset_id": dataset,
            "config": {"dsn_env": "OSINT_SQL_DSN_WAREHOUSE", "query": "SELECT 1"},
        },
    )
    listed = json.dumps(client.get("/api/foundry/connections").json())
    assert "hunter2" not in listed
    assert "://" not in listed


def test_an_unset_variable_is_a_readable_error_not_a_crash(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("OSINT_SQL_DSN_NOPE", raising=False)
    with pytest.raises(ValueError, match="OSINT_SQL_DSN_NOPE is not set"):
        C._resolve_dsn({"dsn_env": "OSINT_SQL_DSN_NOPE"})


def test_a_driver_error_carrying_the_dsn_is_scrubbed() -> None:
    """SQLAlchemy puts the URL in some exception messages. Whatever reaches
    last_error must not."""
    secret = "postgresql://user:hunter2@db/prod"
    assert C._scrub(f"OperationalError: could not connect to {secret}", secret) == (
        "OperationalError: could not connect to ***"
    )


# ── CRUD and supervision ──────────────────────────────────────────────────────


def test_create_requires_a_real_dataset(client: TestClient) -> None:
    r = client.post(
        "/api/foundry/connections",
        json={
            "name": "x",
            "kind": "mqtt",
            "dataset_id": "ds_nope",
            "config": {"url": "mqtt://h:1883", "topic": "t"},
        },
    )
    assert r.status_code == 404


def test_duplicate_names_are_refused(client: TestClient, dataset: str) -> None:
    body = {
        "name": "dupe",
        "kind": "mqtt",
        "dataset_id": dataset,
        "config": {"url": "mqtt://h:1883", "topic": "t"},
        "enabled": False,
    }
    assert client.post("/api/foundry/connections", json=body).status_code == 200
    assert client.post("/api/foundry/connections", json=body).status_code == 409


def test_update_and_delete(client: TestClient, dataset: str) -> None:
    created = client.post(
        "/api/foundry/connections",
        json={
            "name": "edit-me",
            "kind": "mqtt",
            "dataset_id": dataset,
            "config": {"url": "mqtt://h:1883", "topic": "a"},
            "enabled": False,
        },
    ).json()
    updated = client.put(
        f"/api/foundry/connections/{created['id']}",
        json={"dataset_id": dataset, "config": {"url": "mqtt://h:1883", "topic": "b"}, "enabled": False},
    ).json()
    assert updated["config"]["topic"] == "b"
    assert client.delete(f"/api/foundry/connections/{created['id']}").status_code == 200
    assert client.delete(f"/api/foundry/connections/{created['id']}").status_code == 404


@pytest.mark.anyio
async def test_reconcile_starts_stops_and_restarts_on_an_edit(
    client: TestClient, dataset: str, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    """A connection that dies at 03:00 must not stay dead until a reboot, and an
    edit in the UI must take effect without one."""
    seen: list[str] = []

    async def _fake_runner(store, conn):  # type: ignore[no-untyped-def]
        seen.append(conn["config"]["topic"])
        await asyncio.Event().wait()

    monkeypatch.setitem(C._RUNNERS, "mqtt", _fake_runner)
    created = client.post(
        "/api/foundry/connections",
        json={
            "name": "live",
            "kind": "mqtt",
            "dataset_id": dataset,
            "config": {"url": "mqtt://h:1883", "topic": "first"},
        },
    ).json()

    await C.reconcile()
    await asyncio.sleep(0)
    assert C.running_ids() == [created["id"]]

    client.put(
        f"/api/foundry/connections/{created['id']}",
        json={"dataset_id": dataset, "config": {"url": "mqtt://h:1883", "topic": "second"}, "enabled": True},
    )
    await C.reconcile()
    await asyncio.sleep(0)
    assert seen == ["first", "second"]

    client.put(
        f"/api/foundry/connections/{created['id']}",
        json={"dataset_id": dataset, "config": {"url": "mqtt://h:1883", "topic": "second"}, "enabled": False},
    )
    await C.reconcile()
    assert C.running_ids() == []


# ── message shaping ───────────────────────────────────────────────────────────


def test_a_json_object_message_becomes_the_row() -> None:
    row = C.message_row("vessels/1", b'{"mmsi": 1, "sog": 12.5}')
    assert row["mmsi"] == 1
    assert row["sog"] == 12.5
    assert row["_topic"] == "vessels/1"


def test_a_message_that_is_not_a_json_object_is_kept_verbatim() -> None:
    """Dropping it would hide exactly the message an operator needs to see to
    fix their topic."""
    assert C.message_row("t", b"not json")["payload"] == "not json"
    assert C.message_row("t", b"[1,2]")["payload"] == "[1,2]"


def test_a_message_carrying_its_own_topic_field_keeps_it() -> None:
    row = C.message_row("broker/topic", b'{"_topic": "mine"}')
    assert row["_topic"] == "mine"
