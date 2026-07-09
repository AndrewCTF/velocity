"""Dataset ingest: CSV / JSON / NDJSON parsing, type inference, caps.

Pure stdlib (``csv``, ``json``) — no pandas. Type inference casts CSV's
all-string cells to ``int | float | bool | str`` (JSON/NDJSON already carry
typed values from ``json.loads``); the per-column ``schema`` is the union of
observed value types, matching ``docs/foundry-plan.md``.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
from typing import Any

from app.foundry.store import MAX_ROWS_PER_DATASET, MAX_UPLOAD_BYTES, FoundryError

# A canonical decimal/float: no leading zeros (except "0"/"0.x"), no leading
# '+', no underscores — forms that ``float()`` silently accepts but that carry
# information (leading-zero IDs like "007.0") we must NOT flatten. ``int`` is
# handled by an exact round-trip check instead.
_FLOAT_RE = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$")

PIN_TYPES = {"str", "int", "float", "bool"}


def _cast_scalar(raw: str) -> Any:
    """Infer a scalar type from a CSV string WITHOUT losing information.

    ``int``/``float`` are only applied when the string round-trips exactly, so
    identifier-like values that ``int()``/``float()`` would silently mangle —
    leading zeros ("007"), leading '+' ("+1"), underscores ("1_000"), padded
    refs — are preserved as ``str``. Entity resolution and ontology binding key
    on exactly these columns, so this is the difference between clean and
    silently-corrupted IDs downstream."""
    s = raw.strip()
    if s == "":
        return None
    low = s.lower()
    if low in ("true", "false"):
        return low == "true"
    try:
        i = int(s)
        if str(i) == s:  # canonical integer only — "007" != "7", stays str
            return i
    except ValueError:
        pass
    if _FLOAT_RE.match(s):
        try:
            f = float(s)
            # "1e999" parses to inf without raising — that neither round-trips
            # nor survives JSON serialization (Starlette rejects inf), so keep
            # the original string instead of silently corrupting it.
            if math.isfinite(f):
                return f
        except ValueError:
            pass
    return raw


def _coerce_to(value: Any, type_: str) -> Any:
    """Force ``value`` to a pinned type; unconvertible values become ``None``
    (str-pin never fails). Used by operator column type-pinning on upload."""
    if value is None:
        return None
    if type_ == "str":
        return value if isinstance(value, str) else _scalar_to_str(value)
    if type_ == "bool":
        if isinstance(value, bool):
            return value
        low = str(value).strip().lower()
        if low in ("true", "1", "yes", "y"):
            return True
        if low in ("false", "0", "no", "n"):
            return False
        return None
    if type_ == "int":
        try:
            if isinstance(value, str):
                # Exact integer string first (preserves big ints); else route
                # through float so scientific notation ("1e3") and decimals
                # ("1.9") coerce consistently instead of "1e3" dropping to None.
                try:
                    return int(value)
                except ValueError:
                    return int(float(value))
            return int(value)
        except (ValueError, TypeError, OverflowError):
            return None
    if type_ == "float":
        try:
            f = float(value)
            # Same non-finite guard as _cast_scalar: inf/nan break JSON
            # serialization (Starlette rejects them), so drop to None.
            return f if math.isfinite(f) else None
        except (ValueError, TypeError):
            return None
    return value


def _scalar_to_str(value: Any) -> str:
    # bool must not stringify to Python's "True"/"False" surprises silently —
    # keep JSON-ish lowercase for pinned string columns.
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def apply_type_pins(
    rows: list[dict[str, Any]],
    schema: list[dict[str, str]],
    pins: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Override the inferred type of named columns (operator type-pinning). A
    pin of ``str`` protects ID columns (MMSI/ICAO24/ZIP) that would otherwise
    infer as ``int``. Returns ``(rows, schema)`` with pinned columns coerced
    and their schema type set. Unknown pin types raise 422."""
    bad = {t for t in pins.values() if t not in PIN_TYPES}
    if bad:
        raise FoundryError(
            422, f"unknown pin type(s) {sorted(bad)}; must be one of {sorted(PIN_TYPES)}"
        )
    if not pins:
        return rows, schema
    out_rows = [
        {k: (_coerce_to(v, pins[k]) if k in pins else v) for k, v in r.items()} for r in rows
    ]
    out_schema = [
        {**col, "type": pins[col["name"]]} if col["name"] in pins else col for col in schema
    ]
    return out_rows, out_schema


def parse_csv(text: str) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(text))
    rows: list[dict[str, Any]] = []
    for raw_row in reader:
        rows.append(
            {
                k: (_cast_scalar(v) if isinstance(v, str) else v)
                for k, v in raw_row.items()
                if k is not None
            }
        )
    return rows


def parse_json_array(text: str) -> list[dict[str, Any]]:
    data = json.loads(text)
    if not isinstance(data, list):
        raise FoundryError(422, "JSON upload must be an array of objects")
    for item in data:
        if not isinstance(item, dict):
            raise FoundryError(422, "JSON upload must be an array of objects")
    return data


def parse_ndjson(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        if not isinstance(item, dict):
            raise FoundryError(422, "NDJSON lines must each be an object")
        rows.append(item)
    return rows


def _value_type(v: Any) -> str:
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    return "str"


def infer_schema(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    """``[{name, type}]`` — column order = first-seen order across rows."""
    columns: list[str] = []
    seen: set[str] = set()
    for r in rows:
        for k in r:
            if k not in seen:
                seen.add(k)
                columns.append(k)
    schema: list[dict[str, str]] = []
    for col in columns:
        types: set[str] = set()
        for r in rows:
            v = r.get(col)
            if v is None:
                continue
            types.add(_value_type(v))
        if not types:
            t = "str"
        elif types == {"int"}:
            t = "int"
        elif types <= {"int", "float"}:
            t = "float"
        elif types == {"bool"}:
            t = "bool"
        else:
            t = "str"
        schema.append({"name": col, "type": t})
    return schema


def parse_upload(
    filename: str, content: bytes
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Parse an uploaded file into ``(rows, schema)``.

    Enforces the 25 MB size cap and the 200k row cap (413 / 422 respectively —
    the route layer maps ``FoundryError.status_code``). Format is chosen by
    extension: ``.csv`` → CSV, ``.ndjson``/``.jsonl`` → NDJSON, else JSON array.
    """
    if len(content) > MAX_UPLOAD_BYTES:
        raise FoundryError(
            413, f"upload too large: {len(content)} bytes > {MAX_UPLOAD_BYTES}"
        )
    text = content.decode("utf-8", errors="replace")
    name = filename.lower()
    try:
        if name.endswith(".csv"):
            rows = parse_csv(text)
        elif name.endswith(".ndjson") or name.endswith(".jsonl"):
            rows = parse_ndjson(text)
        elif name.endswith(".json"):
            rows = parse_json_array(text)
        else:
            # Fall back to sniffing: valid JSON array first, else CSV.
            stripped = text.lstrip()
            if stripped.startswith("["):
                rows = parse_json_array(text)
            else:
                rows = parse_csv(text)
    except FoundryError:
        raise
    except (json.JSONDecodeError, csv.Error, ValueError) as exc:
        # Malformed user content is a 422, not an uncaught 500.
        raise FoundryError(422, f"could not parse upload: {exc}") from exc
    if len(rows) > MAX_ROWS_PER_DATASET:
        raise FoundryError(
            422, f"row cap exceeded: {len(rows)} > {MAX_ROWS_PER_DATASET}"
        )
    schema = infer_schema(rows)
    return rows, schema
