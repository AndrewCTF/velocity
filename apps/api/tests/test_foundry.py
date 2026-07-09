"""Guard: the Foundry substrate (docs/foundry-plan.md) works end-to-end,
keyless, on a per-test temp SQLite store (autouse ``_isolate_foundry_db``).

Covers the Guards/acceptance list: upload → schema inference, transform build
→ new version, lineage graph, binding sync mints objects visible through
``/api/ontology``, keyless end-to-end, dependent-delete 409.
"""

from __future__ import annotations

import io

from fastapi.testclient import TestClient

from app.intel.ontology import get_registry
from app.keys import UserCtx


def _upload_csv(client: TestClient, name: str, csv_text: str) -> dict:
    files = {"file": (f"{name}.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    data = {"name": name, "description": "test dataset"}
    r = client.post("/api/foundry/datasets/upload", files=files, data=data)
    assert r.status_code == 200, r.text
    return r.json()


_CSV = "id,name,speed,country\n1,alpha,12,DE\n2,beta,5,FR\n3,gamma,20,DE\n"


# ── datasets: upload + schema inference ──────────────────────────────────────


def test_upload_csv_infers_schema(client: TestClient) -> None:
    ds = _upload_csv(client, "ships", _CSV)
    assert ds["row_count"] == 3
    assert ds["latest_version"] == 1
    types = {c["name"]: c["type"] for c in ds["schema"]}
    assert types == {"id": "int", "name": "str", "speed": "int", "country": "str"}


def test_upload_json_array(client: TestClient) -> None:
    payload = [{"id": 1, "flag": True, "x": 1.5}, {"id": 2, "flag": False, "x": 2.5}]
    import json

    files = {"file": ("d.json", io.BytesIO(json.dumps(payload).encode()), "application/json")}
    r = client.post(
        "/api/foundry/datasets/upload", files=files, data={"name": "jsonds", "description": ""}
    )
    assert r.status_code == 200, r.text
    ds = r.json()
    types = {c["name"]: c["type"] for c in ds["schema"]}
    assert types["flag"] == "bool"
    assert types["x"] == "float"


def test_upload_ndjson(client: TestClient) -> None:
    body = '{"id": 1, "v": 10}\n{"id": 2, "v": 20}\n'
    files = {"file": ("d.ndjson", io.BytesIO(body.encode()), "application/x-ndjson")}
    r = client.post(
        "/api/foundry/datasets/upload", files=files, data={"name": "ndj", "description": ""}
    )
    assert r.status_code == 200, r.text
    assert r.json()["row_count"] == 2


def test_upload_too_large_413(client: TestClient, monkeypatch) -> None:
    from app.foundry import ingest

    monkeypatch.setattr(ingest, "MAX_UPLOAD_BYTES", 10)
    files = {"file": ("big.csv", io.BytesIO(_CSV.encode()), "text/csv")}
    r = client.post(
        "/api/foundry/datasets/upload", files=files, data={"name": "toobig413", "description": ""}
    )
    assert r.status_code == 413, r.text


def test_upload_row_cap_422(client: TestClient, monkeypatch) -> None:
    from app.foundry import ingest

    monkeypatch.setattr(ingest, "MAX_ROWS_PER_DATASET", 2)
    csv_text = "id\n1\n2\n3\n"
    files = {"file": ("big.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    r = client.post(
        "/api/foundry/datasets/upload", files=files, data={"name": "toobig", "description": ""}
    )
    assert r.status_code == 422, r.text


def test_upload_new_version(client: TestClient) -> None:
    ds = _upload_csv(client, "ships2", _CSV)
    v2 = b"id,name,speed,country\n4,delta,9,US\n"
    files = {"file": ("v2.csv", io.BytesIO(v2), "text/csv")}
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files)
    assert r.status_code == 200, r.text
    ds2 = r.json()
    assert ds2["latest_version"] == 2
    assert ds2["row_count"] == 1
    versions = client.get(f"/api/foundry/datasets/{ds['id']}/versions").json()
    assert len(versions) == 2


def test_dataset_rows_and_stats(client: TestClient) -> None:
    ds = _upload_csv(client, "ships3", _CSV)
    rows = client.get(f"/api/foundry/datasets/{ds['id']}/rows").json()
    assert rows["total"] == 3
    assert len(rows["rows"]) == 3
    stats = client.get(f"/api/foundry/datasets/{ds['id']}/stats").json()
    by_name = {s["name"]: s for s in stats}
    assert by_name["speed"]["min"] == 5
    assert by_name["speed"]["max"] == 20
    assert by_name["country"]["distinct"] == 2


def test_dataset_not_found_404(client: TestClient) -> None:
    assert client.get("/api/foundry/datasets/nope").status_code == 404
    assert client.get("/api/foundry/datasets/nope/rows").status_code == 404
    assert client.get("/api/foundry/datasets/nope/stats").status_code == 404


def test_create_dataset_and_delete(client: TestClient) -> None:
    r = client.post("/api/foundry/datasets", json={"name": "empty_ds"})
    assert r.status_code == 200, r.text
    ds = r.json()
    assert ds["row_count"] == 0
    assert ds["latest_version"] == 0
    r2 = client.delete(f"/api/foundry/datasets/{ds['id']}")
    assert r2.status_code == 200
    assert r2.json() == {"ok": True}
    assert client.get(f"/api/foundry/datasets/{ds['id']}").status_code == 404


def test_create_dataset_duplicate_name_409(client: TestClient) -> None:
    client.post("/api/foundry/datasets", json={"name": "dup_ds"})
    r = client.post("/api/foundry/datasets", json={"name": "dup_ds"})
    assert r.status_code == 409


# ── transforms + builds ──────────────────────────────────────────────────────


def _make_transform(
    client: TestClient, input_ds_id: str, output_name: str, steps: list[dict]
) -> dict:
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


def test_transform_preview_does_not_write_version(client: TestClient) -> None:
    ds = _upload_csv(client, "src1", _CSV)
    t = _make_transform(
        client, ds["id"], "src1_out", [{"type": "filter", "expr": "speed > 10"}]
    )
    r = client.post(f"/api/foundry/transforms/{t['id']}/preview", json={"limit": 20})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["rows"]) == 2
    out_ds = client.get(f"/api/foundry/datasets/{t['output_dataset_id']}").json()
    assert out_ds["latest_version"] == 0  # preview never writes


def test_transform_build_and_lineage(client: TestClient) -> None:
    ds = _upload_csv(client, "src2", _CSV)
    t = _make_transform(
        client,
        ds["id"],
        "src2_out",
        [
            {"type": "filter", "expr": "country == 'DE'"},
            {"type": "derive", "column": "kmh", "expr": "speed * 1.852"},
        ],
    )
    r = client.post(f"/api/foundry/transforms/{t['id']}/build")
    assert r.status_code == 200, r.text
    build = r.json()
    assert build["status"] == "succeeded"
    assert build["rows_out"] == 2

    out_ds = client.get(f"/api/foundry/datasets/{t['output_dataset_id']}").json()
    assert out_ds["latest_version"] == 1
    assert out_ds["row_count"] == 2

    lineage = client.get("/api/foundry/lineage").json()
    node_ids = {n["id"] for n in lineage["nodes"]}
    assert ds["id"] in node_ids
    assert t["output_dataset_id"] in node_ids
    assert t["id"] in node_ids
    edges = lineage["edges"]
    assert {"src": ds["id"], "dst": t["id"]} in edges
    assert {"src": t["id"], "dst": t["output_dataset_id"]} in edges


def test_pipeline_build_runs_all_transforms(client: TestClient) -> None:
    ds = _upload_csv(client, "src3", _CSV)
    _make_transform(client, ds["id"], "src3_out", [{"type": "limit", "n": 1}])
    r = client.post("/api/foundry/pipeline/build")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == "pipeline"
    assert body["status"] == "succeeded"


def test_transform_unknown_step_rejected_at_save(client: TestClient) -> None:
    ds = _upload_csv(client, "src4", _CSV)
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": "src4_out_tf",
            "description": "",
            "inputs": [ds["id"]],
            "output_name": "src4_out",
            "steps": [{"type": "bogus"}],
        },
    )
    assert r.status_code == 422
    assert "bogus" in r.json()["detail"]


