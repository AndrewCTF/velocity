"""Wave-6 tests: the in-scope capability enhancements from the 2026-07-09
assessment — new DSL steps (dedup/cast), column-level lineage, Data Docs, and
the file-arrival cascade build on upload.

Same per-test temp SQLite idiom as ``test_foundry.py``.
"""

from __future__ import annotations

import io

from fastapi.testclient import TestClient

from app.foundry import transforms


def _upload_csv(client: TestClient, name: str, csv_text: str) -> dict:
    files = {"file": (f"{name}.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    r = client.post("/api/foundry/datasets/upload", files=files, data={"name": name})
    assert r.status_code == 200, r.text
    return r.json()


def _transform(client: TestClient, src_id: str, name: str, steps: list[dict]) -> dict:
    r = client.post(
        "/api/foundry/transforms",
        json={"name": name, "inputs": [src_id], "output_name": f"{name}_out", "steps": steps},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _build_rows(client: TestClient, tf: dict) -> list[dict]:
    b = client.post(f"/api/foundry/transforms/{tf['id']}/build")
    assert b.status_code == 200 and b.json()["status"] == "succeeded", b.text
    r = client.get(f"/api/foundry/datasets/{tf['output_dataset_id']}/rows?limit=1000")
    return r.json()["rows"]


# ── dedup step ───────────────────────────────────────────────────────────────


def test_dedup_by_column() -> None:
    rows = [{"k": 1, "v": "a"}, {"k": 1, "v": "b"}, {"k": 2, "v": "c"}]
    out = transforms.run_steps([{"type": "dedup", "by": ["k"]}], rows, lambda _: [])
    assert out == [{"k": 1, "v": "a"}, {"k": 2, "v": "c"}]


def test_dedup_whole_row() -> None:
    rows = [{"k": 1}, {"k": 1}, {"k": 2}]
    out = transforms.run_steps([{"type": "dedup"}], rows, lambda _: [])
    assert out == [{"k": 1}, {"k": 2}]


def test_dedup_build_end_to_end(client: TestClient) -> None:
    src = _upload_csv(client, "v6_dd", "k,v\n1,a\n1,b\n2,c\n")
    tf = _transform(client, src["id"], "v6_ddtf", [{"type": "dedup", "by": ["k"]}])
    assert len(_build_rows(client, tf)) == 2


# ── cast step ────────────────────────────────────────────────────────────────


def test_cast_step_str_to_int() -> None:
    rows = [{"n": "5"}, {"n": "x"}]
    out = transforms.run_steps([{"type": "cast", "column": "n", "to": "int"}], rows, lambda _: [])
    assert out == [{"n": 5}, {"n": None}]  # unconvertible -> None


def test_cast_step_validation_bad_type(client: TestClient) -> None:
    src = _upload_csv(client, "v6_cast", "n\n1\n")
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": "v6_castbad",
            "inputs": [src["id"]],
            "output_name": "v6_castbad_out",
            "steps": [{"type": "cast", "column": "n", "to": "bogus"}],
        },
    )
    assert r.status_code == 422, r.text


# ── column-level lineage ─────────────────────────────────────────────────────


def test_column_lineage_function() -> None:
    steps = [
        {"type": "rename", "map": {"a": "x"}},
        {"type": "derive", "column": "y", "expr": "b * 2"},
    ]
    lin = transforms.column_lineage(steps, ["a", "b"])
    assert lin["x"] == ["a"]
    assert lin["b"] == ["b"]
    assert lin["y"] == ["b"]


def test_column_lineage_aggregate() -> None:
    steps = [{"type": "aggregate", "group_by": ["region"], "aggs": {"total": "sum:sales", "n": "count"}}]
    lin = transforms.column_lineage(steps, ["region", "sales"])
    assert lin["region"] == ["region"]
    assert lin["total"] == ["sales"]
    assert lin["n"] == []  # count derives from no single column


def test_column_lineage_endpoint(client: TestClient) -> None:
    src = _upload_csv(client, "v6_lin", "a,b\n1,2\n")
    tf = _transform(
        client,
        src["id"],
        "v6_lintf",
        [{"type": "derive", "column": "y", "expr": "a + b"}],
    )
    client.post(f"/api/foundry/transforms/{tf['id']}/build")
    r = client.get(f"/api/foundry/datasets/{tf['output_dataset_id']}/column-lineage")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["produced_by"] == "v6_lintf"
    assert sorted(body["columns"]["y"]) == ["a", "b"]


def test_column_lineage_raw_is_identity(client: TestClient) -> None:
    src = _upload_csv(client, "v6_raw", "a,b\n1,2\n")
    r = client.get(f"/api/foundry/datasets/{src['id']}/column-lineage")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["produced_by"] is None
    assert body["columns"]["a"] == ["a"]


# ── Data Docs ────────────────────────────────────────────────────────────────


def test_dataset_docs(client: TestClient) -> None:
    src = _upload_csv(client, "v6_docs", "id,name\n1,alpha\n")
    client.post(
        "/api/foundry/checks",
        json={"dataset_id": src["id"], "name": "id_nn", "type": "not_null", "params": {"column": "id"}},
    )
    _transform(client, src["id"], "v6_docstf", [{"type": "select", "columns": ["id"]}])
    r = client.get(f"/api/foundry/datasets/{src['id']}/docs")
    assert r.status_code == 200, r.text
    docs = r.json()
    assert docs["dataset"]["name"] == "v6_docs"
    assert {c["name"] for c in docs["schema"]} == {"id", "name"}
    assert any(c["name"] == "id_nn" for c in docs["checks"])
    # src is upstream of the transform -> downstream lists it
    assert any(d["transform"] == "v6_docstf" for d in docs["lineage"]["downstream"])


def test_dataset_docs_404(client: TestClient) -> None:
    assert client.get("/api/foundry/datasets/ds_nope/docs").status_code == 404


# ── file-arrival cascade ─────────────────────────────────────────────────────


def test_cascade_build_on_upload(client: TestClient) -> None:
    src = _upload_csv(client, "v6_casc", "id,v\n1,10\n")
    tf = _transform(client, src["id"], "v6_casctf", [{"type": "select", "columns": ["id", "v"]}])
    # build once so it's not stale, then upload a new version WITH cascade
    client.post(f"/api/foundry/transforms/{tf['id']}/build")
    files = {"file": ("v6_casc.csv", io.BytesIO(b"id,v\n1,10\n2,20\n"), "text/csv")}
    r = client.post(
        f"/api/foundry/datasets/{src['id']}/upload", files=files, data={"cascade": "true"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["cascade_build"]["status"] == "succeeded"
    # derived dataset now has the 2 new rows without an explicit build call
    rows = client.get(f"/api/foundry/datasets/{tf['output_dataset_id']}/rows?limit=100").json()["rows"]
    assert len(rows) == 2
