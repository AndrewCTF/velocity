"""Guard: the Foundry step DSL executes correctly and the expression
evaluator is genuinely sandboxed (docs/foundry-plan.md Guards).

No TestClient here — pure unit tests of ``app.foundry.transforms``.
"""

from __future__ import annotations

import pytest

from app.foundry.store import FoundryError
from app.foundry.transforms import (
    UnsafeExpressionError,
    compile_expr,
    eval_expr,
    run_steps,
    validate_steps,
)


def _provider_empty(_dataset_id: str) -> list[dict]:
    return []


# ── safe expression evaluator ────────────────────────────────────────────────


def test_expr_basic_arithmetic_and_compare() -> None:
    tree = compile_expr("speed * 1.852")
    assert eval_expr(tree, {"speed": 10}) == pytest.approx(18.52)

    tree = compile_expr("speed > 10 and country == 'DE'")
    assert eval_expr(tree, {"speed": 20, "country": "DE"}) is True
    assert eval_expr(tree, {"speed": 5, "country": "DE"}) is False


def test_expr_missing_column_is_none() -> None:
    tree = compile_expr("missing_col")
    assert eval_expr(tree, {"a": 1}) is None


def test_expr_comparison_with_none_is_false() -> None:
    tree = compile_expr("missing_col > 5")
    assert eval_expr(tree, {"a": 1}) is False
    tree_eq = compile_expr("missing_col == 5")
    assert eval_expr(tree_eq, {"a": 1}) is False


def test_expr_arithmetic_with_none_is_none() -> None:
    tree = compile_expr("missing_col * 2")
    assert eval_expr(tree, {"a": 1}) is None


def test_expr_in_operator() -> None:
    tree = compile_expr("country in ['DE', 'FR']")
    assert eval_expr(tree, {"country": "DE"}) is True
    assert eval_expr(tree, {"country": "US"}) is False


def test_expr_functions() -> None:
    assert eval_expr(compile_expr("len(name)"), {"name": "hello"}) == 5
    assert eval_expr(compile_expr("lower(name)"), {"name": "HeLLo"}) == "hello"
    assert eval_expr(compile_expr("upper(name)"), {"name": "hello"}) == "HELLO"
    assert eval_expr(compile_expr("round(x, 1)"), {"x": 3.14159}) == pytest.approx(3.1)
    assert eval_expr(compile_expr("abs(x)"), {"x": -5}) == 5
    assert eval_expr(compile_expr("int(x)"), {"x": "42"}) == 42
    assert eval_expr(compile_expr("float(x)"), {"x": "4.2"}) == pytest.approx(4.2)
    assert eval_expr(compile_expr("str(x)"), {"x": 42}) == "42"


def test_expr_regex_extract_and_match() -> None:
    tree = compile_expr("regex_extract(mmsi, '([0-9]{3})-([0-9]+)', 2)")
    assert eval_expr(tree, {"mmsi": "244-912345"}) == "912345"

    tree_no_group = compile_expr("regex_extract(icao, '[A-F0-9]{6}')")
    assert eval_expr(tree_no_group, {"icao": "hex 4CA1B2 end"}) == "4CA1B2"

    tree_none = compile_expr("regex_extract(icao, 'ZZZ')")
    assert eval_expr(tree_none, {"icao": "4CA1B2"}) is None
    assert eval_expr(tree_none, {"icao": None}) is None

    tree_match = compile_expr("regex_match(callsign, '^UAL[0-9]+$')")
    assert eval_expr(tree_match, {"callsign": "UAL123"}) is True
    assert eval_expr(tree_match, {"callsign": "DAL123"}) is False
    assert eval_expr(tree_match, {"callsign": None}) is False


def test_expr_regex_rejects_huge_pattern() -> None:
    # An oversize pattern now RAISES (→ row quarantined) instead of silently
    # returning None/False (review 2026-07-09).
    huge = "a" * 501
    with pytest.raises(UnsafeExpressionError):
        eval_expr(compile_expr("regex_extract(x, p)"), {"x": "abc", "p": huge})
    with pytest.raises(UnsafeExpressionError):
        eval_expr(compile_expr("regex_match(x, p)"), {"x": "abc", "p": huge})