def test_transform_runtime_failure_fails_build(client: TestClient) -> None:
    # Valid shape at save time, fails at build time (join right dataset missing).
    ds = _upload_csv(client, "src4b", _CSV)
    t = _make_transform(
        client,
        ds["id"],
        "src4b_out",
        [{"type": "join", "right": "no-such-dataset", "on": "name"}],
    )
    r = client.post(f"/api/foundry/transforms/{t['id']}/build")
    assert r.status_code == 200
    build = r.json()
    assert build["status"] == "failed"
    assert build["error"]


def test_builds_list_and_get(client: TestClient) -> None:
    ds = _upload_csv(client, "src5", _CSV)
    t = _make_transform(client, ds["id"], "src5_out", [{"type": "limit", "n": 1}])
    r = client.post(f"/api/foundry/transforms/{t['id']}/build")
    build = r.json()
    listing = client.get("/api/foundry/builds").json()
    assert any(b["id"] == build["id"] for b in listing)
    one = client.get(f"/api/foundry/builds/{build['id']}").json()
    assert one["id"] == build["id"]
    assert client.get("/api/foundry/builds/nope").status_code == 404


def test_delete_dataset_with_dependent_transform_409(client: TestClient) -> None:
    ds = _upload_csv(client, "src6", _CSV)
    _make_transform(client, ds["id"], "src6_out", [{"type": "limit", "n": 1}])
    r = client.delete(f"/api/foundry/datasets/{ds['id']}")
    assert r.status_code == 409


