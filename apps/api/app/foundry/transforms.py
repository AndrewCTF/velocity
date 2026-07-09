"""Transform step DSL executor + safe ``ast``-whitelist expression evaluator.

Steps (``docs/foundry-plan.md``): select, rename, filter, derive, join,
aggregate, union, sort, limit. Expressions (``filter``/``derive``) run through
a strict ``ast`` whitelist — no ``eval``/``exec``, no attribute access, no
dunder names — so an uploaded dataset's column values can never smuggle in
arbitrary Python execution via a transform's expression string.
"""

from __future__ import annotations

import ast
import calendar
import functools
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from app.foundry.store import FoundryError

Row = dict[str, Any]

# ── safe expression evaluator ─────────────────────────────────────────────────

_MAX_PATTERN_LEN = 500
# Cap the read-only search window for match/extract. (regex_replace runs on the
# full value — see _regex_replace — so it never truncates output data.)
_MAX_REGEX_INPUT_LEN = 100_000
# Cap str/list repetition (`x * n`) so a data-controlled multiplier can't OOM.
_MAX_SEQ_REPEAT = 10_000_000

# ── catastrophic-backtracking (ReDoS) detector ────────────────────────────────
# ``re`` has no timeout and does not release the GIL during matching, and
# transform steps can run off the main thread where ``signal.alarm`` is
# unavailable — so a catastrophic pattern like (a+)+ against even a ~30-char
# value hangs the process (exponential in the matched-run length, NOT in the
# pattern length — the 500-char pattern cap does not bound it). Two layers of
# defense, since a purely structural detector cannot be complete:
#   1. The regex-func pattern argument MUST be a string LITERAL (enforced in
#      `_validate`) — a dataset column value can never supply the pattern, so
#      the only author is the operator and the literal is screened at SAVE time.
#   2. This STRUCTURAL detector (balanced-paren aware) rejects a group followed
#      by an unbounded quantifier whose body ENDS in, or STARTS with, an
#      unbounded-quantified atom — covering (a+)+, ((a+))+, (a+?)+ (lazy),
#      (\w+\s?)+ (trailing-optional). It does NOT false-positive on anchored
#      ((ab*c)+) or bounded ((a{2,5})+, (\d{3}-){2}) patterns. Because rejection
#      now RAISES at save time (loud), we bias toward catching more.
# Residual (operator footgun only, documented): overlapping-alternation shapes
# like (a|a)+ are not structurally caught; a hand-crafted evil literal can still
# hang this single-operator local process, same class as writing an infinite
# loop. Validated by test_foundry_v5's danger/safe matrix.
_REDOS_ATOM = re.compile(r"^(?:\\.|\[[^\]]*\]|\.|\w)$")
_UNBOUNDED_BRACE = re.compile(r"\{\d*,\}")
_STARTS_UNBOUNDED = re.compile(r"^(?:\\.|\[[^\]]*\]|\.|\w)(?:[*+]|\{\d*,\})")
_REGEX_FUNCS = frozenset({"regex_extract", "regex_match", "regex_replace"})


def _fully_enclosed(s: str) -> bool:
    """True iff ``s`` is a single balanced ``(...)`` group wrapping everything."""
    if not (s.startswith("(") and s.endswith(")")):
        return False
    depth = 0
    for i, ch in enumerate(s):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i == len(s) - 1
    return False


def _strip_group(body: str) -> str:
    body = body.strip()
    while True:  # strip non-capturing marker + enclosing groups: ((a+)) -> a+
        if body.startswith("?:"):
            body = body[2:]
            continue
        if _fully_enclosed(body):
            body = body[1:-1]
            continue
        break
    return body


def _body_ends_in_unbounded_unit(body: str) -> bool:
    body = _strip_group(body)
    if len(body) < 2:
        return False
    if body[-1] in "*+":
        unit = body[:-1]
    elif body.endswith("}") and _UNBOUNDED_BRACE.search(body):
        unit = body[: body.rindex("{")]
    else:
        return False
    unit = unit.strip()
    if unit.startswith("?:"):
        unit = unit[2:]
    return bool(_REDOS_ATOM.match(unit)) or _fully_enclosed(unit)


def _body_starts_with_unbounded_atom(body: str) -> bool:
    # e.g. `\w+\s?`, `\d+...`, `a+?` — the ambiguous prefix that makes the outer
    # quantifier catastrophic even when the body doesn't END in a quantifier.
    return _STARTS_UNBOUNDED.match(_strip_group(body)) is not None


