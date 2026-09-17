"""Which schema version each local SQLite store is at — the upgrade story.

Every local store in this app owns its own file and its own schema (ontology,
foundry, audit, resolve) and each of them evolves independently. Nothing
recorded which shape a file on disk was actually in, so an upgrade could only be
reasoned about from the code that was running, and a DOWNGRADE — older code
opening a file a newer build had already migrated — mis-read the schema
silently: a column that is not there yet behaves exactly like a column that
never existed.

This module is the missing record. Each store writes its version into its own
file, in a one-row-per-store ``schema_version`` table, at schema-setup time
(see the ``ensure`` call in each store's ``_connect``). ``report()`` reads them
all back for ``GET /api/status/version``, which is what makes an upgrade a
statement an operator can check instead of an assumption.

Two properties matter, and both are deliberate:

* **A downgrade is refused loudly.** If a file records a HIGHER version than
  the running code asks for, ``ensure`` raises :class:`SchemaTooNew` and the
  store does not open. Failing is the point: the alternative is reading a
  schema this build does not understand and writing rows that look fine.
* **The version read is not memoised, only the write is.** A store's
  ``_connect`` runs on every operation, so ``ensure`` must not re-run DDL or
  re-write on each one — but the version check has to hold on every connection,
  not just the first one this process happened to open, or a file upgraded
  underneath a long-lived process would go unnoticed. The read is a single
  primary-key lookup on a table with one row per store; the ``CREATE TABLE``
  and the upsert happen only when the table is missing or the version changed.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

__all__ = ["SchemaTooNew", "ensure", "report"]

#: Table created in each store's own file. One row per store, so the same
#: helper works for a store that shares a file with another one.
_CREATE = """
CREATE TABLE IF NOT EXISTS schema_version (
  store      TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  applied_at TEXT NOT NULL
)
"""

_SELECT = "SELECT version FROM schema_version WHERE store = ?"

_UPSERT = (
    "INSERT INTO schema_version (store, version, applied_at) VALUES (?, ?, ?) "
    "ON CONFLICT(store) DO UPDATE SET version = excluded.version, "
    "applied_at = excluded.applied_at"
)


class SchemaTooNew(RuntimeError):
    """The file on disk is at a newer schema version than this code reads.

    Raised instead of opening the store: an older build pointed at a newer file
    cannot read it correctly, so a loud failure here is the whole point of
    recording the version at all.
    """

    def __init__(self, store: str, stored: int, requested: int) -> None:
        self.store = store
        self.stored = stored
        self.requested = requested
        super().__init__(
            f"{store}: on-disk schema version {stored} is newer than this build's "
            f"{requested} — refusing to open it (a downgrade, not an upgrade). "
            "Run the application version that wrote this file, or restore the "
            "file from before the upgrade."
        )


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure(con: sqlite3.Connection, store: str, version: int) -> int:
    """Record that ``store``'s schema is at ``version``; return what it was at.

    ``0`` means the store had no record — a brand-new file, or one written
    before this module existed. Called from each store's schema-setup block, so
    the connection is not in a transaction and the write is committed here (a
    version record that a crash could lose would be worse than none).

    Raises :class:`SchemaTooNew` when the file already holds a HIGHER version.
    """
    try:
        row = con.execute(_SELECT, (store,)).fetchone()
    except sqlite3.OperationalError:
        # No table yet. Reached only while it is missing, so the DDL costs
        # nothing on the connections a store opens after its first one — and
        # re-running it heals a file that was replaced under the same path.
        con.execute(_CREATE)
        row = con.execute(_SELECT, (store,)).fetchone()
    stored = int(row[0]) if row else 0
    if stored > version:
        raise SchemaTooNew(store, stored, version)
    if stored != version:
        con.execute(_UPSERT, (store, version, _now_iso()))
        con.commit()
    return stored


def _read_version(path: str, store: str) -> int:
    """The version ``path`` records for ``store``, read-only; 0 when unknown.

    Read-only because this is called from a status route: reporting must not
    create a file, journal, or row. An unreadable file (locked, corrupt, not a
    database) reports 0 exactly like a missing one — the route's contract is a
    version per store, not an error per store.
    """
    if not Path(path).exists():
        return 0
    try:
        con = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    except sqlite3.Error:
        return 0
    try:
        row = con.execute(_SELECT, (store,)).fetchone()
    except sqlite3.Error:
        return 0
    finally:
        con.close()
    return int(row[0]) if row else 0


def report() -> dict[str, int]:
    """Every local store's recorded schema version, by store name.

    Paths come from the stores' OWN resolvers (imported here rather than at
    module scope so this module stays importable from inside them), so a store
    an operator pointed elsewhere is reported where it actually lives. A store
    that has never been opened reports 0.
    """
    from app import audit
    from app.foundry import store as foundry_store
    from app.intel import ontology_local, resolve

    paths = {
        "ontology": ontology_local._resolved_db_path(),
        "foundry": foundry_store._resolved_db_path(),
        "audit": audit._local_db_path(),
        "resolve": resolve._resolved_db_path(),
    }
    return {store: _read_version(path, store) for store, path in paths.items()}
