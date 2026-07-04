"""Local 3DGS recon route: pure-logic + endpoint wiring (no GPU needed)."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.routes import recon


def test_eval_step_fraction() -> None:
    assert recon.eval_step_fraction("step 350/400 loss 0.1 N=5") == 350 / 400
    assert recon.eval_step_fraction("step 0/400 loss 0.3") == 0.0
    assert recon.eval_step_fraction("trained. final gaussians=5") is None
    assert recon.eval_step_fraction("") is None
    assert recon.eval_step_fraction("step 5/0") is None  # guard div-by-zero


def test_ply_vertex_count(tmp_path: Path) -> None:
    p = tmp_path / "x.ply"
    p.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 42\nproperty float x\nend_header\n")
    assert recon._ply_vertex_count(p) == 42


def test_list_jobs_ok(client: TestClient) -> None:
    r = client.get("/api/recon/jobs")
    assert r.status_code == 200
    assert "jobs" in r.json()


def test_unknown_job_404(client: TestClient) -> None:
    assert client.get("/api/recon/jobs/deadbeef").status_code == 404
    assert client.get("/api/recon/jobs/deadbeef/result.ply").status_code == 404
    assert client.get("/api/recon/jobs/deadbeef/events").status_code == 404


def test_create_requires_files(client: TestClient) -> None:
    # File(...) is required → FastAPI 422 when absent.
    assert client.post("/api/recon/jobs").status_code == 422