def _is_catastrophic(pattern: str) -> bool:
    stack: list[int] = []
    pairs: dict[int, int] = {}
    for idx, ch in enumerate(pattern):
        if ch == "(":
            stack.append(idx)
        elif ch == ")" and stack:
            pairs[idx] = stack.pop()
    n = len(pattern)
    for close_idx, open_idx in pairs.items():
        nxt = pattern[close_idx + 1] if close_idx + 1 < n else ""
        # NB: tuple membership — `"" in "*+"` is True (substring), which would
        # falsely flag a group that ends the pattern (e.g. trailing `([0-9]+)`).
        unbounded = nxt in ("*", "+") or (
            nxt == "{" and _UNBOUNDED_BRACE.match(pattern[close_idx + 1 :]) is not None
        )
        if unbounded:
            body = pattern[open_idx + 1 : close_idx]
            if _body_ends_in_unbounded_unit(body) or _body_starts_with_unbounded_atom(body):
                return True
    return False


def _safe_num(x: Any, caster: Callable[[Any], Any]) -> Any:
    if x is None:
        return None
    try:
        return caster(x)
    except (ValueError, TypeError):
        return None


@functools.lru_cache(maxsize=256)
def _compile_pattern(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)


def _safe_pattern(pattern: Any) -> re.Pattern[str]:
    """Compile ``pattern`` or RAISE ``UnsafeExpressionError`` — an empty/oversize
    pattern, a catastrophic-backtracking shape, or an invalid regex all raise
    rather than return a sentinel. Raising (vs the old silent None) means a bad
    pattern surfaces LOUDLY: the row is quarantined with a clear reason instead
    of silently matching nothing / being left unchanged (review 2026-07-09)."""
    if not isinstance(pattern, str) or not pattern:
        raise UnsafeExpressionError("regex pattern must be a non-empty string")
    if len(pattern) > _MAX_PATTERN_LEN:
        raise UnsafeExpressionError(f"regex pattern too long (>{_MAX_PATTERN_LEN} chars)")
    if _is_catastrophic(pattern):
        raise UnsafeExpressionError(
            f"regex pattern {pattern!r} rejected: catastrophic-backtracking shape (e.g. (a+)+)"
        )
    try:
        return _compile_pattern(pattern)
    except re.error as exc:
        raise UnsafeExpressionError(f"invalid regex pattern {pattern!r}: {exc}") from exc


def _regex_extract(value: Any, pattern: Any, group: Any = 0) -> Any:
    if value is None:
        return None
    rx = _safe_pattern(pattern)
    m = rx.search(str(value)[:_MAX_REGEX_INPUT_LEN])
    if not m:
        return None
    try:
        return m.group(group)
    except (IndexError, TypeError):
        return None


def _regex_match(value: Any, pattern: Any) -> bool:
    if value is None:
        return False
    rx = _safe_pattern(pattern)
    return rx.search(str(value)[:_MAX_REGEX_INPUT_LEN]) is not None


def _regex_replace(value: Any, pattern: Any, repl: Any) -> Any:
    """Replace every match of ``pattern`` in ``value`` with ``repl``. Runs on the
    FULL value (never truncated — the pattern is ReDoS-guarded, so no input cap
    is needed and truncating would corrupt data); ``None`` only for ``None``
    input. An unsafe/invalid pattern raises (→ quarantined), not a silent no-op."""
    if value is None:
        return None
    rx = _safe_pattern(pattern)
    return rx.sub(str(repl), str(value))


def _replace(s: Any, old: Any, new: Any) -> Any:
    if s is None:
        return None
    try:
        return str(s).replace(str(old), str(new))
    except (ValueError, TypeError):
        return None


def _strip(s: Any) -> Any:
    return None if s is None else str(s).strip()


def _split(s: Any, sep: Any) -> Any:
    if s is None:
        return None
    try:
        return str(s).split(str(sep))
    except (ValueError, TypeError):
        return None


def _coalesce(*args: Any) -> Any:
    for a in args:
        if a is not None:
            return a
    return None


def _minmax(args: tuple[Any, ...], fn: Callable[[list[Any]], Any]) -> Any:
    candidates = args[0] if len(args) == 1 and isinstance(args[0], (list, tuple)) else args
    vals = [a for a in candidates if a is not None]
    if not vals:
        return None
    try:
        return fn(vals)
    except TypeError:
        return None


def _parse_ts(value: Any, fmt: Any = None) -> Any:
    if value is None:
        return None
    s = str(value)
    try:
        if fmt is None:
            iso = s[:-1] + "+00:00" if s.endswith("Z") else s
            dt = datetime.fromisoformat(iso)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return dt.timestamp()
        struct = time.strptime(s, str(fmt))
        return float(calendar.timegm(struct))
    except (ValueError, TypeError):
        return None


def _format_ts(epoch: Any, fmt: Any = "%Y-%m-%dT%H:%M:%SZ") -> Any:
    if epoch is None:
        return None
    try:
        dt = datetime.fromtimestamp(float(epoch), tz=UTC)
        return dt.strftime(str(fmt))
    except (ValueError, TypeError, OSError, OverflowError):
        return None


