"""Guard: Foundry v2 additions — append transactions, rollback, build
input-version tracking + staleness, only-stale pipeline builds, cycle
rejection on transform writes, and data-expectation checks.

Mirrors ``test_foundry.py``'s style/fixtures (per-test temp SQLite store via
the autouse ``_isolate_foundry_db`` conftest hook).
"""

from __future__ import annotations

import io

from fastapi.testclient import TestClient

_CSV = "id,name,speed,country\n1,alpha,12,DE\n2,beta,5,FR\n3,gamma,20,DE\n"


def _upload_csv(client: TestClient, name: str, csv_text: str) -> dict:
    files = {"file": (f"{name}.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    data = {"name": name, "description": "test dataset"}
    r = client.post("/api/foundry/datasets/upload", files=files, data=data)
    assert r.status_code == 200, r.text
    return r.json()


def _upload_version(client: TestClient, dataset_id: str, csv_text: str, mode: str | None = None) -> dict:
    files = {"file": ("v.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    data = {"mode": mode} if mode else {}
    r = client.post(f"/api/foundry/datasets/{dataset_id}/upload", files=files, data=data)
    return r


def _make_transform(client: TestClient, input_ds_id: str, output_name: str, steps: list[dict]) -> dict:
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": output_name + "_tf",
            "description": "",
            "inputs": [input_ds_id],
            "output_name": output_name,
            "steps": steps,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


# ── append transactions ──────────────────────────────────────────────────────


def test_append_mode_default_is_snapshot(client: TestClient) -> None:
    ds = _upload_csv(client, "app_default", _CSV)
    v2 = b"id,name,speed,country\n4,delta,9,US\n"
    files = {"file": ("v2.csv", io.BytesIO(v2), "text/csv")}
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files)
    assert r.status_code == 200, r.text
    ds2 = r.json()
    assert ds2["row_count"] == 1  # snapshot replaces, does not append


def test_append_mode_combines_rows_and_unions_schema(client: TestClient) -> None:
    ds = _upload_csv(client, "app_combine", _CSV)
    v2 = "id,name,speed,country,extra\n4,delta,9,US,x\n"
    r = _upload_version(client, ds["id"], v2, mode="append")
    assert r.status_code == 200, r.text
    ds2 = r.json()
    assert ds2["row_count"] == 4
    assert ds2["latest_version"] == 2
    names = {c["name"] for c in ds2["schema"]}
    assert names == {"id", "name", "speed", "country", "extra"}

    rows = client.get(f"/api/foundry/datasets/{ds['id']}/rows").json()
    assert rows["total"] == 4
    ids = {r["id"] for r in rows["rows"]}
    assert ids == {1, 2, 3, 4}

    versions = client.get(f"/api/foundry/datasets/{ds['id']}/versions").json()
    assert versions[0]["source"] == "upload:append"


def test_append_enforces_row_cap(client: TestClient, monkeypatch) -> None:
    ds = _upload_csv(client, "app_cap", _CSV)  # 3 rows already
    monkeypatch.setattr("app.foundry.store.MAX_ROWS_PER_DATASET", 4)
    v2 = "id\n4\n5\n"
    r = _upload_version(client, ds["id"], v2, mode="append")
    assert r.status_code == 422, r.text


def test_append_404_unknown_dataset(client: TestClient) -> None:
    r = _upload_version(client, "ds_nope", "id\n1\n", mode="append")
    assert r.status_code == 404


def test_append_410_when_latest_pruned(client: TestClient, monkeypatch) -> None:
    ds = client.post("/api/foundry/datasets", json={"name": "app_pruned"}).json()
    monkeypatch.setattr("app.foundry.store.KEEP_VERSIONS", 0)
    r1 = _upload_version(client, ds["id"], _CSV)
    assert r1.status_code == 200, r1.text
    r2 = _upload_version(client, ds["id"], "id\n9\n", mode="append")
    assert r2.status_code == 410, r2.text


def test_append_unknown_mode_422(client: TestClient) -> None:
    ds = _upload_csv(client, "app_bad_mode", _CSV)
    r = _upload_version(client, ds["id"], "id\n1\n", mode="bogus")
    assert r.status_code == 422


# ── rollback ─────────────────────────────────────────────────────────────────


def test_rollback_creates_new_version_copying_target(client: TestClient) -> None:
    ds = _upload_csv(client, "rb_basic", _CSV)  # v1, 3 rows
    _upload_version(client, ds["id"], "id,name,speed,country\n4,delta,9,US\n")  # v2, 1 row
    r = client.post(f"/api/foundry/datasets/{ds['id']}/rollback", json={"version": 1})
    assert r.status_code == 200, r.text
    ver = r.json()
    assert ver["version"] == 3
    assert ver["row_count"] == 3
    assert ver["source"] == "rollback:1"

    rows = client.get(f"/api/foundry/datasets/{ds['id']}/rows").json()
    ids = {row["id"] for row in rows["rows"]}
    assert ids == {1, 2, 3}


def test_rollback_404_unknown_dataset(client: TestClient) -> None:
    r = client.post("/api/foundry/datasets/ds_nope/rollback", json={"version": 1})
    assert r.status_code == 404


def test_rollback_422_unknown_version(client: TestClient) -> None:
    ds = _upload_csv(client, "rb_unknown_ver", _CSV)
    r = client.post(f"/api/foundry/datasets/{ds['id']}/rollback", json={"version": 99})
    assert r.status_code == 422


def test_rollback_410_when_target_pruned(client: TestClient, monkeypatch) -> None:
    ds = _upload_csv(client, "rb_pruned", _CSV)  # v1
    monkeypatch.setattr("app.foundry.store.KEEP_VERSIONS", 1)
    _upload_version(client, ds["id"], "id\n9\n")  # v2 — prunes v1's rows
    r = client.post(f"/api/foundry/datasets/{ds['id']}/rollback", json={"version": 1})
    assert r.status_code == 410, r.text


# ── build input-version tracking + staleness ────────────────────────────────


def test_build_records_input_versions(client: TestClient) -> None:
    ds = _upload_csv(client, "iv_src", _CSV)
    t = _make_transform(client, ds["id"], "iv_out", [{"type": "limit", "n": 2}])
    build = client.post(f"/api/foundry/transforms/{t['id']}/build").json()
    assert build["input_versions"] == {ds["id"]: 1}


def test_lineage_stale_flags(client: TestClient) -> None:
    ds = _upload_csv(client, "stale_src", _CSV)
    t = _make_transform(client, ds["id"], "stale_out", [{"type": "limit", "n": 2}])

    # never built: transform + derived dataset both stale
    lineage = client.get("/api/foundry/lineage").json()
    by_id = {n["id"]: n for n in lineage["nodes"]}
    assert by_id[t["id"]]["stale"] is True
    assert by_id[t["output_dataset_id"]]["stale"] is True
    # raw (source) dataset never gets a stale flag
    assert "stale" not in by_id[ds["id"]]

    build = client.post(f"/api/foundry/transforms/{t['id']}/build").json()
    assert build["status"] == "succeeded"
    lineage2 = client.get("/api/foundry/lineage").json()
    by_id2 = {n["id"]: n for n in lineage2["nodes"]}
    assert by_id2[t["id"]]["stale"] is False
    assert by_id2[t["output_dataset_id"]]["stale"] is False

    # a new input version makes the transform stale again
    _upload_version(client, ds["id"], "id,name,speed,country\n9,z,1,US\n")
    lineage3 = client.get("/api/foundry/lineage").json()
    by_id3 = {n["id"]: n for n in lineage3["nodes"]}
    assert by_id3[t["id"]]["stale"] is True
    assert by_id3[t["output_dataset_id"]]["stale"] is True


def test_pipeline_build_only_stale_skips_fresh_transforms(client: TestClient) -> None:
    ds = _upload_csv(client, "os_src", _CSV)
    t = _make_transform(client, ds["id"], "os_out", [{"type": "limit", "n": 1}])
    r1 = client.post("/api/foundry/pipeline/build", json={"only_stale": True})
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert any(t["name"] in line and "succeeded" in line for line in body1["log"])

    # second run: nothing changed, transform is fresh -> skipped
    r2 = client.post("/api/foundry/pipeline/build", json={"only_stale": True})
    body2 = r2.json()
    assert any("skipped" in line for line in body2["log"])
    assert not any("succeeded" in line and t["name"] in line for line in body2["log"])


def test_pipeline_build_default_rebuilds_everything(client: TestClient) -> None:
    ds = _upload_csv(client, "default_src", _CSV)
    t = _make_transform(client, ds["id"], "default_out", [{"type": "limit", "n": 1}])
    client.post(f"/api/foundry/transforms/{t['id']}/build")
    r = client.post("/api/foundry/pipeline/build")  # no body -> only_stale defaults False
    assert r.status_code == 200, r.text
    body = r.json()
    assert any("succeeded" in line for line in body["log"])
    assert not any("skipped" in line for line in body["log"])


# ── cycle rejection ──────────────────────────────────────────────────────────


def test_create_transform_self_loop_rejected(client: TestClient) -> None:
    ds = _upload_csv(client, "cyc_self", _CSV)
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": "cyc_self_tf",
            "inputs": [ds["id"]],
            "output_name": "cyc_self",  # same as input dataset's name -> self loop
            "steps": [{"type": "limit", "n": 1}],
        },
    )
    assert r.status_code == 422, r.text


def test_create_transform_two_hop_cycle_rejected(client: TestClient) -> None:
    ds_a = _upload_csv(client, "cyc_a", _CSV)
    t1 = _make_transform(client, ds_a["id"], "cyc_b", [{"type": "limit", "n": 1}])
    # t2: input cyc_b (t1's output) -> output cyc_a (t1's input) closes a cycle
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": "cyc_b_to_a",
            "inputs": [t1["output_dataset_id"]],
            "output_name": "cyc_a",
            "steps": [{"type": "limit", "n": 1}],
        },
    )
    assert r.status_code == 422, r.text