def test_delete_transform_then_dataset_ok(client: TestClient) -> None:
    ds = _upload_csv(client, "src7", _CSV)
    t = _make_transform(client, ds["id"], "src7_out", [{"type": "limit", "n": 1}])
    assert client.delete(f"/api/foundry/transforms/{t['id']}").status_code == 200
    assert client.delete(f"/api/foundry/datasets/{ds['id']}").status_code == 200


# ── bindings: ontology sync ──────────────────────────────────────────────────


def test_binding_sync_mints_objects_visible_through_ontology(client: TestClient) -> None:
    ds = _upload_csv(client, "vessels_byo", _CSV)
    r = client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": ds["id"],
            "object_kind": "vessel",
            "key_column": "id",
            "prop_map": {"name": "callsign", "speed": "sog"},
        },
    )
    assert r.status_code == 200, r.text
    binding = r.json()

    r2 = client.post(f"/api/foundry/bindings/{binding['id']}/sync")
    assert r2.status_code == 200, r2.text
    result = r2.json()
    assert result["minted"] == 3
    assert result["updated"] == 0
    assert result["errors"] == []

    object_id = f"foundry:{ds['id']}:1"
    r3 = client.get(f"/api/ontology/object/{object_id}")
    assert r3.status_code == 200, r3.text
    obj = r3.json()
    assert obj["kind"] == "vessel"
    assert obj["props"]["callsign"] == "alpha"
    assert obj["props"]["sog"] == 12

    # re-sync updates, does not re-mint
    r4 = client.post(f"/api/foundry/bindings/{binding['id']}/sync")
    result2 = r4.json()
    assert result2["minted"] == 0
    assert result2["updated"] == 3


def test_binding_rejects_unknown_object_kind_422(client: TestClient) -> None:
    ds = _upload_csv(client, "vessels_bad", _CSV)
    r = client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": ds["id"],
            "object_kind": "not_a_real_kind",
            "key_column": "id",
            "prop_map": {},
        },
    )
    assert r.status_code == 422


def test_binding_direct_registry_roundtrip() -> None:
    """Unit-level check (no HTTP) that upsert-based binding sync sets the
    caller's intended kind, not the id-prefix-derived 'object' fallback that
    assert_props would have produced for an unrecognised 'foundry:' prefix."""
    import asyncio

    from app.foundry import binding as binding_mod
    from app.foundry.store import FoundryStore

    async def run() -> None:
        store = FoundryStore()
        ds = await store.create_dataset("direct_ds", "")
        await store.add_version(
            ds["id"],
            [{"id": "7", "callsign": "ALPHA1"}],
            [{"name": "id", "type": "str"}, {"name": "callsign", "type": "str"}],
            source="upload",
        )
        b = await store.create_binding(ds["id"], "aircraft", "id", {"callsign": "callsign"})
        ctx = UserCtx("local", "")
        result = await binding_mod.sync_binding(store, b, ctx)
        assert result["minted"] == 1

        reg = get_registry(ctx)
        obj = await reg.get(f"foundry:{ds['id']}:7")
        assert obj is not None
        assert obj.kind == "aircraft"
        assert obj.props["callsign"] == "ALPHA1"

    asyncio.run(run())