_ALLOWED_FUNCS: dict[str, Callable[..., Any]] = {
    "len": lambda x: 0 if x is None else len(x),
    "lower": lambda x: None if x is None else str(x).lower(),
    "upper": lambda x: None if x is None else str(x).upper(),
    "str": lambda x: None if x is None else str(x),
    "int": lambda x: _safe_num(x, int),
    "float": lambda x: _safe_num(x, float),
    "round": lambda x, n=0: None if x is None else round(x, n),
    "abs": lambda x: None if x is None else abs(x),
    "regex_extract": _regex_extract,
    "regex_match": _regex_match,
    "regex_replace": _regex_replace,
    "replace": _replace,
    "strip": _strip,
    "split": _split,
    "coalesce": _coalesce,
    "min": lambda *a: _minmax(a, min),
    "max": lambda *a: _minmax(a, max),
    "parse_ts": _parse_ts,
    "format_ts": _format_ts,
}


_ALLOWED_NODE_TYPES = (
    ast.Expression,
    ast.BoolOp,
    ast.And,
    ast.Or,
    ast.UnaryOp,
    ast.Not,
    ast.USub,
    ast.UAdd,
    ast.BinOp,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.Mod,
    ast.Compare,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.In,
    ast.NotIn,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.List,
    ast.Tuple,
    ast.Call,
)


class UnsafeExpressionError(FoundryError):
    def __init__(self, detail: str) -> None:
        super().__init__(422, detail)


def _validate(node: ast.AST) -> None:
    if not isinstance(node, _ALLOWED_NODE_TYPES):
        raise UnsafeExpressionError(
            f"expression uses disallowed syntax: {type(node).__name__}"
        )
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _ALLOWED_FUNCS:
            raise UnsafeExpressionError("expression calls a function that is not allowed")
        if node.keywords:
            raise UnsafeExpressionError("expression may not use keyword arguments")
        if node.func.id in _REGEX_FUNCS:
            # The pattern (2nd arg of every regex func) MUST be a string literal:
            # a dataset column value can never supply a regex pattern, and the
            # literal is screened for catastrophic backtracking HERE, at
            # save/compile time (loud), not per-row at runtime.
            pat = node.args[1] if len(node.args) >= 2 else None
            if not (isinstance(pat, ast.Constant) and isinstance(pat.value, str)):
                raise UnsafeExpressionError(
                    f"{node.func.id}: the regex pattern must be a string literal"
                    " (a column value cannot supply the pattern)"
                )
            _safe_pattern(pat.value)  # raises on catastrophic / invalid / oversize
        for arg in node.args:
            _validate(arg)
        return
    if isinstance(node, ast.Name) and node.id.startswith("__"):
        raise UnsafeExpressionError("expression may not reference dunder names")
    for child in ast.iter_child_nodes(node):
        _validate(child)


def compile_expr(expr: str) -> ast.Expression:
    """Parse + validate an expression string; raises ``UnsafeExpressionError``
    on any construct outside the whitelist (attribute access, imports,
    comprehensions, dunder names, disallowed calls, …)."""
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise UnsafeExpressionError(f"invalid expression: {exc}") from exc
    _validate(tree)
    return tree


def _eval_bool(node: ast.BoolOp, row: Row) -> Any:
    is_and = isinstance(node.op, ast.And)
    result: Any = True if is_and else False
    for v in node.values:
        val = _eval(v, row)
        if is_and:
            if not val:
                return val
            result = val
        else:
            if val:
                return val
            result = val
    return result


def _eval_compare(node: ast.Compare, row: Row) -> bool:
    left = _eval(node.left, row)
    for op, comparator in zip(node.ops, node.comparators, strict=True):
        right = _eval(comparator, row)
        if isinstance(op, (ast.In, ast.NotIn)):
            if right is None:
                ok = False
            else:
                contains = left in right
                ok = contains if isinstance(op, ast.In) else not contains
        elif left is None or right is None:
            ok = False
        elif isinstance(op, ast.Eq):
            ok = left == right
        elif isinstance(op, ast.NotEq):
            ok = left != right
        elif isinstance(op, ast.Lt):
            ok = left < right
        elif isinstance(op, ast.LtE):
            ok = left <= right
        elif isinstance(op, ast.Gt):
            ok = left > right
        elif isinstance(op, ast.GtE):
            ok = left >= right
        else:  # pragma: no cover — unreachable, node types are validated
            ok = False
        if not ok:
            return False
        left = right
    return True