def test_update_transform_introducing_cycle_rejected(client: TestClient) -> None:
    ds_a = _upload_csv(client, "cyc_upd_a", _CSV)
    ds_b = client.post("/api/foundry/datasets", json={"name": "cyc_upd_b"}).json()
    t1 = _make_transform(client, ds_a["id"], "cyc_upd_out1", [{"type": "limit", "n": 1}])
    t2 = _make_transform(client, ds_b["id"], "cyc_upd_out2", [{"type": "limit", "n": 1}])
    # rewire t2 to consume t1's output, then t1 to consume t2's output -> cycle
    r = client.put(
        f"/api/foundry/transforms/{t2['id']}",
        json={
            "name": t2["name"],
            "inputs": [t1["output_dataset_id"]],
            "output_name": "cyc_upd_out2",
            "steps": [{"type": "limit", "n": 1}],
        },
    )
    assert r.status_code == 200, r.text
    r2 = client.put(
        f"/api/foundry/transforms/{t1['id']}",
        json={
            "name": t1["name"],
            "inputs": [t2["output_dataset_id"]],
            "output_name": "cyc_upd_out1",
            "steps": [{"type": "limit", "n": 1}],
        },
    )
    assert r2.status_code == 422, r2.text


def test_valid_dag_not_rejected(client: TestClient) -> None:
    ds = _upload_csv(client, "valid_dag_src", _CSV)
    t1 = _make_transform(client, ds["id"], "valid_dag_mid", [{"type": "limit", "n": 2}])
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": "valid_dag_final_tf",
            "inputs": [t1["output_dataset_id"]],
            "output_name": "valid_dag_final",
            "steps": [{"type": "limit", "n": 1}],
        },
    )
    assert r.status_code == 200, r.text