def test_expr_regex_rejects_non_string_pattern() -> None:
    with pytest.raises(UnsafeExpressionError):
        eval_expr(compile_expr("regex_extract(x, p)"), {"x": "abc", "p": 123})


def test_expr_string_helpers() -> None:
    assert eval_expr(compile_expr("replace(s, 'a', 'b')"), {"s": "banana"}) == "bbnbnb"
    assert eval_expr(compile_expr("replace(s, 'a', 'b')"), {"s": None}) is None
    assert eval_expr(compile_expr("strip(s)"), {"s": "  hi  "}) == "hi"
    assert eval_expr(compile_expr("strip(s)"), {"s": None}) is None
    assert eval_expr(compile_expr("split(s, ',')"), {"s": "a,b,c"}) == ["a", "b", "c"]
    assert eval_expr(compile_expr("split(s, ',')"), {"s": None}) is None


def test_expr_coalesce() -> None:
    tree = compile_expr("coalesce(a, b, c)")
    assert eval_expr(tree, {"a": None, "b": None, "c": 3}) == 3
    assert eval_expr(tree, {"a": 1, "b": 2, "c": 3}) == 1
    assert eval_expr(tree, {"a": None, "b": None, "c": None}) is None


def test_expr_min_max() -> None:
    assert eval_expr(compile_expr("min(a, b, c)"), {"a": 5, "b": 1, "c": 3}) == 1
    assert eval_expr(compile_expr("max(a, b, c)"), {"a": 5, "b": 1, "c": 3}) == 5
    assert eval_expr(compile_expr("min(a, b)"), {"a": None, "b": 2}) == 2
    assert eval_expr(compile_expr("min(a, b)"), {"a": None, "b": None}) is None


def test_expr_parse_ts_iso() -> None:
    tree = compile_expr("parse_ts(ts)")
    epoch = eval_expr(tree, {"ts": "2024-01-01T00:00:00Z"})
    assert epoch == pytest.approx(1704067200.0)
    epoch_offset = eval_expr(tree, {"ts": "2024-01-01T00:00:00+00:00"})
    assert epoch_offset == pytest.approx(1704067200.0)
    assert eval_expr(tree, {"ts": None}) is None
    assert eval_expr(tree, {"ts": "not a date"}) is None


def test_expr_parse_ts_custom_format() -> None:
    tree = compile_expr("parse_ts(ts, fmt)")
    epoch = eval_expr(tree, {"ts": "01/02/2024", "fmt": "%m/%d/%Y"})
    assert epoch == pytest.approx(1704153600.0)
    assert eval_expr(tree, {"ts": "garbage", "fmt": "%m/%d/%Y"}) is None


def test_expr_format_ts() -> None:
    tree = compile_expr("format_ts(epoch)")
    assert eval_expr(tree, {"epoch": 1704067200.0}) == "2024-01-01T00:00:00Z"
    tree_fmt = compile_expr("format_ts(epoch, fmt)")
    assert eval_expr(tree_fmt, {"epoch": 1704067200.0, "fmt": "%Y-%m-%d"}) == "2024-01-01"
    assert eval_expr(tree, {"epoch": None}) is None


def test_expr_parse_and_format_ts_roundtrip() -> None:
    parsed = compile_expr("parse_ts(ts)")
    epoch = eval_expr(parsed, {"ts": "2024-06-15T12:30:00Z"})
    formatted = compile_expr("format_ts(epoch)")
    assert eval_expr(formatted, {"epoch": epoch}) == "2024-06-15T12:30:00Z"


# ── sandbox rejection: the exact attack surface named in the brief ──────────