def test_bindings_crud(client: TestClient) -> None:
    ds = client.post("/api/foundry/datasets", json={"name": "bind_crud_ds"}).json()
    r = client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": ds["id"],
            "object_kind": "org",
            "key_column": "id",
            "prop_map": {},
        },
    )
    binding = r.json()
    assert client.get("/api/foundry/bindings").json()
    r2 = client.put(
        f"/api/foundry/bindings/{binding['id']}",
        json={
            "dataset_id": ds["id"],
            "object_kind": "org",
            "key_column": "id",
            "prop_map": {"name": "label"},
            "enabled": False,
        },
    )
    assert r2.status_code == 200
    assert r2.json()["enabled"] is False
    assert client.delete(f"/api/foundry/bindings/{binding['id']}").status_code == 200
    assert client.put(
        f"/api/foundry/bindings/{binding['id']}",
        json={"dataset_id": ds["id"], "object_kind": "org", "key_column": "id", "prop_map": {}},
    ).status_code == 404


# ── schedules ────────────────────────────────────────────────────────────────


def test_schedules_crud(client: TestClient) -> None:
    ds = _upload_csv(client, "sched_ds", _CSV)
    t = _make_transform(client, ds["id"], "sched_out", [{"type": "limit", "n": 1}])
    r = client.post(
        "/api/foundry/schedules", json={"transform_id": t["id"], "interval_s": 3600}
    )
    assert r.status_code == 200, r.text
    sched = r.json()
    assert sched["enabled"] is True

    listing = client.get("/api/foundry/schedules").json()
    assert any(s["id"] == sched["id"] for s in listing)

    r2 = client.put(
        f"/api/foundry/schedules/{sched['id']}",
        json={"transform_id": t["id"], "interval_s": 60, "enabled": False},
    )
    assert r2.status_code == 200
    assert r2.json()["interval_s"] == 60
    assert r2.json()["enabled"] is False

    assert client.delete(f"/api/foundry/schedules/{sched['id']}").status_code == 200


def test_schedule_unknown_transform_404(client: TestClient) -> None:
    r = client.post(
        "/api/foundry/schedules", json={"transform_id": "tf_nope", "interval_s": 60}
    )
    assert r.status_code == 404


# ── summary + keyless end-to-end ─────────────────────────────────────────────


def test_summary_keyless(client: TestClient) -> None:
    r = client.get("/api/foundry/summary")
    assert r.status_code == 200, r.text
    body = r.json()
    for key in (
        "datasets",
        "total_rows",
        "transforms",
        "builds_24h",
        "failed_builds_24h",
        "objects_synced",
        "recent_builds",
    ):
        assert key in body


def test_full_flow_keyless_no_auth(client: TestClient) -> None:
    """The whole pillar chain works with no API key / Supabase configured —
    the suite's default posture (conftest sets no credential)."""
    ds = _upload_csv(client, "e2e_ds", _CSV)
    t = _make_transform(
        client, ds["id"], "e2e_out", [{"type": "filter", "expr": "speed >= 10"}]
    )
    build = client.post(f"/api/foundry/transforms/{t['id']}/build").json()
    assert build["status"] == "succeeded"
    binding = client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": t["output_dataset_id"],
            "object_kind": "object",
            "key_column": "id",
            "prop_map": {"name": "label"},
        },
    ).json()
    sync = client.post(f"/api/foundry/bindings/{binding['id']}/sync").json()
    assert sync["minted"] == build["rows_out"]
    summary = client.get("/api/foundry/summary").json()
    assert summary["datasets"] >= 2
    assert summary["transforms"] >= 1