# ── data expectations (checks) ──────────────────────────────────────────────


def test_create_check_bad_type_422(client: TestClient) -> None:
    ds = _upload_csv(client, "chk_bad_type", _CSV)
    r = client.post(
        "/api/foundry/checks",
        json={"dataset_id": ds["id"], "name": "x", "type": "not_a_type", "params": {}},
    )
    assert r.status_code == 422


def test_create_check_bad_params_422(client: TestClient) -> None:
    ds = _upload_csv(client, "chk_bad_params", _CSV)
    r = client.post(
        "/api/foundry/checks",
        json={"dataset_id": ds["id"], "name": "x", "type": "not_null", "params": {}},
    )
    assert r.status_code == 422


def test_create_check_unknown_dataset_404(client: TestClient) -> None:
    r = client.post(
        "/api/foundry/checks",
        json={"dataset_id": "ds_nope", "name": "x", "type": "row_count_min", "params": {"min": 1}},
    )
    assert r.status_code == 404


def test_checks_crud(client: TestClient) -> None:
    ds = _upload_csv(client, "chk_crud", _CSV)
    r = client.post(
        "/api/foundry/checks",
        json={
            "dataset_id": ds["id"],
            "name": "min rows",
            "type": "row_count_min",
            "params": {"min": 1},
            "severity": "warn",
        },
    )
    assert r.status_code == 200, r.text
    check = r.json()
    assert check["enabled"] is True

    listing = client.get(f"/api/foundry/checks?dataset_id={ds['id']}").json()
    assert any(c["id"] == check["id"] for c in listing)

    r2 = client.put(
        f"/api/foundry/checks/{check['id']}",
        json={
            "dataset_id": ds["id"],
            "name": "min rows v2",
            "type": "row_count_min",
            "params": {"min": 2},
            "severity": "fail",
            "enabled": False,
        },
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["severity"] == "fail"
    assert r2.json()["enabled"] is False

    assert client.delete(f"/api/foundry/checks/{check['id']}").status_code == 200
    assert client.put(
        f"/api/foundry/checks/{check['id']}",
        json={
            "dataset_id": ds["id"],
            "name": "n",
            "type": "row_count_min",
            "params": {"min": 1},
        },
    ).status_code == 404


def test_fail_severity_check_blocks_upload_422(client: TestClient) -> None:
    ds = client.post("/api/foundry/datasets", json={"name": "chk_block"}).json()
    client.post(
        "/api/foundry/checks",
        json={
            "dataset_id": ds["id"],
            "name": "min 5",
            "type": "row_count_min",
            "params": {"min": 5},
            "severity": "fail",
        },
    )
    r = _upload_version(client, ds["id"], _CSV)  # only 3 rows < 5
    assert r.status_code == 422, r.text
    # version was NOT written
    dsafter = client.get(f"/api/foundry/datasets/{ds['id']}").json()
    assert dsafter["latest_version"] == 0


def test_warn_severity_check_allows_write_and_records_result(client: TestClient) -> None:
    ds = client.post("/api/foundry/datasets", json={"name": "chk_warn"}).json()
    client.post(
        "/api/foundry/checks",
        json={
            "dataset_id": ds["id"],
            "name": "min 5",
            "type": "row_count_min",
            "params": {"min": 5},
            "severity": "warn",
        },
    )
    r = _upload_version(client, ds["id"], _CSV)  # only 3 rows < 5, but warn
    assert r.status_code == 200, r.text
    ds2 = r.json()
    assert ds2["latest_version"] == 1

    results = client.get(f"/api/foundry/datasets/{ds['id']}/checks/results").json()
    assert len(results) == 1
    assert results[0]["passed"] is False


def test_not_null_and_unique_and_column_exists_checks(client: TestClient) -> None:
    ds = client.post("/api/foundry/datasets", json={"name": "chk_types"}).json()
    for ctype, params in (
        ("not_null", {"column": "id"}),
        ("unique", {"column": "id"}),
        ("column_exists", {"column": "id"}),
    ):
        client.post(
            "/api/foundry/checks",
            json={"dataset_id": ds["id"], "name": ctype, "type": ctype, "params": params, "severity": "warn"},
        )
    csv_dupe_null = "id,name\n1,a\n1,b\n,c\n"
    r = _upload_version(client, ds["id"], csv_dupe_null)
    assert r.status_code == 200, r.text
    results = client.get(f"/api/foundry/datasets/{ds['id']}/checks/results").json()
    by_type: dict[str, dict] = {}
    checks_list = client.get(f"/api/foundry/checks?dataset_id={ds['id']}").json()
    id_to_type = {c["id"]: c["type"] for c in checks_list}
    for res in results:
        by_type[id_to_type[res["check_id"]]] = res
    assert by_type["not_null"]["passed"] is False  # one null id
    assert by_type["unique"]["passed"] is False  # duplicate id=1
    assert by_type["column_exists"]["passed"] is True


def test_checks_enforced_on_rollback(client: TestClient) -> None:
    ds = _upload_csv(client, "chk_rollback", _CSV)  # v1: 3 rows
    _upload_version(client, ds["id"], "id,name,speed,country\n4,d,1,US\n5,e,2,US\n6,f,3,US\n7,g,4,US\n")  # v2: 4 rows
    client.post(
        "/api/foundry/checks",
        json={
            "dataset_id": ds["id"],
            "name": "min 4",
            "type": "row_count_min",
            "params": {"min": 4},
            "severity": "fail",
        },
    )
    # rolling back to v1 (3 rows) violates the fail check created after the fact
    r = client.post(f"/api/foundry/datasets/{ds['id']}/rollback", json={"version": 1})
    assert r.status_code == 422, r.text


def test_checks_enforced_on_transform_build_failed(client: TestClient) -> None:
    ds = _upload_csv(client, "chk_build_src", _CSV)
    t = _make_transform(client, ds["id"], "chk_build_out", [{"type": "limit", "n": 1}])
    # create output dataset first via a passing preview/build path is unnecessary;
    # the output dataset is auto-created by transform creation.
    out_ds_id = t["output_dataset_id"]
    client.post(
        "/api/foundry/checks",
        json={
            "dataset_id": out_ds_id,
            "name": "min 5",
            "type": "row_count_min",
            "params": {"min": 5},
            "severity": "fail",
        },
    )
    r = client.post(f"/api/foundry/transforms/{t['id']}/build")
    assert r.status_code == 200, r.text
    build = r.json()
    assert build["status"] == "failed"
    assert "check" in build["error"].lower() or "min" in build["error"].lower()


def test_checks_failing_in_summary(client: TestClient) -> None:
    before = client.get("/api/foundry/summary").json()["checks_failing"]
    ds = client.post("/api/foundry/datasets", json={"name": "chk_summary"}).json()
    client.post(
        "/api/foundry/checks",
        json={
            "dataset_id": ds["id"],
            "name": "min 5",
            "type": "row_count_min",
            "params": {"min": 5},
            "severity": "warn",
        },
    )
    _upload_version(client, ds["id"], _CSV)  # 3 rows < 5 -> warn-fails, recorded
    after = client.get("/api/foundry/summary").json()["checks_failing"]
    assert after == before + 1
