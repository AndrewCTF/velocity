"""Guard: Foundry monitors — rule watchers over dataset events (new_version,
row_condition, check_failed, build_failed) that publish a bus Alert and/or
call the LLM ladder, with every firing recorded in ``monitor_events``.

HTTP-level tests use the ``client`` fixture (mirrors ``test_foundry.py``);
the pruning test drives ``FoundryStore``/``builds`` directly (mirrors
``test_foundry_scheduler.py``'s style) since 200+ HTTP round trips would be
needlessly slow for a pure store-layer guarantee.
"""

from __future__ import annotations

import asyncio
import io

import pytest
from fastapi.testclient import TestClient

from app import llm
from app.correlate.bus import bus
from app.foundry.store import FoundryStore


def _upload_csv(client: TestClient, name: str, csv_text: str) -> dict:
    files = {"file": (f"{name}.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    r = client.post(
        "/api/foundry/datasets/upload", files=files, data={"name": name, "description": ""}
    )
    assert r.status_code == 200, r.text
    return r.json()


def _create_monitor(client: TestClient, **overrides: object) -> dict:
    body = {
        "dataset_id": overrides.pop("dataset_id"),
        "name": "test monitor",
        "trigger": "new_version",
        "condition_expr": "",
        "action": "alert",
        "llm_tier": "fast",
        "llm_system": "",
        "llm_prompt": "",
        "severity": "medium",
        "enabled": True,
    }
    body.update(overrides)
    r = client.post("/api/foundry/monitors", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── CRUD ─────────────────────────────────────────────────────────────────────


def test_monitor_crud(client: TestClient) -> None:
    ds = _upload_csv(client, "mon_crud", "id,speed\n1,10\n")
    created = _create_monitor(client, dataset_id=ds["id"])
    assert created["trigger"] == "new_version"
    assert created["enabled"] is True

    listed = client.get("/api/foundry/monitors", params={"dataset_id": ds["id"]}).json()
    assert [m["id"] for m in listed] == [created["id"]]

    updated = client.put(
        f"/api/foundry/monitors/{created['id']}",
        json={
            "dataset_id": ds["id"],
            "name": "renamed",
            "trigger": "new_version",
            "condition_expr": "",
            "action": "alert",
            "llm_tier": "fast",
            "llm_system": "",
            "llm_prompt": "",
            "severity": "high",
            "enabled": False,
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "renamed"
    assert updated.json()["enabled"] is False

    deleted = client.delete(f"/api/foundry/monitors/{created['id']}")
    assert deleted.status_code == 200
    assert client.get(f"/api/foundry/monitors/{created['id']}/events").status_code == 404


def test_monitor_update_unknown_404(client: TestClient) -> None:
    r = client.put(
        "/api/foundry/monitors/does_not_exist",
        json={
            "dataset_id": "x",
            "name": "n",
            "trigger": "new_version",
            "action": "alert",
        },
    )
    assert r.status_code == 404


def test_monitor_create_unknown_dataset_404(client: TestClient) -> None:
    r = client.post(
        "/api/foundry/monitors",
        json={"dataset_id": "nope", "name": "n", "trigger": "new_version", "action": "alert"},
    )
    assert r.status_code == 404


# ── validation ───────────────────────────────────────────────────────────────


def test_monitor_invalid_trigger_422(client: TestClient) -> None:
    ds = _upload_csv(client, "mon_bad_trigger", "id\n1\n")
    r = client.post(
        "/api/foundry/monitors",
        json={"dataset_id": ds["id"], "name": "n", "trigger": "not_a_trigger", "action": "alert"},
    )
    assert r.status_code == 422


def test_monitor_invalid_action_422(client: TestClient) -> None:
    ds = _upload_csv(client, "mon_bad_action", "id\n1\n")
    r = client.post(
        "/api/foundry/monitors",
        json={"dataset_id": ds["id"], "name": "n", "trigger": "new_version", "action": "explode"},
    )
    assert r.status_code == 422


def test_monitor_row_condition_missing_expr_422(client: TestClient) -> None:
    ds = _upload_csv(client, "mon_missing_expr", "id\n1\n")
    r = client.post(
        "/api/foundry/monitors",
        json={
            "dataset_id": ds["id"],
            "name": "n",
            "trigger": "row_condition",
            "condition_expr": "",
            "action": "alert",
        },
    )
    assert r.status_code == 422


def test_monitor_row_condition_unsafe_expr_422(client: TestClient) -> None:
    ds = _upload_csv(client, "mon_unsafe_expr", "id\n1\n")
    r = client.post(
        "/api/foundry/monitors",
        json={
            "dataset_id": ds["id"],
            "name": "n",
            "trigger": "row_condition",
            "condition_expr": "__import__('os')",
            "action": "alert",
        },
    )
    assert r.status_code == 422


# ── row_condition firing: event recorded + alert published to the bus ────────


def test_row_condition_fires_event_and_publishes_alert(client: TestClient) -> None:
    ds = _upload_csv(client, "mon_row_cond", "id,speed\n1,10\n")
    mon = _create_monitor(
        client,
        dataset_id=ds["id"],
        trigger="row_condition",
        condition_expr="speed > 25",
        action="alert",
        severity="high",
    )

    before = len(bus.recent(500))
    # New version whose rows include a match — fires the monitor.
    files = {"file": ("v2.csv", io.BytesIO(b"id,speed\n1,10\n2,30\n"), "text/csv")}
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files, data={})
    assert r.status_code == 200, r.text

    events = client.get(f"/api/foundry/monitors/{mon['id']}/events").json()
    assert len(events) == 1
    assert events[0]["kind"] == "fired"
    assert events[0]["detail"]["matched_rows"][0]["speed"] == 30

    after = bus.recent(500)
    assert len(after) == before + 1
    fired = after[-1]
    assert fired.rule_id == f"foundry:monitor:{mon['id']}"
    assert fired.severity == "high"


def test_row_condition_no_match_does_not_fire(client: TestClient) -> None:
    ds = _upload_csv(client, "mon_row_cond_nomatch", "id,speed\n1,10\n")
    mon = _create_monitor(
        client, dataset_id=ds["id"], trigger="row_condition", condition_expr="speed > 999"
    )
    files = {"file": ("v2.csv", io.BytesIO(b"id,speed\n1,10\n2,30\n"), "text/csv")}
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files, data={})
    assert r.status_code == 200, r.text
    events = client.get(f"/api/foundry/monitors/{mon['id']}/events").json()
    assert events == []


def test_new_version_trigger_fires_on_every_write(client: TestClient) -> None:
    ds = _upload_csv(client, "mon_new_version", "id\n1\n")
    mon = _create_monitor(client, dataset_id=ds["id"], trigger="new_version", action="alert")
    files = {"file": ("v2.csv", io.BytesIO(b"id\n1\n2\n"), "text/csv")}
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files, data={})
    assert r.status_code == 200, r.text
    events = client.get(f"/api/foundry/monitors/{mon['id']}/events").json()
    assert len(events) == 1


# ── llm action ───────────────────────────────────────────────────────────────


def test_llm_action_stores_summary_and_appends_to_alert(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_chat_json(messages, **kwargs):
        return {"summary": "three rows exceeded threshold"}, llm.LlmResult(
            text='{"summary": "three rows exceeded threshold"}'
        )

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)

    ds = _upload_csv(client, "mon_llm", "id,speed\n1,10\n")
    mon = _create_monitor(
        client,
        dataset_id=ds["id"],
        trigger="row_condition",
        condition_expr="speed > 25",
        action="both",
        llm_system="You watch speed anomalies.",
        llm_prompt="Dataset {dataset} trigger {trigger}: {rows}",
    )

    files = {"file": ("v2.csv", io.BytesIO(b"id,speed\n1,10\n2,30\n"), "text/csv")}
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files, data={})
    assert r.status_code == 200, r.text

    events = client.get(f"/api/foundry/monitors/{mon['id']}/events").json()
    assert len(events) == 1
    assert events[0]["kind"] == "fired"
    assert "three rows exceeded threshold" in events[0]["summary"]

    fired = bus.recent(50)[-1]
    assert fired.rule_id == f"foundry:monitor:{mon['id']}"
    assert "three rows exceeded threshold" in fired.message


