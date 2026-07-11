"""Route-wiring smoke tests for /api/ai/hardware, /api/ai/models*, /api/ai/engine.

Keyless (ALLOW_UNAUTHENTICATED=1, set by conftest) via the shared ``client``
fixture. Deep logic (presets, download jobs, delete containment) is unit
tested directly against app.localllm.* in the sibling test files — this file
only proves the routes are wired, validate their bodies, and translate
manager-layer HTTPExceptions into the right status codes.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.localllm import manager, state


@pytest.fixture(autouse=True)
def _isolate_models_dir(tmp_path: Path):
    manager.override_models_dir(str(tmp_path / "models"))
    manager._JOBS.clear()
    yield
    manager.override_models_dir(None)
    manager._JOBS.clear()


@pytest.fixture(autouse=True)
def _isolate_engine_override():
    state.set_engine(None)
    yield
    state.set_engine(None)


def test_get_hardware_shape(client: TestClient) -> None:
    r = client.get("/api/ai/hardware")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"gpu", "ram_mb", "disk_free_mb", "recommendation", "presets"}
    assert set(body["presets"]) == {"speed", "medium", "quality"}


def test_get_models_shape(client: TestClient) -> None:
    r = client.get("/api/ai/models")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"engines", "active", "hot", "installed", "catalog"}
    assert set(body["engines"]) == {"llamacpp", "vllm", "ollama"}
    assert len(body["catalog"]) == 7
    assert body["installed"] == []
    assert body["hot"] == []
    assert body["active"] == {"main": None, "selection": None}


@pytest.mark.parametrize(
    "repo_id",
    [
        "evilorg/Qwen3.5-9B-GGUF",
        "https://evil.example.com/x",
        "unsloth/../../etc/passwd",
        "",
    ],
)
def test_post_download_rejects_bad_repo_id(client: TestClient, repo_id: str) -> None:
    r = client.post("/api/ai/models/download", json={"repo_id": repo_id, "quant": "UD-Q4_K_XL"})
    assert r.status_code == 422


def test_post_download_success_creates_job(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    payload = b"fake-gguf-weights"
    sha = hashlib.sha256(payload).hexdigest()

    class FakeHfApi:
        def model_info(self, repo_id, files_metadata=False):  # noqa: ARG002
            return SimpleNamespace(
                siblings=[
                    SimpleNamespace(
                        rfilename="model-UD-Q4_K_XL.gguf",
                        size=len(payload),
                        lfs=SimpleNamespace(sha256=sha),
                    )
                ]
            )

    def fake_snapshot_download(**kw):
        target = Path(kw["local_dir"])
        target.mkdir(parents=True, exist_ok=True)
        (target / "model-UD-Q4_K_XL.gguf").write_bytes(payload)

    monkeypatch.setattr(manager, "HfApi", FakeHfApi)
    monkeypatch.setattr(manager, "snapshot_download", fake_snapshot_download)

    r = client.post(
        "/api/ai/models/download",
        json={"repo_id": "unsloth/Qwen3.5-9B-GGUF", "quant": "UD-Q4_K_XL"},
    )
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    r2 = client.get(f"/api/ai/models/download/{job_id}")
    assert r2.status_code == 200
    assert r2.json()["status"] in ("queued", "downloading", "verifying", "done")


def test_get_download_unknown_job_404(client: TestClient) -> None:
    r = client.get("/api/ai/models/download/does-not-exist")
    assert r.status_code == 404


def test_delete_model_rejects_traversal_via_route(client: TestClient) -> None:
    # Multi-segment traversal strings (``../../etc/passwd``, ``..``) never
    # even reach this handler — the HTTP layer collapses dot-segments before
    # routing, so those land on a different (405) route entirely; that
    # collapsing is itself a defense layer. What CAN reach the handler as a
    # single path segment is exercised here; the full containment logic
    # (resolve().relative_to(), symlink rejection) is unit tested directly
    # against app.localllm.manager.delete_model in test_localllm_manager.py.
    for bad_key in ("not-hex!!", "0123456789abcdefEXTRA", "%2e%2e"):
        r = client.delete(f"/api/ai/models/{bad_key}")
        assert r.status_code in (400, 404), bad_key


def test_delete_model_unknown_key_404(client: TestClient) -> None:
    r = client.delete("/api/ai/models/deadbeef0000")
    assert r.status_code == 404


def test_post_active_unknown_key_404(client: TestClient) -> None:
    r = client.post("/api/ai/models/active", json={"role": "main", "key": "0" * 12})
    assert r.status_code == 404


def test_post_active_bad_role_422(client: TestClient) -> None:
    r = client.post("/api/ai/models/active", json={"role": "bogus", "key": None})
    assert r.status_code == 422


def test_post_hot_unknown_key_404(client: TestClient) -> None:
    r = client.post("/api/ai/models/hot", json={"key": "0" * 12, "hot": True})
    assert r.status_code == 404


def test_post_engine_valid_and_invalid(client: TestClient) -> None:
    r = client.post("/api/ai/engine", json={"engine": "llamacpp"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "engine": "llamacpp"}

    r2 = client.post("/api/ai/engine", json={"engine": "bogus"})
    assert r2.status_code == 422