def _eval(node: ast.AST, row: Row) -> Any:
    if isinstance(node, ast.Expression):
        return _eval(node.body, row)
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        return row.get(node.id)
    if isinstance(node, ast.List | ast.Tuple):
        return [_eval(e, row) for e in node.elts]
    if isinstance(node, ast.BoolOp):
        return _eval_bool(node, row)
    if isinstance(node, ast.UnaryOp):
        val = _eval(node.operand, row)
        if isinstance(node.op, ast.Not):
            return not val
        if val is None:
            return None
        return -val if isinstance(node.op, ast.USub) else +val
    if isinstance(node, ast.BinOp):
        left = _eval(node.left, row)
        right = _eval(node.right, row)
        if left is None or right is None:
            return None
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            # Guard sequence repetition (str/list * int) against an allocation
            # blow-up from a data-controlled multiplier (e.g. str(x) * 10**9).
            # Raises → the row is quarantined, never OOMs the process.
            if isinstance(left, (str, list, tuple)) and isinstance(right, int):
                if len(left) * abs(right) > _MAX_SEQ_REPEAT:
                    raise ValueError("sequence repetition exceeds size limit")
            elif isinstance(right, (str, list, tuple)) and isinstance(left, int):
                if len(right) * abs(left) > _MAX_SEQ_REPEAT:
                    raise ValueError("sequence repetition exceeds size limit")
            return left * right
        if isinstance(node.op, ast.Div):
            try:
                return left / right
            except ZeroDivisionError:
                return None
        if isinstance(node.op, ast.Mod):
            try:
                return left % right
            except ZeroDivisionError:
                return None
        raise UnsafeExpressionError("unsupported binary operator")  # pragma: no cover
    if isinstance(node, ast.Compare):
        return _eval_compare(node, row)
    if isinstance(node, ast.Call):
        func = _ALLOWED_FUNCS[node.func.id]  # type: ignore[union-attr]
        args = [_eval(a, row) for a in node.args]
        return func(*args)
    raise UnsafeExpressionError(f"cannot evaluate: {type(node).__name__}")  # pragma: no cover


def eval_expr(tree: ast.Expression, row: Row) -> Any:
    return _eval(tree, row)


# ── step DSL ───────────────────────────────────────────────────────────────────

DatasetProvider = Callable[[str], list[Row]]

_QUARANTINE_CAP = 1000


class QuarantineSink:
    """Collects rows whose ``filter``/``derive`` expression RAISED (e.g. a
    type-incompatible value like ``'hello' - 5``) so one bad row skips itself
    into a dead-letter list instead of aborting the whole build for every row
    — Palantir's quarantine/dead-letter remediation, right-sized. ``count`` is
    the true total encountered; ``rows`` is capped to bound memory."""

    def __init__(self) -> None:
        self.count = 0
        self.rows: list[Row] = []

    def add(self, idx: int, step_type: str, exc: Exception, row: Row) -> None:
        self.count += 1
        if len(self.rows) < _QUARANTINE_CAP:
            self.rows.append(
                {
                    "step": idx,
                    "step_type": step_type,
                    "error": f"{type(exc).__name__}: {exc}",
                    "row": row,
                }
            )


def _step_select(rows: list[Row], step: dict[str, Any]) -> list[Row]:
    columns = step["columns"]
    return [{c: r.get(c) for c in columns} for r in rows]


def _step_rename(rows: list[Row], step: dict[str, Any]) -> list[Row]:
    mapping = step["map"]
    return [{mapping.get(k, k): v for k, v in r.items()} for r in rows]


def _step_filter(
    rows: list[Row], step: dict[str, Any], idx: int = 0, quarantine: QuarantineSink | None = None
) -> list[Row]:
    tree = compile_expr(step["expr"])
    out: list[Row] = []
    for r in rows:
        try:
            keep = eval_expr(tree, r)
        except Exception as exc:  # noqa: BLE001 — a bad row is quarantined, not fatal
            if quarantine is None:
                raise
            quarantine.add(idx, "filter", exc, r)
            continue
        if keep:
            out.append(r)
    return out


def _step_derive(
    rows: list[Row], step: dict[str, Any], idx: int = 0, quarantine: QuarantineSink | None = None
) -> list[Row]:
    tree = compile_expr(step["expr"])
    column = step["column"]
    out: list[Row] = []
    for r in rows:
        try:
            value = eval_expr(tree, r)
        except Exception as exc:  # noqa: BLE001 — a bad row is quarantined, not fatal
            if quarantine is None:
                raise
            quarantine.add(idx, "derive", exc, r)
            continue
        r2 = dict(r)
        r2[column] = value
        out.append(r2)
    return out


def _step_join(rows: list[Row], step: dict[str, Any], provider: DatasetProvider) -> list[Row]:
    """Standard SQL join semantics: one output row per matching right-hand
    row (not first-match-wins) — a left key with N right matches fans out to
    N rows, matching how a real join behaves on duplicate keys."""
    right_rows = provider(step["right"])
    on = step["on"]
    right_on = step.get("right_on", on)
    how = step.get("how", "left")
    index: dict[Any, list[Row]] = {}
    for rr in right_rows:
        index.setdefault(rr.get(right_on), []).append(rr)
    right_cols = list(right_rows[0].keys()) if right_rows else []
    out: list[Row] = []
    for r in rows:
        matches = index.get(r.get(on))
        if not matches:
            if how == "inner":
                continue
            merged = {c: None for c in right_cols}
            merged.update(r)
            out.append(merged)
            continue
        for match in matches:
            out.append({**match, **r})
    return out