def test_llm_action_failure_records_llm_error_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_chat_json(messages, **kwargs):
        return None, llm.LlmResult(text=None, error="upstream unavailable")

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)

    ds = _upload_csv(client, "mon_llm_fail", "id,speed\n1,10\n")
    mon = _create_monitor(
        client,
        dataset_id=ds["id"],
        trigger="row_condition",
        condition_expr="speed > 25",
        action="llm",
    )
    files = {"file": ("v2.csv", io.BytesIO(b"id,speed\n1,10\n2,30\n"), "text/csv")}
    r = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files, data={})
    assert r.status_code == 200, r.text

    events = client.get(f"/api/foundry/monitors/{mon['id']}/events").json()
    assert len(events) == 1
    assert events[0]["kind"] == "llm_error"


# ── build_failed trigger ─────────────────────────────────────────────────────


def test_build_failed_trigger_fires_monitor(client: TestClient) -> None:
    src = _upload_csv(client, "mon_build_src", "id\n1\n")
    out = client.post(
        "/api/foundry/datasets", json={"name": "mon_build_out", "description": ""}
    ).json()
    mon = _create_monitor(client, dataset_id=out["id"], trigger="build_failed", action="alert")

    tf = client.post(
        "/api/foundry/transforms",
        json={
            "name": "mon_build_tf",
            "inputs": [src["id"]],
            "output_name": "mon_build_out",
            # References a dataset id that doesn't exist -> the build fails
            # in _execute_transform, BEFORE add_version ever runs, so this
            # isolates build_failed from check_failed.
            "steps": [{"type": "join", "right": "ds_does_not_exist", "on": "id"}],
        },
    ).json()

    before = len(bus.recent(500))
    build = client.post(f"/api/foundry/transforms/{tf['id']}/build")
    assert build.status_code == 200, build.text
    assert build.json()["status"] == "failed"

    events = client.get(f"/api/foundry/monitors/{mon['id']}/events").json()
    assert len(events) == 1
    assert events[0]["kind"] == "fired"

    after = bus.recent(500)
    assert len(after) == before + 1
    assert after[-1].rule_id == f"foundry:monitor:{mon['id']}"


