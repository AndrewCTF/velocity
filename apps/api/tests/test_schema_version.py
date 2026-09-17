"""Every local SQLite store records its schema version, and the upgrade is visible.

Two properties, and the difference between them is the point of the slice:

  * an upgrade is a STATEMENT — each store writes its version at schema setup,
    ``report()`` reads them back, and ``/api/status/version`` shows the build
    (``VELOCITY_VERSION`` + git sha) next to them;
  * a DOWNGRADE is REFUSED — a file that records a newer version than the code
    asks for raises ``SchemaTooNew`` instead of opening, because an older build
    reading a newer schema is a silent mis-read, not an error.

The store-level tests drive the real modules (and the conftest isolation that
points each of them at a tmp file), not a stand-in store.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import schema_version
from app.routes import status as status_mod

_STORES = ("ontology", "foundry", "audit", "resolve")


def _store(name: str) -> tuple[Callable[[str | None], None], Callable[[], sqlite3.Connection]]:
    """(override_db_path, connect) for a store, by the name ``ensure`` records."""
    if name == "ontology":
        from app.intel import ontology_local as mod

        return mod.override_db_path, mod._connect
    if name == "foundry":
        from app.foundry import store as mod

        return mod.override_db_path, mod._connect
    if name == "audit":
        from app import audit as mod

        return mod.override_db_path, mod._local_connect
    from app.intel import resolve as mod

    return mod.override_db_path, mod._connect


def _open_every_store() -> None:
    for name in _STORES:
        _store(name)[1]().close()


# ── ensure() ──────────────────────────────────────────────────────────────────


def test_ensure_records_the_version_and_returns_the_previous_one(tmp_path: Path) -> None:
    """0 = "no record" (a brand-new file); then the version it was at."""
    con = sqlite3.connect(str(tmp_path / "demo.db"))
    try:
        assert schema_version.ensure(con, "demo", 1) == 0
        assert schema_version.ensure(con, "demo", 1) == 1
        # An upgrade returns the version it left, and moves the row forward.
        assert schema_version.ensure(con, "demo", 2) == 1
        row = con.execute(
            "SELECT version, applied_at FROM schema_version WHERE store='demo'"
        ).fetchone()
    finally:
        con.close()
    assert row[0] == 2
    assert row[1].endswith("Z") and len(row[1]) == 20, row[1]


def test_ensure_refuses_a_downgrade(tmp_path: Path) -> None:
    con = sqlite3.connect(str(tmp_path / "demo.db"))
    try:
        schema_version.ensure(con, "demo", 2)  # what a newer build wrote
        with pytest.raises(schema_version.SchemaTooNew) as exc:
            schema_version.ensure(con, "demo", 1)
        assert (exc.value.store, exc.value.stored, exc.value.requested) == ("demo", 2, 1)
        # Refusing is not a mis-read: the newer row is left exactly as it was.
        assert con.execute("SELECT version FROM schema_version").fetchone()[0] == 2
    finally:
        con.close()


def test_ensure_checks_the_row_every_call_not_just_the_first(tmp_path: Path) -> None:
    """Another build can migrate the file while this process is up, so the check
    has to be a read of the row, not a memo of the first answer."""
    con = sqlite3.connect(str(tmp_path / "demo.db"))
    try:
        assert schema_version.ensure(con, "demo", 1) == 0
        con.execute("UPDATE schema_version SET version=2 WHERE store='demo'")
        with pytest.raises(schema_version.SchemaTooNew):
            schema_version.ensure(con, "demo", 1)
    finally:
        con.close()


@pytest.mark.parametrize("name", _STORES)
def test_a_store_refuses_to_open_a_file_from_a_newer_build(name: str, tmp_path: Path) -> None:
    """Through the real store modules: the version is refused, not mis-read."""
    override, connect = _store(name)
    path = tmp_path / f"{name}.db"
    newer = sqlite3.connect(str(path))
    newer.execute(
        "CREATE TABLE schema_version ("
        " store TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL)"
    )
    newer.execute("INSERT INTO schema_version VALUES (?, 2, '2030-01-01T00:00:00Z')", (name,))
    newer.commit()
    newer.close()

    override(str(path))
    try:
        with pytest.raises(schema_version.SchemaTooNew) as exc:
            connect()
        # ...and the status story keeps saying so: the file reports the version
        # this build refuses, so code/store disagreement is visible, not hidden.
        assert schema_version.report()[name] == 2
    finally:
        override(None)
    assert (exc.value.store, exc.value.stored, exc.value.requested) == (name, 2, 1)


# ── report() ──────────────────────────────────────────────────────────────────


def test_report_reads_every_store_after_its_first_open() -> None:
    _open_every_store()
    assert schema_version.report() == dict.fromkeys(_STORES, 1)


def test_report_zero_for_a_store_that_was_never_opened() -> None:
    """A store with no file reads 0 — "not there" and "no record" are the same
    answer here, and neither is an error."""
    assert schema_version.report() == dict.fromkeys(_STORES, 0)


def test_report_does_not_create_the_stores_it_reads() -> None:
    """report() backs a public, polled route: it must not write, or a status
    page would create every store on first hit."""
    from app.intel import ontology_local

    path = Path(ontology_local._resolved_db_path())
    assert not path.exists()
    schema_version.report()
    assert not path.exists()


# ── GET /api/status/version ───────────────────────────────────────────────────


def test_status_version_reports_the_build_and_every_store(client: TestClient) -> None:
    _open_every_store()
    r = client.get("/api/status/version")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["version"], str) and body["version"]
    assert isinstance(body["git_sha"], str) and body["git_sha"]
    assert body["python"].split(".")[0].isdigit()
    assert set(body["stores"]) == set(_STORES)
    assert all(isinstance(v, int) for v in body["stores"].values())
    assert body["stores"] == dict.fromkeys(_STORES, 1)


def test_status_version_reports_the_release_tag(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VELOCITY_VERSION", "1.2.3")
    assert client.get("/api/status/version").json()["version"] == "1.2.3"


def test_status_version_never_500s_when_git_is_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(*_a: object, **_k: object) -> object:
        raise FileNotFoundError("git")

    monkeypatch.setattr(status_mod.subprocess, "run", _boom)
    r = client.get("/api/status/version")
    assert r.status_code == 200
    assert r.json()["git_sha"] == "unknown"