def _step_aggregate(rows: list[Row], step: dict[str, Any]) -> list[Row]:
    group_by: list[str] = step["group_by"]
    aggs: dict[str, str] = step["aggs"]
    groups: dict[tuple[Any, ...], list[Row]] = {}
    for r in rows:
        key = tuple(r.get(g) for g in group_by)
        groups.setdefault(key, []).append(r)
    out: list[Row] = []
    for key, members in groups.items():
        result: Row = dict(zip(group_by, key, strict=True))
        for out_name, spec in aggs.items():
            if spec == "count":
                result[out_name] = len(members)
                continue
            op, _, col = spec.partition(":")
            values = [m.get(col) for m in members]
            numeric = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
            if op == "sum":
                result[out_name] = sum(numeric) if numeric else 0
            elif op == "avg":
                result[out_name] = (sum(numeric) / len(numeric)) if numeric else None
            elif op == "min":
                result[out_name] = min(numeric) if numeric else None
            elif op == "max":
                result[out_name] = max(numeric) if numeric else None
            else:
                raise FoundryError(422, f"unknown aggregate op: {spec!r}")
        out.append(result)
    return out


def _step_union(rows: list[Row], step: dict[str, Any], provider: DatasetProvider) -> list[Row]:
    return [*rows, *provider(step["right"])]


def _sort_key(v: Any) -> tuple[int, int, Any]:
    """Total-order sort key that NEVER raises on mixed types (JSON/NDJSON columns
    are legitimately heterogeneous). None sorts last; within present values,
    bool < number < str by type rank, and only same-rank values are ever
    compared to each other (ints/floats share a rank and are mutually
    comparable), so sorted() can't hit a str-vs-int TypeError."""
    if v is None:
        return (1, 0, "")
    if isinstance(v, bool):
        return (0, 0, int(v))
    if isinstance(v, (int, float)):
        return (0, 1, v)
    return (0, 2, str(v))


def _step_sort(rows: list[Row], step: dict[str, Any]) -> list[Row]:
    by = step["by"]
    desc = bool(step.get("desc", False))
    return sorted(rows, key=lambda r: _sort_key(r.get(by)), reverse=desc)


def _step_limit(rows: list[Row], step: dict[str, Any]) -> list[Row]:
    return rows[: int(step["n"])]


def _step_dedup(rows: list[Row], step: dict[str, Any]) -> list[Row]:
    """Keep the FIRST row of each distinct key. ``by`` = key columns; omitted →
    dedup on the whole row (all columns)."""
    by = step.get("by")
    seen: set[str] = set()
    out: list[Row] = []
    for r in rows:
        if by:
            key = json_key([r.get(c) for c in by])
        else:
            key = json_key(r)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _step_cast(rows: list[Row], step: dict[str, Any]) -> list[Row]:
    """Coerce one column to a target type in-place, reusing the same
    information-preserving coercion the upload type-pinning uses. Unconvertible
    values become None (str never fails)."""
    from app.foundry.ingest import _coerce_to  # noqa: PLC0415 — break import cycle

    column = step["column"]
    to = step["to"]
    out: list[Row] = []
    for r in rows:
        r2 = dict(r)
        if column in r2:
            r2[column] = _coerce_to(r2[column], to)
        out.append(r2)
    return out


def json_key(value: Any) -> str:
    import json as _json  # noqa: PLC0415

    return _json.dumps(value, sort_keys=True, default=str)


