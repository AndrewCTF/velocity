"""Wave-4 route wiring tests: save-time step validation, auto-sync on
upload/append/rollback, the ``resolve`` flag persisted on bindings, and
schedule ``last_error`` exposure.

Same per-test temp SQLite idiom as ``test_foundry.py`` (autouse
``_isolate_foundry_db`` in conftest).
"""

from __future__ import annotations

import asyncio
import io

from fastapi.testclient import TestClient

from app.intel.ontology import Object, get_registry
from app.keys import UserCtx


def _upload_csv(client: TestClient, name: str, csv_text: str) -> dict:
    files = {"file": (f"{name}.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    data = {"name": name, "description": "test dataset"}
    r = client.post("/api/foundry/datasets/upload", files=files, data=data)
    assert r.status_code == 200, r.text
    return r.json()


_CSV = "id,name,speed,country\n1,alpha,12,DE\n2,beta,5,FR\n3,gamma,20,DE\n"


# ── save-time step validation ───────────────────────────────────────────────


def test_create_transform_malformed_step_422(client: TestClient) -> None:
    ds = _upload_csv(client, "v4_src_a", _CSV)
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": "v4_bad_tf",
            "inputs": [ds["id"]],
            "output_name": "v4_bad_out",
            # derive requires 'expr' — missing here
            "steps": [{"type": "derive", "column": "x"}],
        },
    )
    assert r.status_code == 422, r.text
    assert "step 0" in r.json()["detail"]
    assert "expr" in r.json()["detail"]


def test_update_transform_malformed_step_422(client: TestClient) -> None:
    ds = _upload_csv(client, "v4_src_b", _CSV)
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": "v4_good_tf",
            "inputs": [ds["id"]],
            "output_name": "v4_good_out",
            "steps": [{"type": "select", "columns": ["id"]}],
        },
    )
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    r2 = client.put(
        f"/api/foundry/transforms/{tid}",
        json={
            "name": "v4_good_tf",
            "inputs": [ds["id"]],
            "output_name": "v4_good_out",
            "steps": [{"type": "filter"}],  # missing expr
        },
    )
    assert r2.status_code == 422, r2.text
    assert "step 0" in r2.json()["detail"]


def test_preview_bad_step_422(client: TestClient) -> None:
    """Insert a transform with malformed steps directly via the store
    (bypassing route-level validation, the way a pre-existing/legacy row
    could) and confirm the preview route now catches it too."""
    from app.foundry.store import FoundryStore

    async def run() -> dict:
        store = FoundryStore()
        ds = await store.create_dataset("v4_preview_src", "")
        await store.add_version(
            ds["id"],
            [{"id": 1}],
            [{"name": "id", "type": "int"}],
            source="upload",
        )
        out_ds = await store.create_dataset("v4_preview_out", kind="derived")
        t = await store.create_transform(
            "v4_preview_tf",
            "",
            [ds["id"]],
            out_ds["id"],
            [{"type": "aggregate", "group_by": ["id"]}],  # missing 'aggs'
        )
        return t

    t = asyncio.run(run())
    r = client.post(f"/api/foundry/transforms/{t['id']}/preview", json={"limit": 10})
    assert r.status_code == 422, r.text
    assert "step 0" in r.json()["detail"]


# ── auto-sync on upload/append/rollback ─────────────────────────────────────


def _bind(client: TestClient, dataset_id: str, *, resolve: bool = False) -> dict:
    r = client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": dataset_id,
            "object_kind": "vessel",
            "key_column": "id",
            "prop_map": {"name": "callsign", "speed": "sog"},
            "enabled": True,
            "resolve": resolve,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_upload_new_version_auto_syncs_enabled_binding(client: TestClient) -> None:
    ds = _upload_csv(client, "v4_autosync_ds", _CSV)
    binding = _bind(client, ds["id"])

    v2 = b"id,name,speed,country\n4,delta,9,US\n"
    files = {"file": ("v2.csv", io.BytesIO(v2), "text/csv")}
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "auto_sync" in body
    assert len(body["auto_sync"]) == 1
    summary = body["auto_sync"][0]
    assert summary["binding_id"] == binding["id"]
    assert summary["status"] == "ok"
    assert summary["result"]["minted"] == 1

    object_id = f"foundry:{ds['id']}:4"
    obj = client.get(f"/api/ontology/object/{object_id}")
    assert obj.status_code == 200, obj.text
    assert obj.json()["props"]["callsign"] == "delta"


def test_upload_no_bindings_auto_sync_empty(client: TestClient) -> None:
    ds = _upload_csv(client, "v4_nobind_ds", _CSV)
    v2 = b"id,name,speed,country\n4,delta,9,US\n"
    files = {"file": ("v2.csv", io.BytesIO(v2), "text/csv")}
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files)
    assert r.status_code == 200, r.text
    assert r.json()["auto_sync"] == []


