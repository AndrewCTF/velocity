"""Guard: GET /api/foundry/connectors — the static catalog of every way a
Foundry dataset can be filled, with live per-kind availability folded in.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

_EXPECTED_KINDS = {"mqtt", "kafka", "sql", "sql-table", "ingest-token", "upload", "document"}


def test_lists_all_seven_kinds_with_boolean_availability(client: TestClient) -> None:
    r = client.get("/api/foundry/connectors")
    assert r.status_code == 200, r.text
    body = r.json()
    assert {row["kind"] for row in body} == _EXPECTED_KINDS
    for row in body:
        assert isinstance(row["available"], bool), row
        assert row["title"]
        assert row["needs"]
        assert row["docs"]


def test_mqtt_ingest_token_upload_document_are_always_available(client: TestClient) -> None:
    body = {row["kind"]: row for row in client.get("/api/foundry/connectors").json()}
    assert body["mqtt"]["available"] is True
    assert body["ingest-token"]["available"] is True
    assert body["upload"]["available"] is True
    # Document is available for its stdlib formats regardless of pypdf.
    assert body["document"]["available"] is True


def test_sql_and_sql_table_share_the_same_availability_as_the_sql_kind(
    client: TestClient, monkeypatch
) -> None:
    """sql-table is a config variant of the `sql` connection kind (same
    optional sqlalchemy dependency), not a second backend — its availability
    must track connections.availability()['sql'] exactly, including when the
    extra is hidden."""
    from app.foundry import connections as C

    body = {row["kind"]: row["available"] for row in client.get("/api/foundry/connectors").json()}
    assert body["sql"] == C.availability()["sql"]["available"]
    assert body["sql-table"] == body["sql"]


def test_document_docs_field_names_pypdf_when_it_is_missing(client: TestClient, monkeypatch) -> None:
    import builtins

    real_import = builtins.__import__

    def _fake(name, *args, **kwargs):  # type: ignore[no-untyped-def]
        if name == "pypdf" or name.startswith("pypdf."):
            raise ModuleNotFoundError("No module named 'pypdf'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _fake)
    body = {row["kind"]: row for row in client.get("/api/foundry/connectors").json()}
    assert "pypdf" in body["document"]["docs"]
    assert "unavailable" in body["document"]["docs"]


def test_kafka_reports_unavailable_when_its_client_is_absent(client: TestClient, monkeypatch) -> None:
    import builtins

    real_import = builtins.__import__

    def _fake(name, *args, **kwargs):  # type: ignore[no-untyped-def]
        if name == "aiokafka" or name.startswith("aiokafka."):
            raise ModuleNotFoundError("No module named 'aiokafka'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _fake)
    body = {row["kind"]: row["available"] for row in client.get("/api/foundry/connectors").json()}
    assert body["kafka"] is False
