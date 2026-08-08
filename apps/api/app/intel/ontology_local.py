"""Local SQLite ontology store — THE ontology backend behind ``get_registry``.

The ontology must work on a keyless boot (the platform's core identity), hold
time, and hold provenance — see ``docs/roadmap-ontology-2026-07.md`` Phase 1.
This module gives ``intel/ontology.py``'s Object/Link surface a local spine
using the exact ``app/history.py`` idiom: WAL SQLite under ``./data``, fresh
connection per operation, sync cores run in the default executor, and a
``override_db_path()`` hook so tests never touch the repo's data dir.

Beyond the blob surface, every object property is also
recorded in an append-only ``assertions`` table — *who said this, when, how
sure* — which the history tabs, derivation chains and deception scoring of
later phases read. The materialized ``objects.props`` column stays the exact
last-written blob (wholesale replace, including removals) because the
Investigation canvas and the workspace stores (situations / maps / COP /
annotations) round-trip it verbatim.

Budgets (roadmap Phase 1): identical-value assertions are deduped, each object
keeps at most ``settings.ontology_max_assertions_per_object`` assertions
(oldest deleted first), and the whole file is soft-capped at
``settings.ontology_db_max_bytes`` (oldest 10% of assertions dropped +
VACUUM, checked at most once an hour / every 500 writes).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

from app.config import Settings, get_settings
from app.intel.ontology import (
    Assertion,
    Link,
    Object,
    _GraphWalk,
    kind_of,
)
from app.keys import UserCtx

log = logging.getLogger(__name__)

# ── DB path injection (for tests) ─────────────────────────────────────────────

_db_path_override: str | None = None


def override_db_path(path: str | None) -> None:
    """Set a custom DB path (tests). Pass None to clear."""
    global _db_path_override
    _db_path_override = path
    # Pointing at a different file invalidates the per-path "FTS is already
    # backfilled" memo — a tmp path can be reused across tests with different
    # contents, and a stale memo would leave the second one unsearchable.
    _fts_backfilled.clear()


def _resolved_db_path(settings: Settings | None = None) -> str:
    if _db_path_override is not None:
        return _db_path_override
    return (settings or get_settings()).ontology_db_path


# ── connection / schema ───────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS objects (
  user_id        TEXT NOT NULL,
  id             TEXT NOT NULL,
  kind           TEXT NOT NULL,
  props          TEXT NOT NULL DEFAULT '{}',
  classification INTEGER NOT NULL DEFAULT 0,
  compartments   TEXT NOT NULL DEFAULT '[]',
  shared         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS ix_objects_kind ON objects(user_id, kind);
CREATE TABLE IF NOT EXISTS assertions (
  id          INTEGER PRIMARY KEY,
  user_id     TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  prop        TEXT NOT NULL,
  value       TEXT NOT NULL,
  source      TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  observed_at TEXT NOT NULL,
  valid_until TEXT,
  derivation  TEXT
);
CREATE INDEX IF NOT EXISTS ix_assert_obj
  ON assertions(user_id, object_id, prop, observed_at DESC);
CREATE TABLE IF NOT EXISTS links (
  id             INTEGER PRIMARY KEY,
  user_id        TEXT NOT NULL,
  src            TEXT NOT NULL,
  dst            TEXT NOT NULL,
  rel            TEXT NOT NULL,
  props          TEXT NOT NULL DEFAULT '{}',
  source         TEXT NOT NULL DEFAULT 'analyst',
  confidence     REAL NOT NULL DEFAULT 1.0,
  observed_at    TEXT NOT NULL,
  valid_until    TEXT,
  classification INTEGER NOT NULL DEFAULT 0,
  compartments   TEXT NOT NULL DEFAULT '[]',
  shared         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  UNIQUE(user_id, src, dst, rel)
);
CREATE INDEX IF NOT EXISTS ix_links_src ON links(user_id, src);
CREATE INDEX IF NOT EXISTS ix_links_dst ON links(user_id, dst);
CREATE VIRTUAL TABLE IF NOT EXISTS objects_fts USING fts5(
  id, kind, text, user_id UNINDEXED, tokenize='porter unicode61'
);
"""