# ── events pruned to last 200 ────────────────────────────────────────────────


def test_monitor_events_pruned_to_200() -> None:
    async def run() -> None:
        store = FoundryStore()
        ds = await store.create_dataset("mon_prune", "")
        await store.add_version(ds["id"], [{"id": 1}], [{"name": "id", "type": "int"}], "upload")
        mon = await store.create_monitor(
            ds["id"], "prune monitor", "new_version", "", "alert", "fast", "", "", "medium", True
        )
        for i in range(210):
            await store.add_version(
                ds["id"], [{"id": i}], [{"name": "id", "type": "int"}], "upload"
            )
        events = await store.get_monitor_events(mon["id"], limit=500)
        assert len(events) == 200

    asyncio.run(run())


# ── check_failed trigger (bonus coverage) ─────────────────────────────────────


def test_check_failed_trigger_fires_monitor(client: TestClient) -> None:
    ds = _upload_csv(client, "mon_check_fail", "id\n1\n")
    mon = _create_monitor(client, dataset_id=ds["id"], trigger="check_failed", action="alert")
    r = client.post(
        "/api/foundry/checks",
        json={
            "dataset_id": ds["id"],
            "name": "always fails",
            "type": "row_count_min",
            "params": {"min": 999},
            "severity": "fail",
        },
    )
    assert r.status_code == 200, r.text

    before = len(bus.recent(500))
    files = {"file": ("v2.csv", io.BytesIO(b"id\n1\n"), "text/csv")}
    upload = client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files, data={})
    assert upload.status_code == 422, upload.text  # the write itself is still rejected

    events = client.get(f"/api/foundry/monitors/{mon['id']}/events").json()
    assert len(events) == 1
    after = bus.recent(500)
    assert len(after) == before + 1


# ── summary counters ─────────────────────────────────────────────────────────


def test_summary_includes_monitor_counters(client: TestClient) -> None:
    ds = _upload_csv(client, "mon_summary", "id,speed\n1,10\n")
    _create_monitor(client, dataset_id=ds["id"], trigger="new_version", action="alert")
    files = {"file": ("v2.csv", io.BytesIO(b"id,speed\n1,10\n2,20\n"), "text/csv")}
    client.post(f"/api/foundry/datasets/{ds['id']}/upload", files=files, data={})

    summary = client.get("/api/foundry/summary").json()
    assert summary["monitors"] >= 1
    assert summary["monitor_events_24h"] >= 1
