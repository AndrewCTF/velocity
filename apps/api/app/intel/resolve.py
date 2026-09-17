"""Entity resolution — a canonical-identity INDEX over source identifiers.

Velocity's live layers key everything by a single, churny id: a vessel is
``vessel:<mmsi>`` and an aircraft is ``aircraft:<icao24>``. But a vessel's MMSI
changes (re-flagging, re-registration) while its IMO (hull number) never does,
and AIS static data carries IMO + name + callsign alongside the MMSI. Without
resolution, the same real-world vessel observed under two MMSIs is two
unrelated objects and its history is fragmented.

This module is a **non-destructive index**: it does NOT re-key ``positions`` or
the ontology. It maintains an alias graph and answers ``canonical_of(id)`` /
``aliases_of(canonical)`` so a dossier can gather a vessel's whole history
across MMSI changes under one identity, consulted at query time.

Resolution is **deterministic-first** — strong immutable ids resolve the bulk
with zero ML (vessel ``IMO > MMSI > name+callsign``; aircraft
``ICAO24 > registration > callsign``). A conflict between two STRONG ids is
recorded in ``merge_candidates`` for human review and **never auto-merged**: a
false merge = misattribution, the cardinal OSINT sin both Gotham reports stress.

Storage shares ``history.db`` (one file to back up / prune) but uses its own
tables + connection. Functions are synchronous SQLite ops (microseconds); the
ingestion hook offloads to an executor like ``history.py``.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from app.config import get_settings

log = logging.getLogger(__name__)

# ── resolution priority (strongest identifier first) ───────────────────────────
# STRONG ids are immutable real-world keys (hull / airframe). Two records sharing
# a STRONG id ARE the same entity; two DIFFERENT strong values on one identity is
# a conflict, not a merge.
_PRIORITY: dict[str, list[str]] = {
    "vessel": ["imo", "mmsi", "callsign", "name"],
    "aircraft": ["icao24", "registration", "callsign"],
}
_STRONG: frozenset[str] = frozenset(("imo", "icao24"))

_db_path_override: str | None = None


def override_db_path(path: str | None) -> None:
    """Set a custom DB path (tests). Pass None to clear."""
    global _db_path_override
    _db_path_override = path


#: The shipped default of ``Settings.history_db_path``. An operator who pointed
#: history somewhere else did so deliberately, and the alias graph keeps
#: following it — only the DEFAULT path is the one we stop sharing.
_DEFAULT_HISTORY_DB = "./data/history.db"


def _resolved_db_path() -> str:
    """Where the alias graph lives.

    It used to be ``history.db`` unconditionally (see the module docstring:
    "one file to back up / prune"). Once the position archive can move to
    Postgres + TimescaleDB, that file stops being written at all — so a store
    that is still SQLite needs a path of its own, or resolution quietly follows
    the archive out of existence.

    The rule, in order:

    1. a test override wins;
    2. a non-default ``history_db_path`` is honoured verbatim — the operator
       aimed history at that file and the alias graph goes with it;
    3. an EXISTING ``./data/history.db`` keeps being used, because that is where
       an installed box's alias graph already is and moving it would strand it;
    4. otherwise a fresh, separate ``./data/resolve.db``.
    """
    if _db_path_override is not None:
        return _db_path_override
    configured = get_settings().history_db_path
    if configured != _DEFAULT_HISTORY_DB:
        return configured
    legacy = Path(configured)
    if legacy.exists():
        return str(legacy)
    return str(legacy.parent / "resolve.db")


def _connect() -> sqlite3.Connection:
    path = _resolved_db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS entities (
            canonical_id TEXT PRIMARY KEY,
            kind         TEXT NOT NULL,
            display_name TEXT,
            props        TEXT NOT NULL DEFAULT '{}',
            first_seen   REAL NOT NULL,
            last_seen    REAL NOT NULL
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS aliases (
            id_type      TEXT NOT NULL,
            id_value     TEXT NOT NULL,
            canonical_id TEXT NOT NULL,
            source       TEXT,
            first_seen   REAL NOT NULL,
            PRIMARY KEY (id_type, id_value)
        )
        """
    )
    con.execute("CREATE INDEX IF NOT EXISTS idx_alias_canon ON aliases (canonical_id)")
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS merge_candidates (
            id_a   TEXT NOT NULL,
            id_b   TEXT NOT NULL,
            reason TEXT NOT NULL,
            ts     REAL NOT NULL,
            PRIMARY KEY (id_a, id_b)
        )
        """
    )
    # A candidate row used to carry no score or review state at all — added
    # idempotently (PRAGMA table_info idiom, see app/audit.py:113) so an
    # existing merge_candidates table from before this wave gains the review
    # queue's columns without losing its rows.
    cols = {r[1] for r in con.execute("PRAGMA table_info(merge_candidates)")}
    for col, decl in (
        ("score", "REAL NOT NULL DEFAULT 0"),
        ("status", "TEXT NOT NULL DEFAULT 'open'"),
        ("decided_by", "TEXT"),
        ("decided_at", "REAL"),
    ):
        if col not in cols:
            con.execute(f"ALTER TABLE merge_candidates ADD COLUMN {col} {decl}")
    con.commit()
    return con


# ── helpers ────────────────────────────────────────────────────────────────────

def _norm(identifiers: dict[str, Any]) -> dict[str, str]:
    """Lowercase keys, stringify values, drop empties/None."""
    out: dict[str, str] = {}
    for k, v in identifiers.items():
        if v is None:
            continue
        sv = str(v).strip()
        if sv:
            out[k.lower()] = sv
    return out


def _ordered(kind: str, ids: dict[str, str]) -> list[tuple[str, str]]:
    """Present (id_type, id_value) pairs in resolution priority order."""
    order = _PRIORITY.get(kind, [])
    ranked = [(t, ids[t]) for t in order if t in ids]
    # any identifier types not in the priority list come last, stable
    extra = [(t, v) for t, v in ids.items() if t not in order]
    return ranked + extra


def _mint(kind: str, ordered: list[tuple[str, str]]) -> str:
    """Mint a canonical id from the strongest present identifier.

    Keeps the repo's existing scheme where it's already canonical
    (``aircraft:<icao24>``, ``vessel:<mmsi>``) so resolution bridges live ids,
    and only introduces an ``entity:`` id when a stronger key (IMO) is present.
    """
    strongest_type, strongest_val = ordered[0]
    if kind == "vessel" and strongest_type == "imo":
        return f"entity:vessel:imo:{strongest_val}"
    if kind == "vessel" and strongest_type == "mmsi":
        return f"vessel:{strongest_val}"
    if kind == "aircraft" and strongest_type == "icao24":
        return f"aircraft:{strongest_val}"
    return f"entity:{kind}:{strongest_type}:{strongest_val}"


def _display_name(con: sqlite3.Connection, canonical_id: str) -> str | None:
    row = con.execute(
        "SELECT display_name FROM entities WHERE canonical_id=?", (canonical_id,)
    ).fetchone()
    return row[0] if row and row[0] else None


def _conflict_score(con: sqlite3.Connection, a: str, b: str, reason: str) -> float:
    """How likely ``a`` and ``b`` are the SAME real entity, for operator triage.

    Two different canonicals attached to one presented id (``multiple_canonicals``)
    is the strongest signal something really did collide — 0.7. A contradicting
    STRONG id (``conflicting_imo`` / ``conflicting_icao24`` — the only reasons
    this prefix names, see ``resolve()``) more often means two genuinely
    different real-world objects that happen to share a weaker id, so it scores
    lower — 0.3. Everything else (an already-aliased id pointing elsewhere) is
    weakest — 0.2. A name-similarity bonus (0 when either side has no known
    display name) can push either band up, never past 1.0.
    """
    if reason == "multiple_canonicals":
        base = 0.7
    elif reason.startswith("conflicting_"):
        base = 0.3
    else:
        base = 0.2
    na, nb = _display_name(con, a), _display_name(con, b)
    name_ratio = SequenceMatcher(None, na, nb).ratio() if na and nb else 0.0
    return max(0.0, min(1.0, base + 0.3 * name_ratio))


def _record_conflict(con: sqlite3.Connection, a: str, b: str, reason: str, ts: float) -> None:
    lo, hi = sorted((a, b))
    score = _conflict_score(con, a, b, reason)
    con.execute(
        "INSERT OR IGNORE INTO merge_candidates (id_a, id_b, reason, ts, score) "
        "VALUES (?,?,?,?,?)",
        (lo, hi, reason, ts, score),
    )


# ── public API ───────────────────────────────────────────────────────────────

def resolve(kind: str, identifiers: dict[str, Any]) -> str:
    """Upsert the alias graph for one observed record; return its canonical id.

    Deterministic. If a present id already maps to a canonical, that canonical is
    REUSED (stable ids outrank a prettier scheme). A present id mapping to a
    *different* canonical, or a new STRONG id contradicting the chosen
    canonical's existing strong value, is recorded as a ``merge_candidate`` and
    never auto-merged.
    """
    ids = _norm(identifiers)
    if not ids:
        raise ValueError("resolve() needs at least one identifier")
    ordered = _ordered(kind, ids)
    now = time.time()

    con = _connect()
    try:
        # 1. Look up which present ids are already known, and to what canonical.
        found: list[tuple[str, str, str]] = []  # (id_type, id_value, canonical)
        for id_type, id_value in ordered:
            row = con.execute(
                "SELECT canonical_id FROM aliases WHERE id_type=? AND id_value=?",
                (id_type, id_value),
            ).fetchone()
            if row:
                found.append((id_type, id_value, row[0]))

        canonicals = {c for *_, c in found}
        if not canonicals:
            canonical = _mint(kind, ordered)
        else:
            # Reuse an existing canonical. Prefer the one tied to the
            # highest-priority present id (found is already priority-ordered).
            canonical = found[0][2]
            # >1 distinct canonical among present ids = different entities collided.
            for *_, other in found:
                if other != canonical:
                    _record_conflict(
                        con, canonical, other, "multiple_canonicals", now
                    )

        # 2. Attach every present id to the chosen canonical.
        #    - already → this canonical: nothing to do.
        #    - already → a different canonical: conflict (don't overwrite).
        #    - new STRONG id contradicting the canonical's existing strong value:
        #      conflict (don't attach the contradicting strong id).
        existing_strong = {
            r[0]: r[1]
            for r in con.execute(
                "SELECT id_type, id_value FROM aliases "
                "WHERE canonical_id=? AND id_type IN ({})".format(
                    ",".join("?" * len(_STRONG))
                ),
                (canonical, *sorted(_STRONG)),
            ).fetchall()
        }
        for id_type, id_value in ordered:
            row = con.execute(
                "SELECT canonical_id FROM aliases WHERE id_type=? AND id_value=?",
                (id_type, id_value),
            ).fetchone()
            if row is not None:
                if row[0] != canonical:
                    _record_conflict(
                        con, canonical, row[0], f"alias_{id_type}", now
                    )
                continue
            if id_type in _STRONG and id_type in existing_strong \
                    and existing_strong[id_type] != id_value:
                # e.g. canonical already has imo=X, this record says imo=Y.
                _record_conflict(
                    con,
                    f"{id_type}:{existing_strong[id_type]}",
                    f"{id_type}:{id_value}",
                    f"conflicting_{id_type}",
                    now,
                )
                continue
            con.execute(
                "INSERT INTO aliases (id_type, id_value, canonical_id, source, first_seen) "
                "VALUES (?,?,?,?,?)",
                (id_type, id_value, canonical, identifiers.get("source"), now),
            )

        # 3. Upsert the entity row (display_name from name if we have one).
        display = ids.get("name")
        con.execute(
            """
            INSERT INTO entities (canonical_id, kind, display_name, props, first_seen, last_seen)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(canonical_id) DO UPDATE SET
                last_seen = excluded.last_seen,
                display_name = COALESCE(entities.display_name, excluded.display_name)
            """,
            (canonical, kind, display, "{}", now, now),
        )
        con.commit()
        return canonical
    finally:
        con.close()


def canonical_of(any_id: str) -> str:
    """Resolve a live/canonical id (``vessel:<mmsi>``, ``aircraft:<icao24>``) to
    its canonical identity. Unknown ids resolve to themselves (already canonical
    or simply not yet seen)."""
    if not any_id:
        return any_id
    if any_id.startswith("entity:"):
        return any_id
    prefix, _, rest = any_id.partition(":")
    id_type = {"vessel": "mmsi", "aircraft": "icao24"}.get(prefix)
    if not id_type or not rest:
        return any_id
    con = _connect()
    try:
        row = con.execute(
            "SELECT canonical_id FROM aliases WHERE id_type=? AND id_value=?",
            (id_type, rest),
        ).fetchone()
        return row[0] if row else any_id
    finally:
        con.close()


def aliases_of(canonical_id: str) -> list[dict[str, str]]:
    """All source identifiers fused under one identity.

    Returns ``[{"type": "mmsi", "value": "...", "source": "..."}, ...]`` — what a
    dossier uses to gather a vessel's whole MMSI history under one entity.
    """
    con = _connect()
    try:
        rows = con.execute(
            "SELECT id_type, id_value, source FROM aliases "
            "WHERE canonical_id=? ORDER BY first_seen",
            (canonical_id,),
        ).fetchall()
        return [{"type": t, "value": v, "source": s or ""} for t, v, s in rows]
    finally:
        con.close()


def list_candidates(status: str = "open", limit: int = 100) -> list[dict[str, Any]]:
    """The scored merge-review queue the Inbox polls, highest score first.

    ``status`` filters to one review state (``open`` / ``approved`` /
    ``rejected``); falsy filters to none, returning every candidate.
    """
    con = _connect()
    try:
        if status:
            rows = con.execute(
                "SELECT id_a, id_b, reason, score, ts, status FROM merge_candidates "
                "WHERE status=? ORDER BY score DESC, ts DESC LIMIT ?",
                (status, limit),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT id_a, id_b, reason, score, ts, status FROM merge_candidates "
                "ORDER BY score DESC, ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for id_a, id_b, reason, score, ts, st in rows:
            a_row = con.execute(
                "SELECT kind, display_name FROM entities WHERE canonical_id=?", (id_a,)
            ).fetchone()
            b_row = con.execute(
                "SELECT kind, display_name FROM entities WHERE canonical_id=?", (id_b,)
            ).fetchone()
            out.append(
                {
                    "id_a": id_a,
                    "id_b": id_b,
                    "reason": reason,
                    "score": score,
                    "ts": ts,
                    "status": st,
                    "a_kind": a_row[0] if a_row else None,
                    "a_name": a_row[1] if a_row else None,
                    "b_kind": b_row[0] if b_row else None,
                    "b_name": b_row[1] if b_row else None,
                }
            )
        return out
    finally:
        con.close()


def decide(id_a: str, id_b: str, verdict: str, who: str) -> dict[str, Any]:
    """An operator's call on one candidate. Never called by ``resolve()`` itself
    — this is the ONLY path a merge candidate can turn into an actual merge.

    ``approve`` repoints every alias of ``id_b`` (the loser) onto ``id_a`` (the
    winner) and drops the loser's ``entities`` row; ``reject`` only marks the
    candidate so it stops surfacing in the open queue. The candidate is looked
    up by the unordered pair (``merge_candidates`` stores it sorted), but
    ``id_a``/``id_b`` as GIVEN decide who wins — the caller's, not the table's,
    order.
    """
    if verdict not in ("approve", "reject"):
        raise ValueError("verdict must be 'approve' or 'reject'")
    lo, hi = sorted((id_a, id_b))
    now = time.time()
    con = _connect()
    try:
        row = con.execute(
            "SELECT status FROM merge_candidates WHERE id_a=? AND id_b=?", (lo, hi)
        ).fetchone()
        if row is None:
            raise KeyError(f"no merge candidate for {id_a} / {id_b}")
        new_status = "approved" if verdict == "approve" else "rejected"
        con.execute(
            "UPDATE merge_candidates SET status=?, decided_by=?, decided_at=? "
            "WHERE id_a=? AND id_b=?",
            (new_status, who, now, lo, hi),
        )
        if verdict == "approve":
            winner, loser = id_a, id_b
            con.execute(
                "UPDATE aliases SET canonical_id=? WHERE canonical_id=?", (winner, loser)
            )
            con.execute("DELETE FROM entities WHERE canonical_id=?", (loser,))
        con.commit()
        return {"id_a": id_a, "id_b": id_b, "verdict": verdict, "status": new_status}
    finally:
        con.close()


def stats() -> dict[str, Any]:
    """Diagnostics for /api/intel/sources + the data_sources MCP tool, plus the
    merge-review queue's open/approved/rejected counts (/api/status/provenance)."""
    con = _connect()
    try:
        entities = con.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
        aliases = con.execute("SELECT COUNT(*) FROM aliases").fetchone()[0]
        conflicts = con.execute("SELECT COUNT(*) FROM merge_candidates").fetchone()[0]
        by_status = {"open": 0, "approved": 0, "rejected": 0}
        for st, cnt in con.execute(
            "SELECT status, COUNT(*) FROM merge_candidates GROUP BY status"
        ).fetchall():
            by_status[st] = cnt
        return {
            "entities": entities,
            "aliases": aliases,
            "merge_candidates": conflicts,
            **by_status,
        }
    finally:
        con.close()
