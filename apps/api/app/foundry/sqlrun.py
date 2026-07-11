"""Read-only SQL over in-memory row sets.

Shared by the Foundry SQL console (`POST /api/foundry/sql`) and the Workflows
`op.sql` block. Rows are loaded into a throwaway in-memory sqlite database, the
query runs under ``PRAGMA query_only=ON`` with an interrupt-based timeout, and
results come back as plain dicts. Only a single SELECT/WITH statement is
accepted — this is a query surface, never a write surface.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from typing import Any

MAX_RESULT_ROWS = 50_000
_DEFAULT_TIMEOUT_S = 10.0
_IDENT_RE = re.compile(r"[^a-z0-9_]+")


class SqlError(ValueError):
    """User-facing SQL rejection or execution failure."""


def slug_ident(name: str) -> str:
    """Slugify a dataset/table name into a safe SQL identifier."""
    ident = _IDENT_RE.sub("_", (name or "").strip().lower()).strip("_") or "t"
    if ident[0].isdigit():
        ident = f"t_{ident}"
    return ident[:64]


def _strip_leading_comments(sql: str) -> str:
    s = sql.lstrip()
    while True:
        if s.startswith("--"):
            nl = s.find("\n")
            if nl < 0:
                return ""
            s = s[nl + 1 :].lstrip()
        elif s.startswith("/*"):
            end = s.find("*/")
            if end < 0:
                return ""
            s = s[end + 2 :].lstrip()
        else:
            return s


def _guard_query(query: str) -> str:
    q = (query or "").strip().rstrip(";").strip()
    if not q:
        raise SqlError("empty query")
    head = _strip_leading_comments(q)
    if not re.match(r"(?i)^(select|with)\b", head):
        raise SqlError("only SELECT/WITH queries are allowed")
    # sqlite3 raises ProgrammingError on multi-statement strings passed to
    # execute(); rstrip above removed the trailing terminator so an embedded
    # second statement still errors rather than silently running.
    return q


def _cell(value: Any) -> Any:
    if value is None or isinstance(value, (int, float, str)):
        return value
    if isinstance(value, bool):  # pragma: no cover - bool is int subclass
        return int(value)
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def _load_table(conn: sqlite3.Connection, name: str, rows: list[dict[str, Any]]) -> None:
    cols: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row:
            if key not in seen:
                seen.add(key)
                cols.append(key)
    if not cols:
        cols = ["value"]
    col_sql = ", ".join(f'"{c}"' for c in cols)
    conn.execute(f'CREATE TABLE "{name}" ({col_sql})')
    placeholders = ", ".join("?" for _ in cols)
    conn.executemany(
        f'INSERT INTO "{name}" VALUES ({placeholders})',
        ([_cell(row.get(c)) for c in cols] for row in rows),
    )


def run_sql(
    query: str,
    tables: dict[str, list[dict[str, Any]]],
    *,
    timeout_s: float = _DEFAULT_TIMEOUT_S,
    max_rows: int = MAX_RESULT_ROWS,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Run one read-only query over ``tables`` ({table_name: rows}).

    Returns (rows, column_names). Raises SqlError on rejection, timeout, or a
    sqlite-level failure. Synchronous — call via ``asyncio.to_thread`` from
    request handlers.
    """
    q = _guard_query(query)
    conn = sqlite3.connect(":memory:")
    timer: threading.Timer | None = None
    try:
        for name, rows in tables.items():
            _load_table(conn, slug_ident(name), rows)
        conn.execute("PRAGMA query_only=ON")
        timer = threading.Timer(max(0.1, timeout_s), conn.interrupt)
        timer.start()
        try:
            cur = conn.execute(q)
            cols = [d[0] for d in cur.description or []]
            fetched = cur.fetchmany(max_rows + 1)
        except sqlite3.OperationalError as exc:
            if "interrupted" in str(exc).lower():
                raise SqlError(f"query timed out after {timeout_s:g}s") from exc
            raise SqlError(str(exc)) from exc
        except sqlite3.Error as exc:
            raise SqlError(str(exc)) from exc
        if len(fetched) > max_rows:
            fetched = fetched[:max_rows]
        return [dict(zip(cols, row, strict=True)) for row in fetched], cols
    finally:
        if timer is not None:
            timer.cancel()
        conn.close()
