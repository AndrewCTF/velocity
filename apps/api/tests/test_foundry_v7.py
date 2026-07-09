"""Wave-7 tests: real-Foundry parity additions — Data Health SLAs (freshness,
schema_contract checks) and analytic transforms (window, pivot).

Unit-level for the pure evaluators/steps + a couple of API integration cases.
"""

from __future__ import annotations

import io
import time

import pytest
from fastapi.testclient import TestClient

from app.foundry import transforms
from app.foundry.checks import evaluate_check, validate_check
from app.foundry.store import FoundryError

_SCHEMA = [{"name": "ts", "type": "str"}, {"name": "v", "type": "int"}]


# ── freshness check ───────────────────────────────────────────────────────────


def test_freshness_pass_and_fail() -> None:
    now = time.time()
    fresh = [{"ts": now - 5}]
    stale = [{"ts": now - 10_000}]
    ok, _ = evaluate_check("freshness", {"column": "ts", "max_age_s": 60}, fresh, _SCHEMA)
    assert ok is True
    bad, detail = evaluate_check("freshness", {"column": "ts", "max_age_s": 60}, stale, _SCHEMA)
    assert bad is False and "old" in detail


def test_freshness_accepts_iso_strings() -> None:
    from datetime import UTC, datetime

    recent = datetime.now(tz=UTC).isoformat()
    ok, _ = evaluate_check("freshness", {"column": "ts", "max_age_s": 3600}, [{"ts": recent}], _SCHEMA)
    assert ok is True


def test_freshness_no_timestamps_fails() -> None:
    ok, detail = evaluate_check("freshness", {"column": "ts", "max_age_s": 60}, [{"ts": "nope"}], _SCHEMA)
    assert ok is False and "no valid" in detail


def test_freshness_ms_epoch_normalized() -> None:
    # a millisecond epoch (JS Date.now()) must be read as ~now, not year 57000
    now_ms = time.time() * 1000
    ok, _ = evaluate_check("freshness", {"column": "ts", "max_age_s": 60}, [{"ts": now_ms}], _SCHEMA)
    assert ok is True


def test_freshness_future_outlier_ignored() -> None:
    # a single future-dated typo must not mask genuinely stale data
    now = time.time()
    rows = [{"ts": now - 10_000}, {"ts": "2099-01-01T00:00:00Z"}]
    ok, _ = evaluate_check("freshness", {"column": "ts", "max_age_s": 60}, rows, _SCHEMA)
    assert ok is False


def test_freshness_validation() -> None:
    with pytest.raises(FoundryError):
        validate_check("freshness", {"column": "ts"})  # missing max_age_s
    with pytest.raises(FoundryError):
        validate_check("freshness", {"column": "ts", "max_age_s": -1})
    validate_check("freshness", {"column": "ts", "max_age_s": 60})  # ok


# ── schema_contract check ─────────────────────────────────────────────────────


def test_schema_contract_pass_and_missing() -> None:
    schema = [{"name": "id", "type": "int"}, {"name": "name", "type": "str"}]
    ok, _ = evaluate_check("schema_contract", {"columns": ["id", "name"]}, [], schema)
    assert ok is True
    bad, detail = evaluate_check("schema_contract", {"columns": ["id", "email"]}, [], schema)
    assert bad is False and "missing" in detail


def test_schema_contract_real_type_drift() -> None:
    schema = [{"name": "id", "type": "str"}]
    rows = [{"id": "abc"}]  # actual non-int value
    ok, detail = evaluate_check("schema_contract", {"columns": ["id"], "types": {"id": "int"}}, rows, schema)
    assert ok is False and "drift" in detail


def test_schema_contract_all_null_column_ok() -> None:
    # a column all-null this batch infers 'str' but has no wrong value -> no drift
    schema = [{"name": "count", "type": "str"}]
    rows = [{"count": None}, {"count": None}]
    ok, _ = evaluate_check("schema_contract", {"columns": ["count"], "types": {"count": "int"}}, rows, schema)
    assert ok is True


def test_schema_contract_int_valued_floats_ok() -> None:
    # 1.0/2.0 satisfy an int contract (integer-valued)
    schema = [{"name": "n", "type": "float"}]
    rows = [{"n": 1.0}, {"n": 2.0}]
    ok, _ = evaluate_check("schema_contract", {"columns": ["n"], "types": {"n": "int"}}, rows, schema)
    assert ok is True


def test_schema_contract_validation() -> None:
    with pytest.raises(FoundryError):
        validate_check("schema_contract", {"columns": []})
    with pytest.raises(FoundryError):
        validate_check("schema_contract", {"columns": ["a"], "types": {"a": "bogus"}})
    validate_check("schema_contract", {"columns": ["a"], "types": {"a": "int"}})


def test_schema_contract_gate_blocks_upload(client: TestClient) -> None:
    files = {"file": ("v7sc.csv", io.BytesIO(b"id\n1\n"), "text/csv")}
    ds = client.post("/api/foundry/datasets/upload", files=files, data={"name": "v7_sc"}).json()
    # require a column the next upload won't have, severity fail
    client.post("/api/foundry/checks", json={
        "dataset_id": ds["id"], "name": "contract", "type": "schema_contract",
        "params": {"columns": ["id", "required_col"]}, "severity": "fail"})
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload",
                    files={"file": ("v7sc.csv", io.BytesIO(b"id\n2\n"), "text/csv")})
    assert r.status_code == 422, r.text  # missing required_col blocks the write


# ── window transform ──────────────────────────────────────────────────────────