# The FTS index is maintained from Python (``_fts_write_sync`` below) rather
# than by SQLite triggers, because what belongs in it is the FLATTENED prop
# VALUES — a trigger only ever sees the raw JSON blob in the ``props`` column
# and would index its braces and quoting along with the words.
#
# One value per prop, truncated, so a single object carrying a large blob (a
# situation's node list, an evidence manifest) cannot dominate the index.
_FTS_VALUE_CHARS = 200
_FTS_MAX_PROPS = 60


def _connect(settings: Settings | None = None) -> sqlite3.Connection:
    path = _resolved_db_path(settings)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.executescript(_SCHEMA)
    con.commit()
    return con


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _canon(value: Any) -> str:
    """Canonical JSON encoding for change-detection / dedup comparisons."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


# ── full-text index ───────────────────────────────────────────────────────────


def _fts_text(object_id: str, kind: str, props: dict[str, Any]) -> str:
    """The searchable body of an object: its id, its kind, and every property
    name paired with a flattened rendering of its value.

    Property NAMES are indexed too, so "callsign" finds every object that
    reports one — the Explorer facet case — not just objects whose value happens
    to contain the word.
    """
    parts = [object_id, object_id.replace(":", " "), kind]
    for i, (name, value) in enumerate(props.items()):
        if i >= _FTS_MAX_PROPS:
            break
        parts.append(str(name))
        if value is None or isinstance(value, bool):
            continue
        if isinstance(value, (str, int, float)):
            parts.append(str(value)[:_FTS_VALUE_CHARS])
        else:
            # Lists and dicts: index the JSON with its punctuation stripped, so
            # a nested name is a word rather than `["name"` .
            parts.append(
                re.sub(r"[^0-9A-Za-z_]+", " ", _canon(value))[:_FTS_VALUE_CHARS]
            )
    return " ".join(parts)


def _fts_write_sync(
    con: sqlite3.Connection,
    user_id: str,
    object_id: str,
    kind: str,
    props: dict[str, Any],
) -> None:
    """Re-index one object. Delete-then-insert: FTS5 has no upsert, and an
    external-content table would have to be kept in step with the same manual
    writes anyway."""
    _fts_delete_sync(con, user_id, object_id)
    con.execute(
        "INSERT INTO objects_fts (id, kind, text, user_id) VALUES (?,?,?,?)",
        (object_id, kind, _fts_text(object_id, kind, props), user_id),
    )


def _fts_delete_sync(con: sqlite3.Connection, user_id: str, object_id: str) -> None:
    con.execute(
        "DELETE FROM objects_fts WHERE user_id=? AND id=?", (user_id, object_id)
    )


def _fts_match(q: str) -> str:
    """A user's words as an FTS5 prefix query, or "" when there is nothing to
    search for.

    Never interpolate raw input into MATCH: FTS5 treats ``"``, ``*``, ``:``,
    ``^``, ``-`` and ``NEAR`` as syntax, so a callsign like ``AAL-123`` or a
    stray quote raises OperationalError instead of returning no rows. Reducing
    the input to word tokens and quoting each one makes any input legal, and the
    trailing ``*`` is what makes a Find panel feel like a Find panel.
    """
    tokens = re.findall(r"[0-9A-Za-z_]+", q)
    return " ".join(f'"{t}"*' for t in tokens)


# Backfill is per database path and per process: an existing deployment has
# objects that predate this index, and rebuilding them on every _connect (which
# happens once per operation) would put two COUNT(*)s in front of every write.
_fts_backfilled: set[str] = set()


# Soft byte-cap bookkeeping (module-level, same philosophy as history.py's
# hourly maintenance): re-check the file size at most once an hour or every
# 500 writes, whichever comes first.
_writes_since_check: int = 0
_next_size_check: float = 0.0
_SIZE_CHECK_EVERY_WRITES = 500
_SIZE_CHECK_EVERY_S = 3600.0


class SqliteRegistry(_GraphWalk):
    """Per-user Object/Link/Assertion store in local SQLite — THE ontology store.

    Surface: ``upsert / get / delete / link / traverse / path_between /
    list_by_kind`` plus the assertion layer (``assert_props`` /
    ``get_assertions``). All rows are scoped by ``user_id`` (parity with the
    RLS model this replaced).
    """

    def __init__(self, ctx: UserCtx, settings: Settings | None = None) -> None:
        self.ctx = ctx
        self.s = settings or get_settings()

    async def _run(self, fn: Any) -> Any:
        return await asyncio.get_running_loop().run_in_executor(None, fn)

    # ---- objects ----------------------------------------------------------

    async def upsert(self, obj: Object, source: str = "analyst") -> Object:
        """Insert or replace an object; diff props into assertions.

        The ``props`` column is replaced WHOLESALE (the frontend round-trip
        contract, removals included). Each changed prop additionally appends an
        assertion carrying ``source``; removed props append a tombstone
        (``value=null`` + ``derivation={"op":"remove"}``). An assertion is
        skipped when its value equals the latest recorded one (dedup).
        """
        obj = obj.normalised()

        def _sync() -> Object:
            now = _now_iso()
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT props, created_at FROM objects"
                    " WHERE user_id=? AND id=?",
                    (self.ctx.user_id, obj.id),
                ).fetchone()
                old_props: dict[str, Any] = json.loads(row[0]) if row else {}
                created_at = row[1] if row else now
                con.execute(
                    """
                    INSERT INTO objects (user_id, id, kind, props,
                      classification, compartments, shared,
                      created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(user_id, id) DO UPDATE SET
                      kind=excluded.kind, props=excluded.props,
                      classification=excluded.classification,
                      compartments=excluded.compartments,
                      shared=excluded.shared, updated_at=excluded.updated_at
                    """,
                    (
                        self.ctx.user_id,
                        obj.id,
                        obj.kind,
                        json.dumps(obj.props),
                        int(obj.classification),
                        json.dumps(obj.compartments),
                        int(obj.shared),
                        created_at,
                        now,
                    ),
                )
                for prop, value in obj.props.items():
                    if prop in old_props and _canon(old_props[prop]) == _canon(
                        value
                    ):
                        continue
                    self._insert_assertion_sync(
                        con, obj.id, prop, value, source, 1.0, now, None, None
                    )
                for prop in old_props:
                    if prop not in obj.props:
                        self._insert_assertion_sync(
                            con,
                            obj.id,
                            prop,
                            None,
                            source,
                            1.0,
                            now,
                            None,
                            {"op": "remove"},
                        )
                _fts_write_sync(
                    con, self.ctx.user_id, obj.id, obj.kind, obj.props
                )
                self._enforce_object_cap_sync(con, obj.id)
                con.commit()
                self._maybe_enforce_size_cap(con)
                return obj.model_copy(update={"created_at": created_at})
            finally:
                con.close()

        return await self._run(_sync)

    async def get(self, object_id: str) -> Object | None:
        def _sync() -> Object | None:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT id, kind, props, classification, compartments,"
                    " shared, created_at FROM objects WHERE user_id=? AND id=?",
                    (self.ctx.user_id, object_id),
                ).fetchone()
            finally:
                con.close()
            if row is None:
                return None
            return _object_from_row(row)

        return await self._run(_sync)

    async def list_by_kind(self, kind: str, limit: int = 100) -> list[Object]:
        """Objects whose ``props.kind`` equals ``kind``, newest first.

        Matches the PostgREST backend's ``props->>kind`` filter — workspace
        nodes (situations / maps) carry their kind in props, not the column.
        """

        def _sync() -> list[Object]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    "SELECT id, kind, props, classification, compartments,"
                    " shared, created_at FROM objects"
                    " WHERE user_id=? AND json_extract(props, '$.kind') = ?"
                    " ORDER BY created_at DESC LIMIT ?",
                    (self.ctx.user_id, kind, int(limit)),
                ).fetchall()
            finally:
                con.close()
            return [_object_from_row(r) for r in rows]

        return await self._run(_sync)

    async def search(
        self, q: str, kinds: list[str] | None = None, limit: int = 50
    ) -> list[Object]:
        """Objects matching ``q`` anywhere in their id, kind or property values,
        best match first.

        Until this existed the only way to reach an object was to already know
        its exact canonical id: ``get`` is id-exact and ``list_by_kind`` filters
        on one props field. ``/api/search/objects`` is a different thing — it
        searches the LIVE observation store, which holds only what is currently
        being emitted, not what was promoted into the graph.
        """
        match = _fts_match(q)
        if not match:
            return []

        def _sync() -> list[Object]:
            con = _connect(self.s)
            try:
                self._backfill_fts_sync(con)
                sql = (
                    "SELECT o.id, o.kind, o.props, o.classification,"
                    " o.compartments, o.shared, o.created_at"
                    " FROM objects_fts JOIN objects o"
                    "   ON o.user_id = objects_fts.user_id AND o.id = objects_fts.id"
                    " WHERE objects_fts MATCH ? AND objects_fts.user_id = ?"
                )
                params: list[Any] = [match, self.ctx.user_id]
                if kinds:
                    placeholders = ",".join("?" * len(kinds))
                    sql += f" AND o.kind IN ({placeholders})"
                    params.extend(kinds)
                sql += " ORDER BY bm25(objects_fts) LIMIT ?"
                params.append(int(limit))
                try:
                    rows = con.execute(sql, params).fetchall()
                except sqlite3.OperationalError:
                    # _fts_match is meant to make any input legal; if a query
                    # still reaches FTS5 as syntax, answering "no matches" beats
                    # a 500 on a search box.
                    log.warning("ontology search rejected by FTS5: %r", q)
                    return []
            finally:
                con.close()
            return [_object_from_row(r) for r in rows]

        return await self._run(_sync)

    def _backfill_fts_sync(self, con: sqlite3.Connection) -> None:
        """Index objects written before this table existed. Once per DB path per
        process, and only when the index is genuinely behind."""
        path = _resolved_db_path(self.s)
        if path in _fts_backfilled:
            return
        _fts_backfilled.add(path)
        (indexed,) = con.execute("SELECT COUNT(*) FROM objects_fts").fetchone()
        (total,) = con.execute("SELECT COUNT(*) FROM objects").fetchone()
        if indexed >= total:
            return
        log.info("ontology FTS backfill: %d objects", total)
        rows = con.execute("SELECT user_id, id, kind, props FROM objects").fetchall()
        con.execute("DELETE FROM objects_fts")
        for user_id, obj_id, kind, props_json in rows:
            try:
                props = json.loads(props_json)
            except (TypeError, ValueError):
                props = {}
            con.execute(
                "INSERT INTO objects_fts (id, kind, text, user_id) VALUES (?,?,?,?)",
                (obj_id, kind, _fts_text(obj_id, kind, props), user_id),
            )
        con.commit()

    async def delete(self, object_id: str) -> None:
        """Delete an object plus its assertions and touching links.

        Unlike the remote backend (no cascade in the Supabase schema), the
        local store owns all three tables, so a delete leaves no orphan edges
        or history behind. Missing row is a no-op.
        """

        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute(
                    "DELETE FROM objects WHERE user_id=? AND id=?",
                    (self.ctx.user_id, object_id),
                )
                con.execute(
                    "DELETE FROM assertions WHERE user_id=? AND object_id=?",
                    (self.ctx.user_id, object_id),
                )
                con.execute(
                    "DELETE FROM links WHERE user_id=? AND (src=? OR dst=?)",
                    (self.ctx.user_id, object_id, object_id),
                )
                _fts_delete_sync(con, self.ctx.user_id, object_id)
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    # ---- links ------------------------------------------------------------

    async def link(self, link: Link) -> Link:
        """Create an edge. Idempotent on ``(user_id, src, dst, rel)``."""

        def _sync() -> Link:
            now = _now_iso()
            observed = link.observed_at or now
            con = _connect(self.s)
            try:
                con.execute(
                    """
                    INSERT INTO links (user_id, src, dst, rel, props, source,
                      confidence, observed_at, valid_until,
                      classification, compartments, shared, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(user_id, src, dst, rel) DO UPDATE SET
                      props=excluded.props, source=excluded.source,
                      confidence=excluded.confidence,
                      observed_at=excluded.observed_at,
                      valid_until=excluded.valid_until,
                      classification=excluded.classification,
                      compartments=excluded.compartments,
                      shared=excluded.shared
                    """,
                    (
                        self.ctx.user_id,
                        link.src,
                        link.dst,
                        link.rel,
                        json.dumps(link.props),
                        link.source,
                        float(link.confidence),
                        observed,
                        link.valid_until,
                        int(link.classification),
                        json.dumps(link.compartments),
                        int(link.shared),
                        now,
                    ),
                )
                con.commit()
                row = con.execute(
                    "SELECT id, created_at FROM links"
                    " WHERE user_id=? AND src=? AND dst=? AND rel=?",
                    (self.ctx.user_id, link.src, link.dst, link.rel),
                ).fetchone()
            finally:
                con.close()
            return link.model_copy(
                update={
                    "id": str(row[0]),
                    "created_at": row[1],
                    "observed_at": observed,
                }
            )

        return await self._run(_sync)

    async def _links_touching(self, ids: list[str]) -> list[Link]:
        if not ids:
            return []

        def _sync() -> list[Link]:
            marks = ",".join("?" for _ in ids)
            con = _connect(self.s)
            try:
                rows = con.execute(
                    f"""
                    SELECT id, src, dst, rel, props, source, confidence,
                           observed_at, valid_until, classification,
                           compartments, shared, created_at
                    FROM links
                    WHERE user_id=? AND (src IN ({marks}) OR dst IN ({marks}))
                    """,
                    (self.ctx.user_id, *ids, *ids),
                ).fetchall()
            finally:
                con.close()
            out: dict[tuple[str, str, str], Link] = {}
            for r in rows:
                lk = _link_from_row(r)
                out[(lk.src, lk.dst, lk.rel)] = lk
            return list(out.values())

        return await self._run(_sync)

    # ---- assertions ---------------------------------------------------------

    async def assert_props(
        self,
        object_id: str,
        props: dict[str, Any],
        *,
        source: str,
        confidence: float = 1.0,
        observed_at: str | None = None,
        valid_until: str | None = None,
        derivation: dict[str, Any] | None = None,
    ) -> Object:
        """Merge-style evidenced write (the Phase-2 promotion-pipeline verb).

        Unlike ``upsert`` this never removes props: each given prop lands as an
        assertion (identical-latest-value deduped) and is merged into the
        materialized blob. The object row is created as a stub if absent.
        """

        def _sync() -> Object:
            now = _now_iso()
            observed = observed_at or now
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT props, created_at FROM objects"
                    " WHERE user_id=? AND id=?",
                    (self.ctx.user_id, object_id),
                ).fetchone()
                current: dict[str, Any] = json.loads(row[0]) if row else {}
                created_at = row[1] if row else now
                for prop, value in props.items():
                    self._insert_assertion_sync(
                        con,
                        object_id,
                        prop,
                        value,
                        source,
                        confidence,
                        observed,
                        valid_until,
                        derivation,
                    )
                merged = {**current, **props}
                con.execute(
                    """
                    INSERT INTO objects (user_id, id, kind, props,
                      classification, compartments, shared,
                      created_at, updated_at)
                    VALUES (?,?,?,?,0,'[]',0,?,?)
                    ON CONFLICT(user_id, id) DO UPDATE SET
                      props=excluded.props, updated_at=excluded.updated_at
                    """,
                    (
                        self.ctx.user_id,
                        object_id,
                        kind_of(object_id),
                        json.dumps(merged),
                        created_at,
                        now,
                    ),
                )
                _fts_write_sync(
                    con, self.ctx.user_id, object_id, kind_of(object_id), merged
                )
                self._enforce_object_cap_sync(con, object_id)
                con.commit()
                out = con.execute(
                    "SELECT id, kind, props, classification, compartments,"
                    " shared, created_at FROM objects WHERE user_id=? AND id=?",
                    (self.ctx.user_id, object_id),
                ).fetchone()
                self._maybe_enforce_size_cap(con)
                return _object_from_row(out)
            finally:
                con.close()

        return await self._run(_sync)

    async def get_assertions(
        self, object_id: str, prop: str | None = None, limit: int = 200
    ) -> list[Assertion]:
        """The assertion history for one object, newest first."""

        def _sync() -> list[Assertion]:
            q = (
                "SELECT id, object_id, prop, value, source, confidence,"
                " observed_at, valid_until, derivation FROM assertions"
                " WHERE user_id=? AND object_id=?"
            )
            args: list[Any] = [self.ctx.user_id, object_id]
            if prop is not None:
                q += " AND prop=?"
                args.append(prop)
            q += " ORDER BY observed_at DESC, id DESC LIMIT ?"
            args.append(int(limit))
            con = _connect(self.s)
            try:
                rows = con.execute(q, args).fetchall()
            finally:
                con.close()
            return [
                Assertion(
                    id=r[0],
                    object_id=r[1],
                    prop=r[2],
                    value=json.loads(r[3]),
                    source=r[4],
                    confidence=r[5],
                    observed_at=r[6],
                    valid_until=r[7],
                    derivation=json.loads(r[8]) if r[8] else None,
                )
                for r in rows
            ]

        return await self._run(_sync)

    # ---- internals ----------------------------------------------------------

    def _insert_assertion_sync(
        self,
        con: sqlite3.Connection,
        object_id: str,
        prop: str,
        value: Any,
        source: str,
        confidence: float,
        observed_at: str,
        valid_until: str | None,
        derivation: dict[str, Any] | None,
    ) -> None:
        """Append one assertion unless it duplicates the latest recorded value.

        Dedup is on (value, source): the same source repeating the same value
        adds nothing; a DIFFERENT source stating the same value is corroboration
        and is kept — the roadmap guard requires two sources to coexist.
        """
        encoded = _canon(value)
        is_removal = bool(isinstance(derivation, dict) and derivation.get("op") == "remove")
        last = con.execute(
            "SELECT value, source, derivation FROM assertions"
            " WHERE user_id=? AND object_id=? AND prop=?"
            " ORDER BY observed_at DESC, id DESC LIMIT 1",
            (self.ctx.user_id, object_id, prop),
        ).fetchone()
        if last is not None and last[0] == encoded and last[1] == source:
            # A removal tombstone encodes value=None as "null", the same as an
            # explicit note=null write — but they are different facts, so the
            # tombstone must not be deduped away against a prior null value (else
            # the removal never lands in the append-only provenance trail). Only a
            # true duplicate (same value, source, AND removal-ness) is dropped.
            last_deriv = json.loads(last[2]) if last[2] else None
            last_removal = bool(isinstance(last_deriv, dict) and last_deriv.get("op") == "remove")
            if last_removal == is_removal:
                return
        con.execute(
            "INSERT INTO assertions (user_id, object_id, prop, value, source,"
            " confidence, observed_at, valid_until, derivation)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (
                self.ctx.user_id,
                object_id,
                prop,
                encoded,
                source,
                float(confidence),
                observed_at,
                valid_until,
                json.dumps(derivation) if derivation is not None else None,
            ),
        )

    def _enforce_object_cap_sync(
        self, con: sqlite3.Connection, object_id: str
    ) -> None:
        cap = int(self.s.ontology_max_assertions_per_object)
        if cap <= 0:
            return
        # Chain-of-custody events (prop='custody', evidence locker) are the
        # append-only legal record — never trim them, and don't let them count
        # toward the cap that bounds noisy feed props. For every other object
        # this excludes nothing (they have no 'custody' assertions).
        (count,) = con.execute(
            "SELECT COUNT(*) FROM assertions"
            " WHERE user_id=? AND object_id=? AND prop!='custody'",
            (self.ctx.user_id, object_id),
        ).fetchone()
        excess = count - cap
        if excess > 0:
            con.execute(
                "DELETE FROM assertions WHERE id IN ("
                " SELECT id FROM assertions WHERE user_id=? AND object_id=?"
                " AND prop!='custody'"
                " ORDER BY observed_at ASC, id ASC LIMIT ?)",
                (self.ctx.user_id, object_id, excess),
            )

    def _maybe_enforce_size_cap(self, con: sqlite3.Connection) -> None:
        """Soft byte cap: drop the oldest 10% of assertions + VACUUM when the
        file outgrows ``ontology_db_max_bytes``. Cheap gate first — the size
        check runs at most once an hour or every 500 writes."""
        global _writes_since_check, _next_size_check
        _writes_since_check += 1
        now = time.time()
        if (
            _writes_since_check < _SIZE_CHECK_EVERY_WRITES
            and now < _next_size_check
        ):
            return
        _writes_since_check = 0
        _next_size_check = now + _SIZE_CHECK_EVERY_S
        max_bytes = int(self.s.ontology_db_max_bytes)
        if max_bytes <= 0:
            return
        try:
            size = Path(_resolved_db_path(self.s)).stat().st_size
        except OSError:
            return
        if size <= max_bytes:
            return
        # Never trim prop='custody' — the evidence locker's append-only legal
        # record (mirrors the per-object cap above). Evidence is captured once
        # and never re-touched, so its custody rows carry the OLDEST observed_at
        # and would otherwise be the first thing this oldest-10% prune deletes.
        # If the DB is over-cap on custody rows alone, nothing is trimmed here
        # (the operator must raise ontology_db_max_bytes or archive) — the
        # legal record wins over the soft byte cap by design.
        # Best-effort: this runs AFTER the caller's write already committed, so a
        # lock contention here (a concurrent writer holds the DB during VACUUM,
        # which needs an exclusive lock) must NOT surface as a 500 for a write that
        # already persisted. Skip this cycle; the next gated attempt retries.
        try:
            (total,) = con.execute(
                "SELECT COUNT(*) FROM assertions WHERE prop!='custody'"
            ).fetchone()
            drop = max(1, total // 10)
            con.execute(
                "DELETE FROM assertions WHERE id IN ("
                " SELECT id FROM assertions WHERE prop!='custody'"
                " ORDER BY observed_at ASC, id ASC LIMIT ?)",
                (drop,),
            )
            con.commit()
            con.execute("VACUUM")
        except sqlite3.Error:
            log.warning("ontology soft byte-cap enforcement skipped (db busy)", exc_info=True)


# ── row → model ───────────────────────────────────────────────────────────────


def _object_from_row(row: tuple[Any, ...]) -> Object:
    return Object(
        id=row[0],
        kind=row[1],
        props=json.loads(row[2]) if row[2] else {},
        classification=row[3] or 0,
        compartments=json.loads(row[4]) if row[4] else [],
        shared=bool(row[5]),
        created_at=row[6],
    )


def _link_from_row(row: tuple[Any, ...]) -> Link:
    return Link(
        id=str(row[0]),
        src=row[1],
        dst=row[2],
        rel=row[3],
        props=json.loads(row[4]) if row[4] else {},
        source=row[5],
        confidence=row[6],
        observed_at=row[7],
        valid_until=row[8],
        classification=row[9] or 0,
        compartments=json.loads(row[10]) if row[10] else [],
        shared=bool(row[11]),
        created_at=row[12],
    )