@pytest.mark.parametrize(
    "expr",
    [
        "__import__('os').system('echo hi')",
        "().__class__",
        "().__class__.__bases__",
        "x.__class__",
        "[].append(1)",
        "(lambda: 1)()",
        "__builtins__",
        "os.system('ls')",
        "exec('1')",
        "eval('1')",
        "regex_extract(x, __import__('os'))",
        "getattr(x, '__class__')",
    ],
)
def test_expr_rejects_unsafe_constructs(expr: str) -> None:
    with pytest.raises(UnsafeExpressionError):
        compile_expr(expr)


def test_expr_rejects_disallowed_function() -> None:
    with pytest.raises(UnsafeExpressionError):
        compile_expr("open('/etc/passwd')")


def test_expr_rejects_dunder_name() -> None:
    with pytest.raises(UnsafeExpressionError):
        compile_expr("__secret__")


def test_expr_rejects_syntax_error() -> None:
    with pytest.raises(UnsafeExpressionError):
        compile_expr("speed >")


# ── step DSL ─────────────────────────────────────────────────────────────────


_ROWS = [
    {"id": 1, "name": "alpha", "speed": 12, "country": "DE"},
    {"id": 2, "name": "beta", "speed": 5, "country": "FR"},
    {"id": 3, "name": "gamma", "speed": 20, "country": "DE"},
]


def test_step_select() -> None:
    out = run_steps([{"type": "select", "columns": ["id", "name"]}], _ROWS, _provider_empty)
    assert out == [{"id": 1, "name": "alpha"}, {"id": 2, "name": "beta"}, {"id": 3, "name": "gamma"}]


def test_step_rename() -> None:
    out = run_steps([{"type": "rename", "map": {"name": "callsign"}}], _ROWS, _provider_empty)
    assert out[0]["callsign"] == "alpha"
    assert "name" not in out[0]


def test_step_filter() -> None:
    out = run_steps(
        [{"type": "filter", "expr": "speed > 10 and country == 'DE'"}], _ROWS, _provider_empty
    )
    assert [r["id"] for r in out] == [1, 3]


def test_step_derive() -> None:
    out = run_steps(
        [{"type": "derive", "column": "kmh", "expr": "speed * 1.852"}], _ROWS, _provider_empty
    )
    assert out[0]["kmh"] == pytest.approx(12 * 1.852)


def test_step_sort_and_limit() -> None:
    out = run_steps(
        [{"type": "sort", "by": "speed", "desc": True}, {"type": "limit", "n": 2}],
        _ROWS,
        _provider_empty,
    )
    assert [r["id"] for r in out] == [3, 1]


def test_step_aggregate() -> None:
    out = run_steps(
        [
            {
                "type": "aggregate",
                "group_by": ["country"],
                "aggs": {"n": "count", "total_speed": "sum:speed", "avg_speed": "avg:speed"},
            }
        ],
        _ROWS,
        _provider_empty,
    )
    by_country = {r["country"]: r for r in out}
    assert by_country["DE"]["n"] == 2
    assert by_country["DE"]["total_speed"] == 32
    assert by_country["FR"]["n"] == 1
    assert by_country["FR"]["avg_speed"] == pytest.approx(5.0)


def test_step_join_left_and_inner() -> None:
    right = [
        {"country": "DE", "region": "Europe"},
        {"country": "FR", "region": "Europe"},
    ]

    def provider(dataset_id: str) -> list[dict]:
        assert dataset_id == "ds_right"
        return right

    out_left = run_steps(
        [{"type": "join", "right": "ds_right", "on": "country", "how": "left"}], _ROWS, provider
    )
    assert all(r["region"] == "Europe" for r in out_left)

    unmatched = [{"id": 9, "name": "delta", "speed": 1, "country": "US"}]
    out_inner = run_steps(
        [{"type": "join", "right": "ds_right", "on": "country", "how": "inner"}],
        unmatched,
        provider,
    )
    assert out_inner == []