def _agg_values(vals: list[Any], agg: str) -> Any:
    if agg == "count":
        return len(vals)
    nums = [v for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if agg == "sum":
        return sum(nums) if nums else 0
    if agg == "avg":
        return (sum(nums) / len(nums)) if nums else None
    if agg == "min":
        return min(nums) if nums else None
    if agg == "max":
        return max(nums) if nums else None
    if agg == "first":
        return vals[0] if vals else None
    raise FoundryError(422, f"unknown pivot agg: {agg!r}")  # pragma: no cover — validated


def _step_window(rows: list[Row], step: dict[str, Any]) -> list[Row]:
    """Analytic window function: compute ``into`` per row within a partition,
    ordered by ``order_by``. ``fn`` ∈ row_number | rank | lag:col |
    running_sum:col. Output preserves input row order; the window column is
    added, all other columns untouched."""
    partition_by: list[str] = step.get("partition_by") or []
    order_by = step.get("order_by")
    desc = bool(step.get("desc", False))
    op, _, col = str(step["fn"]).partition(":")
    into = step["into"]

    groups: dict[str, list[tuple[int, Row]]] = {}
    for idx, r in enumerate(rows):
        groups.setdefault(json_key([r.get(c) for c in partition_by]), []).append((idx, r))

    out_vals: dict[int, Any] = {}
    for members in groups.values():
        if order_by:
            ordered = sorted(members, key=lambda ir: _sort_key(ir[1].get(order_by)))
        else:
            ordered = list(members)
        if desc and order_by:
            ordered.reverse()
        prev: Any = None
        running = 0.0
        rank = 0
        last_key: Any = object()
        for pos, (idx, r) in enumerate(ordered):
            if op == "row_number":
                out_vals[idx] = pos + 1
            elif op == "rank":
                k = _sort_key(r.get(order_by)) if order_by else pos
                if k != last_key:
                    rank = pos + 1
                    last_key = k
                out_vals[idx] = rank
            elif op == "lag":
                out_vals[idx] = prev
                prev = r.get(col)
            elif op == "running_sum":
                v = r.get(col)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    running += v
                out_vals[idx] = running
            else:
                raise FoundryError(422, f"unknown window fn: {step['fn']!r}")  # pragma: no cover
    out: list[Row] = []
    for idx, r in enumerate(rows):
        r2 = dict(r)
        r2[into] = out_vals.get(idx)
        out.append(r2)
    return out


def _step_pivot(rows: list[Row], step: dict[str, Any]) -> list[Row]:
    """Long→wide pivot: one output row per distinct ``index`` tuple; one output
    column per distinct value of ``column`` (stringified), carrying ``value``
    aggregated by ``agg``."""
    index: list[str] = step["index"]
    column = step["column"]
    value = step["value"]
    agg = step.get("agg", "sum")
    index_set = set(index)
    pivot_vals: list[str] = []
    seen: set[str] = set()
    groups: dict[tuple[Any, ...], dict[str, list[Any]]] = {}
    for r in rows:
        key = tuple(r.get(i) for i in index)
        pv = r.get(column)
        pvs = "" if pv is None else str(pv)
        if pvs not in seen:
            # A pivot column named the same as an index column would clobber the
            # grouping key in the output row — refuse, don't silently corrupt.
            if pvs in index_set:
                raise FoundryError(
                    422,
                    f"pivot column value {pvs!r} collides with index column name;"
                    " rename the index column or filter that value",
                )
            seen.add(pvs)
            pivot_vals.append(pvs)
        groups.setdefault(key, {}).setdefault(pvs, []).append(r.get(value))
    out: list[Row] = []
    for key, cells in groups.items():
        row: Row = dict(zip(index, key, strict=True))
        for pv in pivot_vals:
            row[pv] = _agg_values(cells.get(pv, []), agg)
        out.append(row)
    return out


_STEP_TYPES = {
    "select", "rename", "filter", "derive", "join", "aggregate", "union",
    "sort", "limit", "dedup", "cast", "window", "pivot",
}


def run_steps(
    steps: list[dict[str, Any]],
    base_rows: list[Row],
    provider: DatasetProvider,
    quarantine: QuarantineSink | None = None,
) -> list[Row]:
    """Execute a transform's step list over ``base_rows`` in order.

    When ``quarantine`` is given, a row whose ``filter``/``derive`` expression
    RAISES is routed to the sink and dropped from the output rather than
    aborting the whole run; when it is ``None`` the exception propagates (the
    back-compatible behavior for direct callers/tests)."""
    rows = base_rows
    for idx, step in enumerate(steps):
        t = step.get("type")
        if t == "select":
            rows = _step_select(rows, step)
        elif t == "rename":
            rows = _step_rename(rows, step)
        elif t == "filter":
            rows = _step_filter(rows, step, idx, quarantine)
        elif t == "derive":
            rows = _step_derive(rows, step, idx, quarantine)
        elif t == "join":
            rows = _step_join(rows, step, provider)
        elif t == "aggregate":
            rows = _step_aggregate(rows, step)
        elif t == "union":
            rows = _step_union(rows, step, provider)
        elif t == "sort":
            rows = _step_sort(rows, step)
        elif t == "limit":
            rows = _step_limit(rows, step)
        elif t == "dedup":
            rows = _step_dedup(rows, step)
        elif t == "cast":
            rows = _step_cast(rows, step)
        elif t == "window":
            rows = _step_window(rows, step)
        elif t == "pivot":
            rows = _step_pivot(rows, step)
        else:
            raise FoundryError(422, f"unknown step type: {t!r}")
    return rows


# ── column-level lineage (static step analysis) ──────────────────────────────


def _expr_names(expr: str) -> set[str]:
    try:
        tree = compile_expr(expr)
    except UnsafeExpressionError:
        return set()
    return {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}


def column_lineage(
    steps: list[dict[str, Any]],
    primary_columns: list[str],
    right_columns: dict[str, list[str]] | None = None,
) -> dict[str, list[str]]:
    """Best-effort one-hop column lineage: map each OUTPUT column of a transform
    to the set of INPUT columns (across the primary input + any join/union
    right datasets) it derives from. Tracks provenance statically through the
    step list — select/rename/derive/aggregate/join/union all propagate it;
    filter/sort/limit/dedup/cast leave columns (hence provenance) unchanged."""
    right_columns = right_columns or {}
    prov: dict[str, set[str]] = {c: {c} for c in primary_columns}
    for step in steps:
        t = step.get("type")
        if t == "select":
            prov = {c: prov.get(c, set()) for c in step.get("columns", [])}
        elif t == "rename":
            mapping = step.get("map", {})
            prov = {mapping.get(c, c): p for c, p in prov.items()}
        elif t == "derive":
            src: set[str] = set()
            for n in _expr_names(step.get("expr", "")):
                src |= prov.get(n, set())
            prov[step.get("column", "")] = src
        elif t == "join":
            for rc in right_columns.get(step.get("right", ""), []):
                # left overrides on key conflict (matches {**match, **r}) — only
                # add right-only columns.
                prov.setdefault(rc, {rc})
        elif t == "union":
            for rc in right_columns.get(step.get("right", ""), []):
                prov.setdefault(rc, set()).add(rc)
        elif t == "aggregate":
            new_prov: dict[str, set[str]] = {g: prov.get(g, {g}) for g in step.get("group_by", [])}
            for out_name, spec in step.get("aggs", {}).items():
                if spec == "count":
                    new_prov[out_name] = set()
                else:
                    _, _, srccol = spec.partition(":")
                    new_prov[out_name] = set(prov.get(srccol, {srccol} if srccol else set()))
            prov = new_prov
        # filter / sort / limit / dedup / cast: columns unchanged
    return {k: sorted(v) for k, v in prov.items()}


# ── save-time validation ─────────────────────────────────────────────────────

_VALID_JOIN_HOW = {"left", "inner"}
_VALID_AGG_OPS = {"count", "sum", "avg", "min", "max"}
_VALID_CAST_TYPES = {"str", "int", "float", "bool"}
_VALID_WINDOW_NOARG = {"row_number", "rank"}
_VALID_WINDOW_COLARG = {"lag", "running_sum"}
_VALID_PIVOT_AGGS = {"count", "sum", "avg", "min", "max", "first"}


def _require(step: dict[str, Any], key: str, idx: int, step_type: str) -> Any:
    if key not in step:
        raise FoundryError(422, f"step {idx} ({step_type}): missing required key {key!r}")
    return step[key]


def _validate_expr_str(expr: Any, idx: int, step_type: str) -> None:
    if not isinstance(expr, str) or not expr.strip():
        raise FoundryError(422, f"step {idx} ({step_type}): 'expr' must be a non-empty string")
    try:
        compile_expr(expr)
    except UnsafeExpressionError as exc:
        raise FoundryError(422, f"step {idx} ({step_type}): invalid expr: {exc.detail}") from exc


def validate_steps(steps: list[dict[str, Any]]) -> None:
    """Validate a transform's step list at SAVE time, before any data ever
    runs through it. Raises ``FoundryError`` (422) naming the step index and
    the exact problem for: unknown step types, missing required keys, bad
    join/aggregate op names, and filter/derive expressions that fail to
    parse under the safe evaluator. Does not execute steps against real rows."""
    for idx, step in enumerate(steps):
        t = step.get("type")
        if t not in _STEP_TYPES:
            raise FoundryError(422, f"step {idx}: unknown step type {t!r}")
        if t == "select":
            columns = _require(step, "columns", idx, t)
            if not isinstance(columns, list) or not columns:
                raise FoundryError(422, f"step {idx} (select): 'columns' must be a non-empty list")
        elif t == "rename":
            mapping = _require(step, "map", idx, t)
            if not isinstance(mapping, dict) or not mapping:
                raise FoundryError(422, f"step {idx} (rename): 'map' must be a non-empty dict")
        elif t == "filter":
            _validate_expr_str(_require(step, "expr", idx, t), idx, t)
        elif t == "derive":
            column = _require(step, "column", idx, t)
            if not isinstance(column, str) or not column:
                raise FoundryError(422, f"step {idx} (derive): 'column' must be a non-empty string")
            _validate_expr_str(_require(step, "expr", idx, t), idx, t)
        elif t == "join":
            right = _require(step, "right", idx, t)
            on = _require(step, "on", idx, t)
            if not isinstance(right, str) or not right:
                raise FoundryError(422, f"step {idx} (join): 'right' must be a non-empty string")
            if not isinstance(on, str) or not on:
                raise FoundryError(422, f"step {idx} (join): 'on' must be a non-empty string")
            how = step.get("how", "left")
            if how not in _VALID_JOIN_HOW:
                raise FoundryError(
                    422,
                    f"step {idx} (join): 'how' must be one of {sorted(_VALID_JOIN_HOW)},"
                    f" got {how!r}",
                )
        elif t == "aggregate":
            group_by = _require(step, "group_by", idx, t)
            aggs = _require(step, "aggs", idx, t)
            if not isinstance(group_by, list) or not group_by:
                raise FoundryError(
                    422, f"step {idx} (aggregate): 'group_by' must be a non-empty list"
                )
            if not isinstance(aggs, dict) or not aggs:
                raise FoundryError(422, f"step {idx} (aggregate): 'aggs' must be a non-empty dict")
            for out_name, spec in aggs.items():
                if spec == "count":
                    continue
                if not isinstance(spec, str) or ":" not in spec:
                    raise FoundryError(
                        422,
                        f"step {idx} (aggregate): agg {out_name!r} has invalid spec {spec!r}"
                        " (expected 'count' or 'op:column')",
                    )
                op, _, col = spec.partition(":")
                if op not in _VALID_AGG_OPS or not col:
                    raise FoundryError(
                        422,
                        f"step {idx} (aggregate): agg {out_name!r} op {op!r} must be one of"
                        f" {sorted(_VALID_AGG_OPS)}",
                    )
        elif t == "union":
            right = _require(step, "right", idx, t)
            if not isinstance(right, str) or not right:
                raise FoundryError(422, f"step {idx} (union): 'right' must be a non-empty string")
        elif t == "sort":
            by = _require(step, "by", idx, t)
            if not isinstance(by, str) or not by:
                raise FoundryError(422, f"step {idx} (sort): 'by' must be a non-empty string")
        elif t == "limit":
            n = _require(step, "n", idx, t)
            if not isinstance(n, int) or isinstance(n, bool) or n <= 0:
                raise FoundryError(422, f"step {idx} (limit): 'n' must be a positive integer")
        elif t == "dedup":
            by = step.get("by")
            if by is not None and (
                not isinstance(by, list) or not all(isinstance(c, str) for c in by)
            ):
                raise FoundryError(422, f"step {idx} (dedup): 'by' must be a list of column names")
        elif t == "cast":
            column = _require(step, "column", idx, t)
            to = _require(step, "to", idx, t)
            if not isinstance(column, str) or not column:
                raise FoundryError(422, f"step {idx} (cast): 'column' must be a non-empty string")
            if to not in _VALID_CAST_TYPES:
                raise FoundryError(
                    422,
                    f"step {idx} (cast): 'to' must be one of {sorted(_VALID_CAST_TYPES)}",
                )
        elif t == "window":
            fn = _require(step, "fn", idx, t)
            into = _require(step, "into", idx, t)
            if not isinstance(into, str) or not into:
                raise FoundryError(422, f"step {idx} (window): 'into' must be a non-empty string")
            if not isinstance(fn, str):
                raise FoundryError(422, f"step {idx} (window): 'fn' must be a string")
            op, _, col = fn.partition(":")
            if op in _VALID_WINDOW_COLARG:
                if not col:
                    raise FoundryError(
                        422, f"step {idx} (window): {op!r} needs a column, e.g. '{op}:price'"
                    )
            elif op not in _VALID_WINDOW_NOARG:
                raise FoundryError(
                    422,
                    f"step {idx} (window): 'fn' must be one of {sorted(_VALID_WINDOW_NOARG)} or"
                    f" {sorted(f'{o}:col' for o in _VALID_WINDOW_COLARG)}",
                )
            # rank/lag/running_sum are meaningless without an ordering key —
            # require it (row_number may omit it: arbitrary but well-defined).
            if op != "row_number" and not step.get("order_by"):
                raise FoundryError(422, f"step {idx} (window): {op!r} requires 'order_by'")
            pb = step.get("partition_by")
            if pb is not None and (
                not isinstance(pb, list) or not all(isinstance(c, str) for c in pb)
            ):
                raise FoundryError(
                    422, f"step {idx} (window): 'partition_by' must be a list of columns"
                )
        elif t == "pivot":
            index = _require(step, "index", idx, t)
            column = _require(step, "column", idx, t)
            value = _require(step, "value", idx, t)
            if not isinstance(index, list) or not index or not all(
                isinstance(c, str) for c in index
            ):
                raise FoundryError(
                    422, f"step {idx} (pivot): 'index' must be a non-empty list of columns"
                )
            if not isinstance(column, str) or not column:
                raise FoundryError(422, f"step {idx} (pivot): 'column' must be a non-empty string")
            if not isinstance(value, str) or not value:
                raise FoundryError(422, f"step {idx} (pivot): 'value' must be a non-empty string")
            agg = step.get("agg", "sum")
            if agg not in _VALID_PIVOT_AGGS:
                raise FoundryError(
                    422, f"step {idx} (pivot): 'agg' must be one of {sorted(_VALID_PIVOT_AGGS)}"
                )
