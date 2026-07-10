"""Wave-8 tests: routes added for the Foundry UI overhaul — the object-kinds
picker endpoint and unsaved-spec transform preview (editor live form state)."""

from __future__ import annotations

import io

from fastapi.testclient import TestClient

from app.intel.ontology import _KNOWN_KINDS

# ── kinds ─────────────────────────────────────────────────────────────────────


def test_kinds_lists_known_object_kinds(client: TestClient) -> None:
    r = client.get("/api/foundry/kinds")
    assert r.status_code == 200, r.text
    kinds = r.json()["kinds"]
    assert kinds == sorted(_KNOWN_KINDS)
    assert "vessel" in kinds


# ── unsaved-spec preview ──────────────────────────────────────────────────────


def _upload(client: TestClient, name: str, csv: bytes) -> dict:
    files = {"file": (f"{name}.csv", io.BytesIO(csv), "text/csv")}
    r = client.post("/api/foundry/datasets/upload", files=files, data={"name": name})
    assert r.status_code == 200, r.text
    return r.json()


def test_spec_preview_runs_unsaved_steps(client: TestClient) -> None:
    ds = _upload(client, "v8_spec", b"name,speed\na,10\nb,30\nc,50\n")
    r = client.post(
        "/api/foundry/transforms/preview",
        json={
            "inputs": [ds["id"]],
            "steps": [{"type": "filter", "expr": "speed > 20"}],
            "limit": 10,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert [row["name"] for row in body["rows"]] == ["b", "c"]
    assert body["quarantined"] == 0
    assert any(col["name"] == "speed" for col in body["schema"])


def test_spec_preview_matches_saved_preview(client: TestClient) -> None:
    ds = _upload(client, "v8_parity", b"name,speed\na,10\nb,30\n")
    steps = [{"type": "filter", "expr": "speed > 20"}]
    spec = client.post(
        "/api/foundry/transforms/preview",
        json={"inputs": [ds["id"]], "steps": steps},
    ).json()
    tf = client.post(
        "/api/foundry/transforms",
        json={
            "name": "v8_parity_tf",
            "inputs": [ds["id"]],
            "output_name": "v8_parity_out",
            "steps": steps,
        },
    ).json()
    saved = client.post(f"/api/foundry/transforms/{tf['id']}/preview", json={"limit": 20}).json()
    assert spec["rows"] == saved["rows"]
    assert spec["quarantined"] == saved["quarantined"]


def test_spec_preview_rejects_bad_step_and_no_inputs(client: TestClient) -> None:
    ds = _upload(client, "v8_bad", b"a\n1\n")
    r = client.post(
        "/api/foundry/transforms/preview",
        json={"inputs": [ds["id"]], "steps": [{"type": "not_a_step"}]},
    )
    assert r.status_code == 422
    r2 = client.post("/api/foundry/transforms/preview", json={"inputs": [], "steps": []})
    assert r2.status_code == 422  # transform has no inputs