def test_step_join_multi_match_fans_out_rows() -> None:
    """Duplicate right-hand keys must produce one output row per match, not
    silently drop all but the first (docs/foundry-gap-analysis Q5)."""
    right = [
        {"country": "DE", "port": "Hamburg"},
        {"country": "DE", "port": "Bremen"},
        {"country": "FR", "port": "Marseille"},
    ]

    def provider(dataset_id: str) -> list[dict]:
        return right

    left_rows = [{"id": 1, "country": "DE"}]
    out_left = run_steps(
        [{"type": "join", "right": "ds_right", "on": "country", "how": "left"}],
        left_rows,
        provider,
    )
    assert len(out_left) == 2
    assert {r["port"] for r in out_left} == {"Hamburg", "Bremen"}
    assert all(r["id"] == 1 for r in out_left)

    out_inner = run_steps(
        [{"type": "join", "right": "ds_right", "on": "country", "how": "inner"}],
        left_rows,
        provider,
    )
    assert len(out_inner) == 2

    unmatched = [{"id": 2, "country": "US"}]
    out_left_unmatched = run_steps(
        [{"type": "join", "right": "ds_right", "on": "country", "how": "left"}],
        unmatched,
        provider,
    )
    assert out_left_unmatched == [{"port": None, "id": 2, "country": "US"}]


def test_step_union() -> None:
    def provider(dataset_id: str) -> list[dict]:
        return [{"id": 99, "name": "extra"}]

    out = run_steps([{"type": "union", "right": "ds_other"}], _ROWS, provider)
    assert len(out) == 4
    assert out[-1]["id"] == 99


def test_unknown_step_type_raises() -> None:
    with pytest.raises(FoundryError):
        run_steps([{"type": "nonsense"}], _ROWS, _provider_empty)


# ── validate_steps (save-time validation, docs/foundry-gap-analysis L10) ─────


def test_validate_steps_happy_path() -> None:
    validate_steps(
        [
            {"type": "select", "columns": ["id", "name"]},
            {"type": "rename", "map": {"name": "callsign"}},
            {"type": "filter", "expr": "speed > 10"},
            {"type": "derive", "column": "kmh", "expr": "speed * 1.852"},
            {"type": "join", "right": "ds_right", "on": "country", "how": "inner"},
            {
                "type": "aggregate",
                "group_by": ["country"],
                "aggs": {"n": "count", "total": "sum:speed"},
            },
            {"type": "union", "right": "ds_other"},
            {"type": "sort", "by": "speed", "desc": True},
            {"type": "limit", "n": 5},
        ]
    )  # no raise


def test_validate_steps_join_defaults_how_to_left() -> None:
    validate_steps([{"type": "join", "right": "ds_right", "on": "country"}])  # no raise


@pytest.mark.parametrize(
    "steps",
    [
        [{"type": "nonsense"}],
        [{"type": "select"}],
        [{"type": "rename"}],
        [{"type": "filter", "expr": "speed >"}],
        [{"type": "derive", "column": "kmh"}],
        [{"type": "join", "right": "ds_right", "on": "country", "how": "outer"}],
        [{"type": "join", "on": "country"}],
        [{"type": "aggregate", "group_by": ["country"], "aggs": {"n": "median:speed"}}],
        [{"type": "aggregate", "group_by": [], "aggs": {"n": "count"}}],
        [{"type": "union"}],
        [{"type": "sort"}],
        [{"type": "limit", "n": 0}],
        [{"type": "limit", "n": -1}],
        [{"type": "limit", "n": "5"}],
        [{"type": "filter", "expr": "__import__('os')"}],
    ],
)
def test_validate_steps_failure_shapes(steps: list[dict]) -> None:
    with pytest.raises(FoundryError):
        validate_steps(steps)


def test_validate_steps_names_index_and_problem() -> None:
    with pytest.raises(FoundryError) as exc_info:
        validate_steps([{"type": "select", "columns": ["id"]}, {"type": "sort"}])
    assert exc_info.value.status_code == 422
    assert "step 1" in exc_info.value.detail
    assert "sort" in exc_info.value.detail