def test_append_upload_auto_syncs(client: TestClient) -> None:
    ds = _upload_csv(client, "v4_append_ds", _CSV)
    binding = _bind(client, ds["id"])
    v2 = b"id,name,speed,country\n4,delta,9,US\n"
    files = {"file": ("v2.csv", io.BytesIO(v2), "text/csv")}
    r = client.post(
        f"/api/foundry/datasets/{ds['id']}/upload", files=files, data={"mode": "append"}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["row_count"] == 4
    assert len(body["auto_sync"]) == 1
    assert body["auto_sync"][0]["binding_id"] == binding["id"]
    assert body["auto_sync"][0]["result"]["minted"] == 4


def test_rollback_triggers_auto_sync(client: TestClient) -> None:
    ds = _upload_csv(client, "v4_rollback_ds", _CSV)
    binding = _bind(client, ds["id"])
    v2 = b"id,name,speed,country\n4,delta,9,US\n"
    files = {"file": ("v2.csv", io.BytesIO(v2), "text/csv")}
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files)
    assert r.status_code == 200, r.text

    r2 = client.post(f"/api/foundry/datasets/{ds['id']}/rollback", json={"version": 1})
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert "auto_sync" in body
    assert len(body["auto_sync"]) == 1
    assert body["auto_sync"][0]["binding_id"] == binding["id"]
    # rollback restored the 3-row v1 -> minted (or updated) 3 objects
    result = body["auto_sync"][0]["result"]
    assert result["minted"] + result["updated"] == 3


# ── resolve flag persistence ────────────────────────────────────────────────


def test_binding_resolve_flag_round_trips(client: TestClient) -> None:
    ds = client.post("/api/foundry/datasets", json={"name": "v4_resolve_ds"}).json()
    r = client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": ds["id"],
            "object_kind": "org",
            "key_column": "id",
            "prop_map": {},
            "resolve": True,
        },
    )
    assert r.status_code == 200, r.text
    binding = r.json()
    assert binding["resolve"] is True

    got = client.get("/api/foundry/bindings").json()
    match = next(b for b in got if b["id"] == binding["id"])
    assert match["resolve"] is True

    # update can flip it back off
    r2 = client.put(
        f"/api/foundry/bindings/{binding['id']}",
        json={
            "dataset_id": ds["id"],
            "object_kind": "org",
            "key_column": "id",
            "prop_map": {},
            "resolve": False,
        },
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["resolve"] is False


def test_binding_default_resolve_false(client: TestClient) -> None:
    ds = client.post("/api/foundry/datasets", json={"name": "v4_resolve_default_ds"}).json()
    r = client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": ds["id"],
            "object_kind": "org",
            "key_column": "id",
            "prop_map": {},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["resolve"] is False


def test_resolve_true_updates_preexisting_object_not_mint(client: TestClient) -> None:
    """A binding with resolve=true must upsert onto a pre-existing hand-minted
    object that already carries the row's key value, rather than minting a
    fresh ``foundry:{dataset_id}:{key}`` id."""
    csv_text = "mmsi,name,speed,country\nM001,alpha,12,DE\n"
    ds = _upload_csv(client, "v4_resolve_flow_ds", csv_text)

    ctx = UserCtx("local", "")
    reg = get_registry(ctx)

    async def mint_existing() -> None:
        await reg.upsert(
            Object(id="vessel:handmade1", kind="vessel", props={"mmsi": "M001", "note": "pre-existing"}),
            source="analyst",
        )

    asyncio.run(mint_existing())

    r = client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": ds["id"],
            "object_kind": "vessel",
            "key_column": "mmsi",
            "prop_map": {"mmsi": "mmsi", "name": "callsign"},
            "resolve": True,
        },
    )
    assert r.status_code == 200, r.text
    binding = r.json()

    sync = client.post(f"/api/foundry/bindings/{binding['id']}/sync")
    assert sync.status_code == 200, sync.text
    result = sync.json()
    assert result["minted"] == 0
    assert result["updated"] == 1
    assert result["errors"] == []

    minted_id = f"foundry:{ds['id']}:M001"
    assert client.get(f"/api/ontology/object/{minted_id}").status_code == 404

    obj = client.get("/api/ontology/object/vessel:handmade1")
    assert obj.status_code == 200, obj.text
    body = obj.json()
    # sync target is still the pre-existing hand-minted object (props are a
    # full replacement per the binding's own contract, so the pre-existing
    # "note" prop is gone — that's expected, not a bug being tested here).
    assert body["kind"] == "vessel"
    assert body["props"]["callsign"] == "alpha"
    assert body["props"]["mmsi"] == "M001"


# ── schedule last_error exposure ────────────────────────────────────────────


def test_schedules_expose_last_error(client: TestClient) -> None:
    ds = _upload_csv(client, "v4_sched_ds", _CSV)
    r = client.post(
        "/api/foundry/transforms",
        json={
            "name": "v4_sched_tf",
            "inputs": [ds["id"]],
            "output_name": "v4_sched_out",
            "steps": [{"type": "select", "columns": ["id"]}],
        },
    )
    assert r.status_code == 200, r.text
    tid = r.json()["id"]

    r2 = client.post(
        "/api/foundry/schedules", json={"transform_id": tid, "interval_s": 60, "enabled": True}
    )
    assert r2.status_code == 200, r2.text
    sched = r2.json()
    assert "last_error" in sched
    assert sched["last_error"] is None

    listed = client.get("/api/foundry/schedules").json()
    match = next(s for s in listed if s["id"] == sched["id"])
    assert "last_error" in match
    assert match["last_error"] is None
