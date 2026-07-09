"""Guard: Foundry v3 — Kinetic-style auto-sync on build, entity resolution in
binding sync, and loud cycle failure in ``_topo_order``.

Mirrors ``test_foundry.py``/``test_foundry_v2.py``'s fixtures (per-test temp
SQLite stores via the autouse ``_isolate_foundry_db``/``_isolate_ontology_db``
conftest hooks) and ``test_foundry.py``'s direct (no-HTTP) async idiom for the
tests that need to reach past the route layer (bypassing route guards,
pre-seeding ontology objects).
"""

from __future__ import annotations

import asyncio
import io

import pytest
from fastapi.testclient import TestClient

from app.foundry import binding as binding_mod
from app.foundry import builds as builds_mod
from app.foundry.store import FoundryError, FoundryStore
from app.intel.ontology import Object, get_registry
from app.keys import UserCtx

_CSV = "id,name,speed,country\n1,alpha,12,DE\n2,beta,5,FR\n3,gamma,20,DE\n"


def _upload_csv(client: TestClient, name: str, csv_text: str) -> dict:
    files = {"file": (f"{name}.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    data = {"name": name, "description": "test dataset"}
    r = client.post("/api/foundry/datasets/upload", files=files, data=data)
    assert r.status_code == 200, r.text
    return r.json()


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


def _make_binding(
    client: TestClient, dataset_id: str, object_kind: str, prop_map: dict, enabled: bool = True
) -> dict:
    r = client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": dataset_id,
            "object_kind": object_kind,
            "key_column": "id",
            "prop_map": prop_map,
            "enabled": enabled,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


# ── auto-sync on build ─────────────────────────────────────────────────────


def test_build_auto_syncs_enabled_binding(client: TestClient) -> None:
    ds = _upload_csv(client, "auto_src", _CSV)
    t = _make_transform(client, ds["id"], "auto_out", [{"type": "limit", "n": 3}])
    binding = _make_binding(client, t["output_dataset_id"], "vessel", {"name": "callsign"})

    build = client.post(f"/api/foundry/transforms/{t['id']}/build").json()
    assert build["status"] == "succeeded"
    assert any(
        line.startswith(f"auto-sync binding {binding['id']}: minted=3") for line in build["log"]
    ), build["log"]

    object_id = f"foundry:{t['output_dataset_id']}:1"
    r = client.get(f"/api/ontology/object/{object_id}")
    assert r.status_code == 200, r.text
    assert r.json()["props"]["callsign"] == "alpha"


def test_build_does_not_auto_sync_disabled_binding(client: TestClient) -> None:
    ds = _upload_csv(client, "disabled_src", _CSV)
    t = _make_transform(client, ds["id"], "disabled_out", [{"type": "limit", "n": 3}])
    _make_binding(client, t["output_dataset_id"], "vessel", {"name": "callsign"}, enabled=False)

    build = client.post(f"/api/foundry/transforms/{t['id']}/build").json()
    assert build["status"] == "succeeded"
    assert not any("auto-sync binding" in line for line in build["log"])

    object_id = f"foundry:{t['output_dataset_id']}:1"
    r = client.get(f"/api/ontology/object/{object_id}")
    assert r.status_code == 404


def test_binding_sync_failure_does_not_fail_build(client: TestClient, monkeypatch) -> None:
    ds = _upload_csv(client, "fail_src", _CSV)
    t = _make_transform(client, ds["id"], "fail_out", [{"type": "limit", "n": 3}])
    binding = _make_binding(client, t["output_dataset_id"], "vessel", {"name": "callsign"})

    async def _boom(store, b, ctx, *, resolve=False):
        raise RuntimeError("sync exploded")

    monkeypatch.setattr(binding_mod, "sync_binding", _boom)

    build = client.post(f"/api/foundry/transforms/{t['id']}/build").json()
    assert build["status"] == "succeeded"
    assert any(
        line == f"auto-sync binding {binding['id']} FAILED: sync exploded" for line in build["log"]
    ), build["log"]


# ── entity resolution ────────────────────────────────────────────────────────


def test_resolve_true_updates_existing_object_by_key_prop() -> None:
    async def run() -> None:
        store = FoundryStore()
        ds = await store.create_dataset("resolve_ds", "")
        await store.add_version(
            ds["id"],
            [{"id": "7", "mmsi": "999", "name": "ALPHA"}],
            [
                {"name": "id", "type": "str"},
                {"name": "mmsi", "type": "str"},
                {"name": "name", "type": "str"},
            ],
            source="upload",
        )
        b = await store.create_binding(
            ds["id"], "vessel", "mmsi", {"mmsi": "mmsi", "name": "callsign"}
        )
        ctx = UserCtx("local", "")

        reg = get_registry(ctx)
        pre_existing_id = "vessel:hand-entered-1"
        await reg.upsert(
            Object(id=pre_existing_id, kind="vessel", props={"mmsi": "999", "callsign": "OLD"}),
            source="analyst",
        )

        result = await binding_mod.sync_binding(store, b, ctx, resolve=True)
        assert result["minted"] == 0
        assert result["updated"] == 1
        assert result["errors"] == []

        updated = await reg.get(pre_existing_id)
        assert updated is not None
        assert updated.props["callsign"] == "ALPHA"

        minted_as_new = await reg.get(f"foundry:{ds['id']}:999")
        assert minted_as_new is None

    asyncio.run(run())


def test_resolve_true_mints_when_zero_matches() -> None:
    async def run() -> None:
        store = FoundryStore()
        ds = await store.create_dataset("resolve_zero_ds", "")
        await store.add_version(
            ds["id"],
            [{"id": "7", "mmsi": "111", "name": "BETA"}],
            [
                {"name": "id", "type": "str"},
                {"name": "mmsi", "type": "str"},
                {"name": "name", "type": "str"},
            ],
            source="upload",
        )
        b = await store.create_binding(
            ds["id"], "vessel", "mmsi", {"mmsi": "mmsi", "name": "callsign"}
        )
        ctx = UserCtx("local", "")

        result = await binding_mod.sync_binding(store, b, ctx, resolve=True)
        assert result["minted"] == 1
        assert result["updated"] == 0
        assert result["errors"] == []

        reg = get_registry(ctx)
        minted = await reg.get(f"foundry:{ds['id']}:111")
        assert minted is not None
        assert minted.props["callsign"] == "BETA"

    asyncio.run(run())


def test_resolve_true_ambiguous_match_skips_with_error() -> None:
    async def run() -> None:
        store = FoundryStore()
        ds = await store.create_dataset("resolve_ambig_ds", "")
        await store.add_version(
            ds["id"],
            [{"id": "7", "mmsi": "222", "name": "GAMMA"}],
            [
                {"name": "id", "type": "str"},
                {"name": "mmsi", "type": "str"},
                {"name": "name", "type": "str"},
            ],
            source="upload",
        )
        b = await store.create_binding(
            ds["id"], "vessel", "mmsi", {"mmsi": "mmsi", "name": "callsign"}
        )
        ctx = UserCtx("local", "")

        reg = get_registry(ctx)
        await reg.upsert(
            Object(id="vessel:dup-1", kind="vessel", props={"mmsi": "222"}), source="analyst"
        )
        await reg.upsert(
            Object(id="vessel:dup-2", kind="vessel", props={"mmsi": "222"}), source="analyst"
        )

        result = await binding_mod.sync_binding(store, b, ctx, resolve=True)
        assert result["minted"] == 0
        assert result["updated"] == 0
        assert len(result["errors"]) == 1
        assert "ambiguous match for key=222 (2 candidates)" in result["errors"][0]

        assert await reg.get(f"foundry:{ds['id']}:222") is None

    asyncio.run(run())


# ── _topo_order cycle: fail loud, never build in wrong order ───────────────


def test_topo_order_cycle_raises_foundry_error() -> None:
    async def run() -> None:
        store = FoundryStore()
        ds_a = await store.create_dataset("cyc_a", "")
        ds_b = await store.create_dataset("cyc_b", "")
        # written directly through the store — bypasses the route-level
        # would_cycle guard entirely.
        await store.create_transform("cyc_t1", "", [ds_a["id"]], ds_b["id"], [])
        await store.create_transform("cyc_t2", "", [ds_b["id"]], ds_a["id"], [])

        transforms = await store.list_transforms()
        with pytest.raises(FoundryError, match="cycle"):
            builds_mod._topo_order(transforms)

        with pytest.raises(FoundryError, match="cycle"):
            await builds_mod.run_pipeline_build(store)

    asyncio.run(run())
