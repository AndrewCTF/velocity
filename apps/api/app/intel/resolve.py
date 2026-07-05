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


def _resolved_db_path() -> str:
    if _db_path_override is not None:
        return _db_path_override
    return get_settings().history_db_path


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


def _record_conflict(con: sqlite3.Connection, a: str, b: str, reason: str, ts: float) -> None:
    lo, hi = sorted((a, b))
    con.execute(
        "INSERT OR IGNORE INTO merge_candidates (id_a, id_b, reason, ts) VALUES (?,?,?,?)",
        (lo, hi, reason, ts),
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


def stats() -> dict[str, Any]:
    """Diagnostics for /api/intel/sources + the data_sources MCP tool."""
    con = _connect()
    try:
        entities = con.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
        aliases = con.execute("SELECT COUNT(*) FROM aliases").fetchone()[0]
        conflicts = con.execute("SELECT COUNT(*) FROM merge_candidates").fetchone()[0]
        return {"entities": entities, "aliases": aliases, "merge_candidates": conflicts}
    finally:
        con.close()
