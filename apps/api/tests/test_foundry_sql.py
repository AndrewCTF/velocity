"""Guard: the Foundry SQL console (``POST /api/foundry/sql``) — read-only
queries over latest-version dataset rows loaded into in-memory sqlite tables
named by slugified dataset name (collision-suffixed), join across datasets,
write rejection, unknown-dataset 404, max_rows clamp."""

from __future__ import annotations

import io

from fastapi.testclient import TestClient


def _upload_csv(client: TestClient, name: str, csv_text: str) -> dict:
    files = {"file": (f"{name}.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    r = client.post(
        "/api/foundry/datasets/upload", files=files, data={"name": name, "description": ""}
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_sql_happy_path_selects_rows(client: TestClient) -> None:
    ds = _upload_csv(client, "sql_ships", "id,name,speed\n1,alpha,12\n2,beta,30\n")
    r = client.post(
        "/api/foundry/sql",
        json={"dataset_ids": [ds["id"]], "query": "SELECT * FROM sql_ships WHERE speed > 20"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["row_count"] == 1
    assert body["rows"][0]["name"] == "beta"
    assert body["tables"] == {"sql_ships": ds["id"]}
    assert "speed" in body["columns"]


def test_sql_join_across_two_datasets(client: TestClient) -> None:
    ships = _upload_csv(client, "sql_join_ships", "id,name\n1,alpha\n2,beta\n")
    ports = _upload_csv(client, "sql_join_ports", "ship_id,port\n1,rotterdam\n2,singapore\n")
    r = client.post(
        "/api/foundry/sql",
        json={
            "dataset_ids": [ships["id"], ports["id"]],
            "query": (
                "SELECT s.name, p.port FROM sql_join_ships s"
                " JOIN sql_join_ports p ON s.id = p.ship_id ORDER BY s.name"
            ),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["rows"] == [
        {"name": "alpha", "port": "rotterdam"},
        {"name": "beta", "port": "singapore"},
    ]
    assert set(body["tables"].values()) == {ships["id"], ports["id"]}


def test_sql_name_collision_suffixed(client: TestClient) -> None:
    # Two dataset names that slugify to the same identifier.
    a = _upload_csv(client, "dup name", "id\n1\n")
    b = _upload_csv(client, "dup-name", "id\n2\n")
    r = client.post(
        "/api/foundry/sql",
        json={"dataset_ids": [a["id"], b["id"]], "query": "SELECT 1"},
    )
    assert r.status_code == 200, r.text
    tables = r.json()["tables"]
    assert len(tables) == 2
    names = sorted(tables.keys())
    assert names[0] == "dup_name"
    assert names[1] == "dup_name_2"


def test_sql_insert_rejected(client: TestClient) -> None:
    ds = _upload_csv(client, "sql_insert_guard", "id\n1\n")
    r = client.post(
        "/api/foundry/sql",
        json={
            "dataset_ids": [ds["id"]],
            "query": "INSERT INTO sql_insert_guard VALUES (2)",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert "error" in body


def test_sql_unknown_dataset_404(client: TestClient) -> None:
    r = client.post(
        "/api/foundry/sql",
        json={"dataset_ids": ["does_not_exist"], "query": "SELECT 1"},
    )
    assert r.status_code == 404


def test_sql_max_rows_clamped(client: TestClient) -> None:
    ds = _upload_csv(client, "sql_clamp", "id\n1\n")
    r = client.post(
        "/api/foundry/sql",
        json={
            "dataset_ids": [ds["id"]],
            "query": "SELECT * FROM sql_clamp",
            "max_rows": 999_999,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


def test_run_sql_tolerates_quoted_column_and_oversize_int() -> None:
    # A column literally named a"b (valid JSON key) and an int > 2^63 (a 20-digit
    # id) previously escaped run_sql as an unwrapped OperationalError / OverflowError
    # and 500'd the route. Both must now load cleanly.
    from app.foundry.sqlrun import run_sql

    rows = [{'a"b': 1, "big": 10**25}]
    out, _cols = run_sql("SELECT * FROM t", {"t": rows})
    assert len(out) == 1
    assert out[0]['a"b'] == 1
    assert out[0]["big"] == str(10**25)  # oversize int stored as text, no overflow


def test_run_sql_wraps_load_failure_as_sqlerror(monkeypatch) -> None:
    # Any residual load-time sqlite failure must surface as SqlError (→ clean 4xx),
    # never escape run_sql unwrapped (→ 500).
    import sqlite3

    import pytest

    from app.foundry import sqlrun

    def _boom(*_a: object, **_k: object) -> None:
        raise sqlite3.OperationalError("boom")

    monkeypatch.setattr(sqlrun, "_load_table", _boom)
    with pytest.raises(sqlrun.SqlError):
        sqlrun.run_sql("SELECT 1", {"t": [{"x": 1}]})
