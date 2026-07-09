"""Wave-5 tests: the correctness/robustness cluster from the 2026-07-09
Foundry assessment — row-level quarantine/dead-letter, non-lossy ingest
coercion + column type-pinning, ReDoS-guarded regex funcs + regex_replace,
pipeline-build error aggregation, and PUT /checks honoring dataset_id.

Same per-test temp SQLite idiom as ``test_foundry.py`` (autouse
``_isolate_foundry_db`` / ``_isolate_ontology_db`` in conftest).
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from app.foundry import ingest, transforms
from app.foundry.transforms import UnsafeExpressionError


def _upload_csv(client: TestClient, name: str, csv_text: str, types: str | None = None) -> dict:
    files = {"file": (f"{name}.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    data = {"name": name, "description": "test"}
    if types is not None:
        data["types"] = types
    r = client.post("/api/foundry/datasets/upload", files=files, data=data)
    assert r.status_code == 200, r.text
    return r.json()


def _rows(client: TestClient, ds_id: str) -> list[dict]:
    r = client.get(f"/api/foundry/datasets/{ds_id}/rows?limit=1000")
    assert r.status_code == 200, r.text
    return r.json()["rows"]


# ── non-lossy ingest coercion (bug #2) ───────────────────────────────────────


def test_cast_scalar_preserves_id_like_strings() -> None:
    # canonical numbers cast; information-bearing forms stay str
    assert ingest._cast_scalar("5") == 5
    assert ingest._cast_scalar("007") == "007"  # leading zero preserved
    assert ingest._cast_scalar("+1") == "+1"
    assert ingest._cast_scalar("1_000") == "1_000"
    assert ingest._cast_scalar("1.852") == 1.852
    assert ingest._cast_scalar("007.0") == "007.0"  # leading-zero float preserved
    assert ingest._cast_scalar("true") is True
    assert ingest._cast_scalar("") is None


def test_upload_preserves_leading_zero_mmsi(client: TestClient) -> None:
    ds = _upload_csv(client, "v5_ids", "mmsi,name\n002190048,ALPHA\n123456789,BETA\n")
    rows = _rows(client, ds["id"])
    assert rows[0]["mmsi"] == "002190048"  # not 2190048
    assert rows[1]["mmsi"] == 123456789  # canonical -> int (would need a pin to force str)


# ── column type-pinning (bug #2) ─────────────────────────────────────────────


def test_type_pin_forces_str(client: TestClient) -> None:
    ds = _upload_csv(
        client, "v5_pin", "mmsi,name\n123456789,BETA\n", types='{"mmsi": "str"}'
    )
    rows = _rows(client, ds["id"])
    assert rows[0]["mmsi"] == "123456789"
    schema = {c["name"]: c["type"] for c in ds["schema"]}
    assert schema["mmsi"] == "str"


def test_type_pin_unknown_type_422(client: TestClient) -> None:
    files = {"file": ("v5_bad.csv", io.BytesIO(b"a\n1\n"), "text/csv")}
    r = client.post(
        "/api/foundry/datasets/upload",
        files=files,
        data={"name": "v5_bad_pin", "types": '{"a": "bogus"}'},
    )
    assert r.status_code == 422, r.text


def test_type_pin_malformed_json_422(client: TestClient) -> None:
    files = {"file": ("v5_bad2.csv", io.BytesIO(b"a\n1\n"), "text/csv")}
    r = client.post(
        "/api/foundry/datasets/upload",
        files=files,
        data={"name": "v5_bad_pin2", "types": "not json"},
    )
    assert r.status_code == 422, r.text


# ── row-level quarantine / dead-letter (bug #1) ──────────────────────────────

_MIXED = "id,val\n1,5\n2,hello\n3,7\n"


def _make_derive_transform(client: TestClient, src_id: str, name: str) -> dict:
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": name,
            "inputs": [src_id],
            "output_name": f"{name}_out",
            # "hello" - 1 raises TypeError -> that row is quarantined, not fatal
            "steps": [{"type": "derive", "column": "dec", "expr": "val - 1"}],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_build_quarantines_bad_row_instead_of_failing(client: TestClient) -> None:
    src = _upload_csv(client, "v5_mixed", _MIXED)
    tf = _make_derive_transform(client, src["id"], "v5_qtf")
    r = client.post(f"/api/foundry/transforms/{tf['id']}/build")
    assert r.status_code == 200, r.text
    build = r.json()
    assert build["status"] == "succeeded"  # one bad row must NOT zero the build
    assert build["rows_out"] == 2  # rows 1 and 3 survived
    assert build["quarantined"] == 1
    assert any("quarantined 1 row" in line for line in build["log"])

    # dead-letter endpoint surfaces the offending row
    dl = client.get(f"/api/foundry/datasets/{tf['output_dataset_id']}/dead-letter")
    assert dl.status_code == 200, dl.text
    entries = dl.json()
    assert len(entries) == 1
    assert entries[0]["step_type"] == "derive"
    assert "TypeError" in entries[0]["error"]
    assert entries[0]["row"]["val"] == "hello"


def test_preview_quarantines_instead_of_500(client: TestClient) -> None:
    src = _upload_csv(client, "v5_mixed2", _MIXED)
    tf = _make_derive_transform(client, src["id"], "v5_qtf2")
    r = client.post(f"/api/foundry/transforms/{tf['id']}/preview", json={"limit": 20})
    assert r.status_code == 200, r.text  # was an unhandled 500 before the fix
    body = r.json()
    assert body["quarantined"] == 1
    assert len(body["rows"]) == 2
    assert len(body["quarantine_sample"]) == 1


def test_clean_rebuild_clears_dead_letter(client: TestClient) -> None:
    src = _upload_csv(client, "v5_mixed3", _MIXED)
    tf = _make_derive_transform(client, src["id"], "v5_qtf3")
    client.post(f"/api/foundry/transforms/{tf['id']}/build")
    # replace source with clean data, rebuild -> dead-letter must clear
    files = {"file": ("v5_mixed3.csv", io.BytesIO(b"id,val\n1,5\n3,7\n"), "text/csv")}
    client.post(f"/api/foundry/datasets/{src['id']}/upload", files=files)
    client.post(f"/api/foundry/transforms/{tf['id']}/build")
    dl = client.get(f"/api/foundry/datasets/{tf['output_dataset_id']}/dead-letter")
    assert dl.json() == []


# ── ReDoS guard + regex_replace (bug #5) ─────────────────────────────────────


def test_catastrophic_patterns_rejected() -> None:
    # catastrophic-backtracking shapes — nested-paren, lazy, and trailing-
    # optional forms that earlier detector versions missed — must be rejected.
    for bad in [
        "(a+)+b", "(a*)*", "(.*)+x", "((a+))+", "((a|b)+)+", "(a{2,})+",
        "(a+?)+", r"(\w+\s?)+", "([a-z]+_?)+",
    ]:
        with pytest.raises(UnsafeExpressionError):
            transforms._safe_pattern(bad)


def test_safe_patterns_not_false_rejected() -> None:
    # linear-safe patterns must compile (no false-positive rejection)
    for good in [
        r"\d+", "(ab*c)+", r"(\d{3}-){2}\d{4}", "(foo|bar)+", "(a{2,5})+",
        "[^0-9]", r"([0-9]{3})-([0-9]+)", "(https?://)", "^UAL[0-9]+$",
    ]:
        assert transforms._safe_pattern(good) is not None


def test_dangerous_literal_pattern_rejected_at_save(client: TestClient) -> None:
    # a catastrophic literal is caught at SAVE (422), before any build runs
    src = _upload_csv(client, "v5_rx", "id,name\n1,x\n")
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": "v5_rxtf",
            "inputs": [src["id"]],
            "output_name": "v5_rx_out",
            "steps": [{"type": "derive", "column": "m", "expr": "regex_match(name, '(a+)+b')"}],
        },
    )
    assert r.status_code == 422, r.text


def test_regex_pattern_must_be_literal(client: TestClient) -> None:
    # a dataset column value can never supply the regex pattern (kills the
    # data-driven-ReDoS vector) — rejected at save with a clear message
    src = _upload_csv(client, "v5_rxlit", "id,name,pat\n1,x,y\n")
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": "v5_rxlit_tf",
            "inputs": [src["id"]],
            "output_name": "v5_rxlit_out",
            "steps": [{"type": "derive", "column": "m", "expr": "regex_match(name, pat)"}],
        },
    )
    assert r.status_code == 422, r.text
    assert "literal" in r.json()["detail"].lower()


def test_regex_replace_strips_non_digits() -> None:
    tree = transforms.compile_expr("regex_replace(code, '[^0-9]', '')")
    assert transforms.eval_expr(tree, {"code": "AB-12 34"}) == "1234"
    assert transforms.eval_expr(tree, {"code": None}) is None
    assert transforms.eval_expr(tree, {"code": 1234}) == "1234"  # non-str coerced


def test_regex_replace_no_truncation() -> None:
    # regex_replace must run on the FULL value, not a 100k-truncated copy
    big = "x" * 150_000
    tree = transforms.compile_expr("regex_replace(v, 'y', 'z')")  # no match -> unchanged
    assert transforms.eval_expr(tree, {"v": big}) == big


def test_regex_replace_unsafe_pattern_rejected_at_compile() -> None:
    with pytest.raises(UnsafeExpressionError):
        transforms.compile_expr("regex_replace(v, '(a+)+b', 'z')")


def test_coerce_float_pin_infinity_dropped() -> None:
    assert ingest._coerce_to("1e999", "float") is None  # inf would break JSON
    assert ingest._coerce_to("1.5", "float") == 1.5


# ── sort tolerates mixed types (review 2026-07-09) ───────────────────────────


def test_sort_mixed_types_does_not_abort() -> None:
    rows = [{"x": "abc"}, {"x": 5}, {"x": None}, {"x": 2}]
    out = transforms.run_steps([{"type": "sort", "by": "x"}], rows, lambda _: [])
    # numbers ordered, then strings, None last — no TypeError
    assert [r["x"] for r in out] == [2, 5, "abc", None]


def test_sort_mixed_types_build_succeeds(client: TestClient) -> None:
    # JSON upload keeps heterogeneous values; a sort must not zero the build
    files = {"file": ("v5_sortmix.json", io.BytesIO(b'[{"x":"a"},{"x":5}]'), "application/json")}
    client.post("/api/foundry/datasets/upload", files=files, data={"name": "v5_sortmix"})
    src = client.get("/api/foundry/datasets").json()
    sid = next(d["id"] for d in src if d["name"] == "v5_sortmix")
    r = client.post(
        "/api/foundry/transforms",
        json={"name": "v5_sorttf", "inputs": [sid], "output_name": "v5_sort_out",
              "steps": [{"type": "sort", "by": "x"}]},
    )
    b = client.post(f"/api/foundry/transforms/{r.json()['id']}/build")
    assert b.status_code == 200 and b.json()["status"] == "succeeded", b.text


# ── sequence-repetition allocation guard (review 2026-07-09) ──────────────────


def test_sequence_repeat_guard_quarantines() -> None:
    tree = transforms.compile_expr("s * n")
    with pytest.raises(ValueError):
        transforms.eval_expr(tree, {"s": "x", "n": 10**9})
    # ordinary repetition still works
    assert transforms.eval_expr(tree, {"s": "ab", "n": 3}) == "ababab"


# ── ingest: float overflow + coerce sci-notation (review 2026-07-09) ──────────


def test_cast_scalar_overflow_stays_string() -> None:
    assert ingest._cast_scalar("1e999") == "1e999"  # inf would break JSON
    assert ingest._cast_scalar("-1e400") == "-1e400"


def test_coerce_int_scientific_notation() -> None:
    assert ingest._coerce_to("1e3", "int") == 1000  # was None before the fix
    assert ingest._coerce_to("1.0e3", "int") == 1000
    assert ingest._coerce_to("1.9", "int") == 1
    assert ingest._coerce_to("nope", "int") is None


# ── malformed upload -> 422 not 500 (review 2026-07-09) ──────────────────────


def test_malformed_json_upload_422(client: TestClient) -> None:
    files = {"file": ("bad.json", io.BytesIO(b"{not valid json"), "application/json")}
    r = client.post("/api/foundry/datasets/upload", files=files, data={"name": "v5_badjson"})
    assert r.status_code == 422, r.text


# ── dead-letter survives a failed rebuild (review 2026-07-09) ─────────────────


def test_dead_letter_preserved_on_failed_rebuild(client: TestClient) -> None:
    src = _upload_csv(client, "v5_dlsrc", _MIXED)
    tf = client.post(
        "/api/foundry/transforms",
        json={"name": "v5_dltf", "inputs": [src["id"]], "output_name": "v5_dl_out",
              "steps": [{"type": "derive", "column": "dec", "expr": "val - 1"}]},
    ).json()
    out_id = tf["output_dataset_id"]
    client.post(f"/api/foundry/transforms/{tf['id']}/build")  # quarantines 1 row
    assert len(client.get(f"/api/foundry/datasets/{out_id}/dead-letter").json()) == 1
    # now add a fail-severity check that the next build violates, then rebuild
    client.post("/api/foundry/checks", json={
        "dataset_id": out_id, "name": "gate", "type": "row_count_max",
        "params": {"max": 0}, "severity": "fail"})
    b = client.post(f"/api/foundry/transforms/{tf['id']}/build")
    assert b.json()["status"] == "failed"
    # the previous version's dead-letter must be intact, not wiped by the failed write
    assert len(client.get(f"/api/foundry/datasets/{out_id}/dead-letter").json()) == 1


# ── checks_failing_count clears on reassign (review 2026-07-09) ───────────────


def test_checks_failing_clears_on_reassign(client: TestClient) -> None:
    a = _upload_csv(client, "v5_cfa", "id\n1\n")
    b = _upload_csv(client, "v5_cfb", "id\n1\n")
    c = client.post("/api/foundry/checks", json={
        "dataset_id": a["id"], "name": "cf", "type": "row_count_min",
        "params": {"min": 999}, "severity": "warn"}).json()
    # trigger evaluation on A so a failing result is recorded
    files = {"file": ("v5_cfa.csv", io.BytesIO(b"id\n1\n2\n"), "text/csv")}
    client.post(f"/api/foundry/datasets/{a['id']}/upload", files=files)
    assert client.get("/api/foundry/summary").json()["checks_failing"] == 1
    # reassign the check to B -> its stale failing result must be cleared
    client.put(f"/api/foundry/checks/{c['id']}", json={
        "dataset_id": b["id"], "name": "cf", "type": "row_count_min",
        "params": {"min": 999}, "severity": "warn", "enabled": True})
    assert client.get("/api/foundry/summary").json()["checks_failing"] == 0


def test_update_check_same_dataset_keeps_results(client: TestClient) -> None:
    # a rename/param edit that does NOT change the dataset must preserve the
    # check's recorded results (only an actual reassignment clears them)
    a = _upload_csv(client, "v5_keep", "id\n1\n")
    c = client.post("/api/foundry/checks", json={
        "dataset_id": a["id"], "name": "k", "type": "row_count_min",
        "params": {"min": 999}, "severity": "warn"}).json()
    files = {"file": ("v5_keep.csv", io.BytesIO(b"id\n1\n2\n"), "text/csv")}
    client.post(f"/api/foundry/datasets/{a['id']}/upload", files=files)
    assert client.get("/api/foundry/summary").json()["checks_failing"] == 1
    client.put(f"/api/foundry/checks/{c['id']}", json={
        "dataset_id": a["id"], "name": "k-renamed", "type": "row_count_min",
        "params": {"min": 999}, "severity": "warn", "enabled": True})
    assert client.get("/api/foundry/summary").json()["checks_failing"] == 1


# ── pipeline-build error aggregation (bug #3) ────────────────────────────────


def _failing_transform(client: TestClient, src_id: str, name: str) -> str:
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": name,
            "inputs": [src_id],
            "output_name": f"{name}_out",
            "steps": [{"type": "select", "columns": ["id"]}],
        },
    )
    assert r.status_code == 200, r.text
    tf = r.json()
    # a fail-severity check that always fails -> the build fails
    c = client.post(
        "/api/foundry/checks",
        json={
            "dataset_id": tf["output_dataset_id"],
            "name": f"{name}_gate",
            "type": "row_count_max",
            "params": {"max": 0},
            "severity": "fail",
        },
    )
    assert c.status_code == 200, c.text
    return name


def test_pipeline_build_aggregates_all_failures(client: TestClient) -> None:
    src = _upload_csv(client, "v5_pipe_src", "id\n1\n2\n")
    n1 = _failing_transform(client, src["id"], "v5_failA")
    n2 = _failing_transform(client, src["id"], "v5_failB")
    r = client.post("/api/foundry/pipeline/build", json={"only_stale": False})
    assert r.status_code == 200, r.text
    build = r.json()
    assert build["status"] == "failed"
    # BOTH failures present in the queryable error field, not just the last
    assert n1 in build["error"]
    assert n2 in build["error"]


# ── PUT /checks honors dataset_id (bug #6) ───────────────────────────────────


def test_update_check_reassigns_dataset(client: TestClient) -> None:
    a = _upload_csv(client, "v5_ck_a", "id\n1\n")
    b = _upload_csv(client, "v5_ck_b", "id\n1\n")
    c = client.post(
        "/api/foundry/checks",
        json={"dataset_id": a["id"], "name": "ck", "type": "not_null", "params": {"column": "id"}},
    )
    assert c.status_code == 200, c.text
    cid = c.json()["id"]
    r = client.put(
        f"/api/foundry/checks/{cid}",
        json={
            "dataset_id": b["id"],
            "name": "ck",
            "type": "not_null",
            "params": {"column": "id"},
            "severity": "warn",
            "enabled": True,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["dataset_id"] == b["id"]
    # now listed under b, not a
    assert any(x["id"] == cid for x in client.get(f"/api/foundry/checks?dataset_id={b['id']}").json())
    assert not any(x["id"] == cid for x in client.get(f"/api/foundry/checks?dataset_id={a['id']}").json())


def test_update_check_unknown_dataset_404(client: TestClient) -> None:
    a = _upload_csv(client, "v5_ck_c", "id\n1\n")
    c = client.post(
        "/api/foundry/checks",
        json={"dataset_id": a["id"], "name": "ck", "type": "not_null", "params": {"column": "id"}},
    )
    cid = c.json()["id"]
    r = client.put(
        f"/api/foundry/checks/{cid}",
        json={
            "dataset_id": "ds_does_not_exist",
            "name": "ck",
            "type": "not_null",
            "params": {"column": "id"},
            "severity": "warn",
            "enabled": True,
        },
    )
    assert r.status_code == 404, r.text
