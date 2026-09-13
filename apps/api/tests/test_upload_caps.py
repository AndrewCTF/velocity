"""G6: every multipart upload is read against a byte cap, never unbounded.

Evidence already capped; Foundry uploads and recon job inputs did not.
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import uploads
from app.config import Settings
from app.foundry import store as foundry_store
from app.routes import recon


def test_foundry_upload_over_cap_is_413(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(foundry_store, "MAX_UPLOAD_BYTES", 64)
    body = b"a,b\n" + b"1,2\n" * 100  # 404 bytes
    r = client.post(
        "/api/foundry/datasets/upload",
        files={"file": ("x.csv", io.BytesIO(body), "text/csv")},
        data={"name": "big"},
    )
    assert r.status_code == 413
    assert "64" in r.json()["detail"]


def test_foundry_upload_under_cap_still_works(client: TestClient) -> None:
    r = client.post(
        "/api/foundry/datasets/upload",
        files={"file": ("x.csv", io.BytesIO(b"a,b\n1,2\n"), "text/csv")},
        data={"name": "small"},
    )
    assert r.status_code == 200, r.text


def test_recon_upload_over_cap_is_413_and_leaves_no_job_dir(
    client: TestClient, monkeypatch, tmp_path: Path
) -> None:
    fusion = tmp_path / "fusion"
    (fusion / ".venv").mkdir(parents=True)
    jobs_root = tmp_path / "jobs"
    jobs_root.mkdir()
    monkeypatch.setattr(recon, "_FUSION", fusion)
    monkeypatch.setattr(recon, "_JOBS_ROOT", jobs_root)
    monkeypatch.setattr(
        recon, "get_settings", lambda: Settings(recon_upload_max_bytes=100)
    )
    started: list[str] = []
    monkeypatch.setattr(recon.asyncio, "create_task", lambda coro: started.append(coro) or coro.close())
    files = [
        ("files", ("a.jpg", io.BytesIO(b"x" * 60), "image/jpeg")),
        ("files", ("b.jpg", io.BytesIO(b"x" * 60), "image/jpeg")),  # total 120 > 100
    ]
    r = client.post("/api/recon/jobs", files=files)
    assert r.status_code == 413
    assert "100" in r.json()["detail"]
    assert list(jobs_root.iterdir()) == []  # the partial job dir is gone
    assert started == []


def test_read_capped_zero_disables_cap() -> None:
    import asyncio

    from starlette.datastructures import UploadFile

    f = UploadFile(io.BytesIO(b"y" * 5000), filename="z")
    assert len(asyncio.run(uploads.read_capped(f, 0))) == 5000
    f2 = UploadFile(io.BytesIO(b"y" * 5000), filename="z")
    with pytest.raises(Exception) as ei:  # noqa: PT011 — HTTPException carries status_code
        asyncio.run(uploads.read_capped(f2, 4999))
    assert getattr(ei.value, "status_code", None) == 413
