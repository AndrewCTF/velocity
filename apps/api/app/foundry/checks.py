"""Data expectations (checks) — dataset-level quality gates evaluated whenever
a new version is about to be written (upload/append/rollback/transform build).
Pure functions, same idiom as ``transforms.py``: no DB access here, the store
owns persistence and enforcement ordering.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from typing import Any

from app.foundry.store import FoundryError

CHECK_TYPES = {
    "row_count_min",
    "row_count_max",
    "not_null",
    "unique",
    "column_exists",
    "freshness",
    "schema_contract",
}
SEVERITIES = {"warn", "fail"}
_PIN_TYPES = {"int", "float", "bool", "str"}


def _normalize_epoch(e: float) -> float:
    """Collapse a millisecond / microsecond / nanosecond epoch to seconds — a
    very common feed shape (JS ``Date.now()`` exports ms). A real second-epoch
    is ~1.7e9; anything ≥1e11 s (year ~5138) is almost certainly a finer unit."""
    a = abs(e)
    if a >= 1e17:
        return e / 1e9  # nanoseconds
    if a >= 1e14:
        return e / 1e6  # microseconds
    if a >= 1e11:
        return e / 1e3  # milliseconds
    return e


def _to_epoch(v: Any) -> float | None:
    """Parse a cell as a UTC epoch (seconds) — accepts a numeric epoch (or
    numeric string, ms/µs/ns normalized) or an ISO-8601 string (trailing ``Z``
    tolerated). Returns None if unparseable."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return _normalize_epoch(float(v))
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return _normalize_epoch(float(s))
        except ValueError:
            pass
        try:
            iso = s[:-1] + "+00:00" if s.endswith("Z") else s
            dt = datetime.fromisoformat(iso)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return dt.timestamp()
        except ValueError:
            return None
    return None


def _matches_type(v: Any, t: str) -> bool:
    """Does a concrete cell value satisfy a contract type? int accepts
    integer-valued floats (1.0); float accepts ints; str accepts anything —
    so drift is judged on ACTUAL values, not the lossy per-version inference."""
    if t == "str":
        return True
    if t == "bool":
        return isinstance(v, bool)
    if t == "int":
        if isinstance(v, bool):
            return False
        if isinstance(v, int):
            return True
        return isinstance(v, float) and v.is_integer()
    if t == "float":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    return True


def validate_check(type_: str, params: dict[str, Any], severity: str = "warn") -> None:
    """Raise ``FoundryError(422, ...)`` if the check type/params/severity are
    not well-formed. Called on create and update."""
    if severity not in SEVERITIES:
        raise FoundryError(
            422, f"unknown severity {severity!r}; must be one of {sorted(SEVERITIES)}"
        )
    if type_ not in CHECK_TYPES:
        raise FoundryError(
            422, f"unknown check type {type_!r}; must be one of {sorted(CHECK_TYPES)}"
        )
    if type_ == "row_count_min":
        v = params.get("min")
        if not isinstance(v, int) or isinstance(v, bool):
            raise FoundryError(422, "row_count_min requires integer param 'min'")
    elif type_ == "row_count_max":
        v = params.get("max")
        if not isinstance(v, int) or isinstance(v, bool):
            raise FoundryError(422, "row_count_max requires integer param 'max'")
    elif type_ in ("not_null", "unique", "column_exists"):
        col = params.get("column")
        if not isinstance(col, str) or not col:
            raise FoundryError(422, f"{type_} requires string param 'column'")
    elif type_ == "freshness":
        col = params.get("column")
        if not isinstance(col, str) or not col:
            raise FoundryError(422, "freshness requires string param 'column'")
        age = params.get("max_age_s")
        if not isinstance(age, (int, float)) or isinstance(age, bool) or age <= 0:
            raise FoundryError(422, "freshness requires positive number param 'max_age_s'")
    elif type_ == "schema_contract":
        cols = params.get("columns")
        ok_cols = isinstance(cols, list) and cols and all(isinstance(c, str) and c for c in cols)
        if not ok_cols:
            raise FoundryError(
                422, "schema_contract requires a non-empty string list param 'columns'"
            )
        types = params.get("types")
        if types is not None:
            if not isinstance(types, dict) or not all(
                isinstance(k, str) and v in _PIN_TYPES for k, v in types.items()
            ):
                raise FoundryError(
                    422,
                    f"schema_contract 'types' must map column->one of {sorted(_PIN_TYPES)}",
                )


def evaluate_check(
    type_: str,
    params: dict[str, Any],
    rows: list[dict[str, Any]],
    schema: list[dict[str, str]],
) -> tuple[bool, str]:
    """Run one check against candidate rows/schema. Returns ``(passed, detail)``."""
    if type_ == "row_count_min":
        m = params["min"]
        n = len(rows)
        ok = n >= m
        return ok, f"row_count={n}, min={m}"
    if type_ == "row_count_max":
        m = params["max"]
        n = len(rows)
        ok = n <= m
        return ok, f"row_count={n}, max={m}"
    if type_ == "not_null":
        col = params["column"]
        nulls = sum(1 for r in rows if r.get(col) is None)
        ok = nulls == 0
        return ok, f"{nulls} null value(s) in column {col!r}"
    if type_ == "unique":
        col = params["column"]
        counts: dict[str, int] = {}
        for r in rows:
            v = r.get(col)
            if v is None:
                continue
            key = json.dumps(v, sort_keys=True)
            counts[key] = counts.get(key, 0) + 1
        dupes = sum(c - 1 for c in counts.values() if c > 1)
        ok = dupes == 0
        return ok, f"{dupes} duplicate value(s) in column {col!r}"
    if type_ == "column_exists":
        col = params["column"]
        ok = any(c.get("name") == col for c in schema)
        return ok, f"column {col!r} {'present' if ok else 'missing'}"
    if type_ == "freshness":
        col = params["column"]
        max_age = params["max_age_s"]
        now = time.time()
        skew = 300.0  # tolerate small clock skew; drop far-future typo/outlier cells
        epochs = [
            e
            for e in (_to_epoch(r.get(col)) for r in rows)
            if e is not None and e <= now + skew
        ]
        if not epochs:
            return False, f"no valid (non-future) timestamps in column {col!r}"
        age = now - max(epochs)
        ok = age <= max_age
        return ok, f"newest row {int(age)}s old (max {int(max_age)}s) in {col!r}"
    if type_ == "schema_contract":
        want_cols: list[str] = params["columns"]
        want_types: dict[str, str] = params.get("types") or {}
        present = {c.get("name") for c in schema}
        missing = [c for c in want_cols if c not in present]
        # Judge type drift on ACTUAL cell values (all-null column this batch =
        # no violation; int-valued floats satisfy an int contract) so lossy
        # per-version inference can't false-fail a legitimate write.
        mism: list[str] = []
        for c, t in want_types.items():
            if c not in present:
                continue
            non_null = [r.get(c) for r in rows if r.get(c) is not None]
            if non_null and not all(_matches_type(v, t) for v in non_null):
                mism.append(f"{c}!={t}")
        ok = not missing and not mism
        parts = []
        if missing:
            parts.append(f"missing {missing}")
        if mism:
            parts.append(f"type drift {mism}")
        return ok, "; ".join(parts) if parts else "schema matches contract"
    # pragma: no cover — validated by validate_check() before this ever runs
    raise FoundryError(422, f"unknown check type: {type_!r}")