def _run(step: dict, rows: list[dict]) -> list[dict]:
    return transforms.run_steps([step], rows, lambda _: [])


def test_window_row_number_partitioned() -> None:
    rows = [{"g": "a", "t": 2}, {"g": "a", "t": 1}, {"g": "b", "t": 5}]
    out = _run({"type": "window", "partition_by": ["g"], "order_by": "t", "fn": "row_number", "into": "rn"}, rows)
    by = {(r["g"], r["t"]): r["rn"] for r in out}
    assert by[("a", 1)] == 1 and by[("a", 2)] == 2 and by[("b", 5)] == 1
    assert [r["g"] for r in out] == ["a", "a", "b"]  # input order preserved


def test_window_rank_ties() -> None:
    rows = [{"s": 10}, {"s": 10}, {"s": 20}]
    out = _run({"type": "window", "order_by": "s", "fn": "rank", "into": "rk"}, rows)
    ranks = sorted(r["rk"] for r in out)
    assert ranks == [1, 1, 3]  # tie shares rank, next skips


def test_window_lag_and_running_sum() -> None:
    rows = [{"t": 1, "v": 5}, {"t": 2, "v": 3}, {"t": 3, "v": 2}]
    lag = _run({"type": "window", "order_by": "t", "fn": "lag:v", "into": "prev"}, rows)
    assert [r["prev"] for r in lag] == [None, 5, 3]
    rs = _run({"type": "window", "order_by": "t", "fn": "running_sum:v", "into": "cum"}, rows)
    assert [r["cum"] for r in rs] == [5, 8, 10]


def test_window_validation() -> None:
    with pytest.raises(FoundryError):
        transforms.validate_steps([{"type": "window", "fn": "bogus", "into": "x"}])
    with pytest.raises(FoundryError):
        transforms.validate_steps([{"type": "window", "fn": "lag", "into": "x"}])  # lag needs :col
    transforms.validate_steps([{"type": "window", "fn": "lag:v", "into": "x", "order_by": "t"}])


def test_window_rank_requires_order_by() -> None:
    # rank/lag/running_sum are meaningless without an order key
    with pytest.raises(FoundryError):
        transforms.validate_steps([{"type": "window", "fn": "rank", "into": "r"}])
    with pytest.raises(FoundryError):
        transforms.validate_steps([{"type": "window", "fn": "running_sum:v", "into": "c"}])
    # row_number may omit order_by
    transforms.validate_steps([{"type": "window", "fn": "row_number", "into": "n"}])


# ── pivot transform ───────────────────────────────────────────────────────────


def test_pivot_sum() -> None:
    rows = [
        {"region": "EU", "kind": "cargo", "n": 3},
        {"region": "EU", "kind": "tanker", "n": 2},
        {"region": "EU", "kind": "cargo", "n": 1},
        {"region": "US", "kind": "cargo", "n": 5},
    ]
    out = _run({"type": "pivot", "index": ["region"], "column": "kind", "value": "n", "agg": "sum"}, rows)
    eu = next(r for r in out if r["region"] == "EU")
    us = next(r for r in out if r["region"] == "US")
    assert eu["cargo"] == 4 and eu["tanker"] == 2
    assert us["cargo"] == 5 and us.get("tanker") == 0  # missing cell -> sum of [] = 0


def test_pivot_count() -> None:
    rows = [{"g": "a", "k": "x", "v": 1}, {"g": "a", "k": "x", "v": 9}]
    out = _run({"type": "pivot", "index": ["g"], "column": "k", "value": "v", "agg": "count"}, rows)
    assert out[0]["x"] == 2


def test_pivot_index_collision_raises() -> None:
    # a pivot column value equal to an index column name would clobber the key
    rows = [{"dept": "A", "attr": "dept", "amt": 5}]
    with pytest.raises(FoundryError):
        _run({"type": "pivot", "index": ["dept"], "column": "attr", "value": "amt", "agg": "sum"}, rows)


def test_pivot_validation() -> None:
    with pytest.raises(FoundryError):
        transforms.validate_steps([{"type": "pivot", "index": [], "column": "k", "value": "v"}])
    with pytest.raises(FoundryError):
        transforms.validate_steps([{"type": "pivot", "index": ["g"], "column": "k", "value": "v", "agg": "bogus"}])
    transforms.validate_steps([{"type": "pivot", "index": ["g"], "column": "k", "value": "v"}])


def test_window_build_end_to_end(client: TestClient) -> None:
    files = {"file": ("v7w.csv", io.BytesIO(b"g,t,v\na,1,5\na,2,3\nb,1,9\n"), "text/csv")}
    ds = client.post("/api/foundry/datasets/upload", files=files, data={"name": "v7_win"}).json()
    tf = client.post("/api/foundry/transforms", json={
        "name": "v7_wintf", "inputs": [ds["id"]], "output_name": "v7_win_out",
        "steps": [{"type": "window", "partition_by": ["g"], "order_by": "t", "fn": "running_sum:v", "into": "cum"}]}).json()
    b = client.post(f"/api/foundry/transforms/{tf['id']}/build")
    assert b.status_code == 200 and b.json()["status"] == "succeeded", b.text
    rows = client.get(f"/api/foundry/datasets/{tf['output_dataset_id']}/rows?limit=50").json()["rows"]
    cum = {(r["g"], r["t"]): r["cum"] for r in rows}
    assert cum[("a", 1)] == 5 and cum[("a", 2)] == 8 and cum[("b", 1)] == 9
