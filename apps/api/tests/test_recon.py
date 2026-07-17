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


def test_result_download_denies_non_owner(monkeypatch) -> None:
    # result.ply/spz/camera.json must be owner-scoped like get_job (issue #15), so
    # a leaked/guessed job id can't pull another analyst's reconstruction while the
    # job is still tracked in _JOBS.
    import pytest
    from fastapi import HTTPException

    recon._JOBS["abcdef12"] = {"id": "abcdef12", "owner": "alice", "status": "done", "created": 0.0}
    try:
        monkeypatch.setattr(recon, "_owner_key", lambda req: "bob")
        with pytest.raises(HTTPException) as e:
            recon._owned_job_dir("abcdef12", None)  # type: ignore[arg-type]
        assert e.value.status_code == 404
        # The owner still gets the dir.
        monkeypatch.setattr(recon, "_owner_key", lambda req: "alice")
        assert str(recon._owned_job_dir("abcdef12", None)).endswith("abcdef12")  # type: ignore[arg-type]
        # A job not tracked (evicted / restart-surviving artifact, no owner record
        # left) falls through to disk — the metadata routes degrade the same way.
        assert str(recon._owned_job_dir("beefcafe", None)).endswith("beefcafe")  # type: ignore[arg-type]
    finally:
        recon._JOBS.pop("abcdef12", None)


def test_create_requires_files(client: TestClient) -> None:
    # File(...) is required → FastAPI 422 when absent.
    assert client.post("/api/recon/jobs").status_code == 422
