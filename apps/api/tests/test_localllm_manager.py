"""Unit tests for app.localllm.manager — no network (HfApi/snapshot_download
mocked); covers the security invariants (traversal delete, repo_id/quant
regex, disk preflight 507) and the download job + active/hot lifecycle.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.localllm import manager


@pytest.fixture(autouse=True)
def _isolate_models_dir(tmp_path: Path):
    manager.override_models_dir(str(tmp_path / "models"))
    manager._JOBS.clear()
    yield
    manager.override_models_dir(None)
    manager._JOBS.clear()


def _install_fake_model(repo_id: str = "unsloth/Qwen3.5-9B-GGUF", quant: str = "UD-Q4_K_XL") -> str:
    """Write a fake installed model directly to disk (bypassing downloads)."""
    key = manager.key_for(repo_id, quant)
    root = manager.models_root()
    target = root / key
    target.mkdir(parents=True, exist_ok=True)
    (target / "model.gguf").write_bytes(b"fake-weights")
    manager._write_metadata(target, key, repo_id, quant, size_bytes=12)
    return key


# ── repo_id / quant validation (invariant #1) ────────────────────────────────


def test_validate_repo_id_accepts_unsloth_org() -> None:
    manager.validate_repo_id("unsloth/Qwen3.5-9B-GGUF")  # no raise


@pytest.mark.parametrize(
    "bad_repo_id",
    [
        "evilorg/Qwen3.5-9B-GGUF",
        "https://evil.example.com/unsloth/Qwen3.5-9B-GGUF",
        "unsloth/../../etc/passwd",
        "unsloth/",
        "UNSLOTH/Qwen3.5-9B-GGUF",  # case-sensitive org
        "unsloth/" + "x" * 200,  # too long
        "",
    ],
)
def test_validate_repo_id_rejects_non_unsloth(bad_repo_id: str) -> None:
    with pytest.raises(HTTPException) as exc:
        manager.validate_repo_id(bad_repo_id)
    assert exc.value.status_code == 422


@pytest.mark.parametrize("bad_quant", ["", "a" * 40, "../etc", "q/../.."])
def test_validate_quant_rejects_bad_strings(bad_quant: str) -> None:
    with pytest.raises(HTTPException) as exc:
        manager.validate_quant(bad_quant)
    assert exc.value.status_code == 422


# ── delete containment (invariant #3) ────────────────────────────────────────


def test_delete_model_happy_path() -> None:
    key = _install_fake_model()
    assert key in {m["key"] for m in manager.list_installed()}
    manager.delete_model(key)
    assert key not in {m["key"] for m in manager.list_installed()}


@pytest.mark.parametrize(
    "bad_key",
    [
        "../../../etc/passwd",
        "/etc/passwd",
        "..",
        "not-hex-key!!",
        "0123456789abcdefEXTRA",
        "",
    ],
)
def test_delete_model_rejects_traversal_keys(bad_key: str, tmp_path: Path) -> None:
    # A real target file elsewhere on disk that must NEVER be touched.
    sentinel = tmp_path / "sentinel.txt"
    sentinel.write_text("do not touch")
    with pytest.raises(HTTPException) as exc:
        manager.delete_model(bad_key)
    assert exc.value.status_code in (400, 404)
    assert sentinel.exists()
    assert sentinel.read_text() == "do not touch"


def test_delete_model_rejects_symlinked_model_dir() -> None:
    root = manager.models_root()
    outside = root.parent / "outside-secret"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "keepme.txt").write_text("keep")

    # A key-shaped directory that is actually a symlink to somewhere else.
    key = "abcdef012345"
    (root / key).symlink_to(outside, target_is_directory=True)

    with pytest.raises(HTTPException) as exc:
        manager.delete_model(key)
    assert exc.value.status_code == 404
    assert (outside / "keepme.txt").exists()  # untouched


def test_delete_model_unknown_valid_looking_key_404() -> None:
    with pytest.raises(HTTPException) as exc:
        manager.delete_model("deadbeef0000")
    assert exc.value.status_code == 404


def test_delete_model_reclaims_stray_non_gguf_siblings(tmp_path: Path) -> None:
    """A stray non-.gguf file left in the install dir (e.g. a README a looser
    historical ``allow_patterns`` pulled down alongside the .gguf) must not
    survive a delete — the whole directory is reclaimed, not just the known
    filenames."""
    key = _install_fake_model()
    root = manager.models_root()
    target = root / key
    (target / "notes.txt").write_text("stray sibling file")
    manager.delete_model(key)
    assert not (target / "model.gguf").exists()
    assert not (target / "metadata.json").exists()
    assert not (target / "notes.txt").exists()
    assert not target.exists()  # whole directory reclaimed, nothing left behind


def test_delete_model_never_follows_internal_symlink(tmp_path: Path) -> None:
    """A symlink planted inside the install dir (pointing outside the models
    root) is removed as a directory entry but its target must never be
    touched, even during the whole-directory reclaim pass."""
    key = _install_fake_model()
    root = manager.models_root()
    target = root / key
    outside = root.parent / "outside-secret-2"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "keepme.txt").write_text("keep")
    (target / "sneaky-link").symlink_to(outside / "keepme.txt")

    manager.delete_model(key)

    assert (outside / "keepme.txt").exists()
    assert (outside / "keepme.txt").read_text() == "keep"


# ── active / hot roles ────────────────────────────────────────────────────────


def test_set_active_and_get() -> None:
    key = _install_fake_model()
    active = manager.set_active("main", key)
    assert active["main"] == key
    assert manager.get_active()["main"] == key


def test_set_active_unknown_key_404() -> None:
    with pytest.raises(HTTPException) as exc:
        manager.set_active("main", "0" * 12)
    assert exc.value.status_code == 404


def test_set_active_bad_role_422() -> None:
    with pytest.raises(HTTPException) as exc:
        manager.set_active("bogus", None)
    assert exc.value.status_code == 422


def test_set_active_none_clears() -> None:
    key = _install_fake_model()
    manager.set_active("main", key)
    manager.set_active("main", None)
    assert manager.get_active()["main"] is None


def test_set_hot_toggle() -> None:
    key = _install_fake_model()
    hot = manager.set_hot(key, True)
    assert key in hot
    assert key in manager.get_hot()
    hot = manager.set_hot(key, False)
    assert key not in hot


def test_set_hot_unknown_key_404() -> None:
    with pytest.raises(HTTPException) as exc:
        manager.set_hot("0" * 12, True)
    assert exc.value.status_code == 404


def test_delete_model_drops_active_and_hot_refs() -> None:
    key = _install_fake_model()
    manager.set_active("main", key)
    manager.set_hot(key, True)
    manager.delete_model(key)
    assert manager.get_active()["main"] is None
    assert key not in manager.get_hot()


def test_list_installed_reports_roles_and_hot() -> None:
    key = _install_fake_model()
    manager.set_active("selection", key)
    manager.set_hot(key, True)
    rows = manager.list_installed()
    row = next(r for r in rows if r["key"] == key)
    assert row["roles"] == ["selection"]
    assert row["hot"] is True
    assert row["repo_id"] == "unsloth/Qwen3.5-9B-GGUF"


# ── disk preflight (invariant #2) ────────────────────────────────────────────


def _fake_hf_api(monkeypatch: pytest.MonkeyPatch, siblings: list[SimpleNamespace]) -> None:
    class FakeHfApi:
        def model_info(self, repo_id, files_metadata=False):  # noqa: ARG002
            return SimpleNamespace(siblings=siblings)

    monkeypatch.setattr(manager, "HfApi", FakeHfApi)


async def test_start_download_507_when_disk_too_small(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_hf_api(
        monkeypatch,
        [SimpleNamespace(rfilename="model-UD-Q4_K_XL.gguf", size=500_000_000_000, lfs=None)],
    )
    with pytest.raises(HTTPException) as exc:
        await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    assert exc.value.status_code == 507


async def test_start_download_404_when_no_matching_gguf(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_hf_api(
        monkeypatch,
        [SimpleNamespace(rfilename="model-Q8_0.gguf", size=1000, lfs=None)],
    )
    with pytest.raises(HTTPException) as exc:
        await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    assert exc.value.status_code == 404


async def test_start_download_ignores_non_gguf_siblings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Invariant #8: only .gguf is ever matched — a same-quant .bin sibling
    (the pickle-RCE class) must never be counted or downloaded."""
    _fake_hf_api(
        monkeypatch,
        [
            SimpleNamespace(rfilename="model-UD-Q4_K_XL.bin", size=999, lfs=None),
            SimpleNamespace(rfilename="model-UD-Q4_K_XL.gguf", size=10, lfs=None),
        ],
    )

    def fake_snapshot_download(**kw):
        target = Path(kw["local_dir"])
        target.mkdir(parents=True, exist_ok=True)
        (target / "model-UD-Q4_K_XL.gguf").write_bytes(b"0123456789")

    monkeypatch.setattr(manager, "snapshot_download", fake_snapshot_download)

    job_id = await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    job = manager._JOBS[job_id]
    assert job.bytes_total == 10  # only the .gguf sibling counted, not the .bin


async def test_run_job_allow_patterns_are_gguf_scoped(monkeypatch: pytest.MonkeyPatch) -> None:
    """Invariant #8: the ``allow_patterns`` actually handed to
    ``snapshot_download`` must be ``.gguf``-scoped, not a bare quant
    substring — otherwise a same-quant non-``.gguf`` sibling (README,
    config.json, a stray ``.bin``) could be REQUESTED from the hub, not just
    filtered after the fact."""
    _fake_hf_api(
        monkeypatch,
        [SimpleNamespace(rfilename="model-UD-Q4_K_XL.gguf", size=10, lfs=None)],
    )
    captured: dict = {}

    def fake_snapshot_download(**kw):
        captured["allow_patterns"] = kw["allow_patterns"]
        target = Path(kw["local_dir"])
        target.mkdir(parents=True, exist_ok=True)
        (target / "model-UD-Q4_K_XL.gguf").write_bytes(b"0123456789")

    monkeypatch.setattr(manager, "snapshot_download", fake_snapshot_download)

    job_id = await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    job = manager._JOBS[job_id]
    import asyncio

    for _ in range(200):
        if job.status in ("done", "error"):
            break
        await asyncio.sleep(0.01)
    assert job.status == "done", job.error

    patterns = captured["allow_patterns"]
    assert patterns, "snapshot_download must receive an allow_patterns list"
    assert all(p.endswith(".gguf") for p in patterns), patterns
    assert all("UD-Q4_K_XL" in p for p in patterns), patterns


# ── download job lifecycle (mocked snapshot_download) ────────────────────────


async def test_download_job_lifecycle_success(monkeypatch: pytest.MonkeyPatch) -> None:
    import hashlib

    payload = b"fake-gguf-bytes-0123456789"
    sha = hashlib.sha256(payload).hexdigest()

    _fake_hf_api(
        monkeypatch,
        [
            SimpleNamespace(
                rfilename="model-UD-Q4_K_XL.gguf",
                size=len(payload),
                lfs=SimpleNamespace(sha256=sha),
            )
        ],
    )

    def fake_snapshot_download(**kw):
        target = Path(kw["local_dir"])
        target.mkdir(parents=True, exist_ok=True)
        (target / "model-UD-Q4_K_XL.gguf").write_bytes(payload)

    monkeypatch.setattr(manager, "snapshot_download", fake_snapshot_download)

    job_id = await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    job = manager._JOBS[job_id]
    # Wait for the background task to finish (bounded poll, no long sleeps).
    for _ in range(200):
        if job.status in ("done", "error"):
            break
        import asyncio

        await asyncio.sleep(0.01)

    assert job.status == "done", job.error
    result = manager.get_job(job_id)
    assert result["status"] == "done"
    assert result["key"] == manager.key_for("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    assert result["bytes_total"] == len(payload)

    installed = manager.list_installed()
    assert any(m["key"] == result["key"] for m in installed)


async def test_download_job_lifecycle_sha256_mismatch(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_hf_api(
        monkeypatch,
        [
            SimpleNamespace(
                rfilename="model-UD-Q4_K_XL.gguf",
                size=10,
                lfs=SimpleNamespace(sha256="0" * 64),  # wrong on purpose
            )
        ],
    )

    def fake_snapshot_download(**kw):
        target = Path(kw["local_dir"])
        target.mkdir(parents=True, exist_ok=True)
        (target / "model-UD-Q4_K_XL.gguf").write_bytes(b"0123456789")

    monkeypatch.setattr(manager, "snapshot_download", fake_snapshot_download)

    job_id = await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    job = manager._JOBS[job_id]
    import asyncio

    for _ in range(200):
        if job.status in ("done", "error"):
            break
        await asyncio.sleep(0.01)

    assert job.status == "error"
    assert "sha256" in job.error
    # never registered as installed
    assert not any(m["key"] == job.key for m in manager.list_installed())


async def test_download_job_lifecycle_snapshot_download_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_hf_api(
        monkeypatch,
        [SimpleNamespace(rfilename="model-UD-Q4_K_XL.gguf", size=10, lfs=None)],
    )

    def fake_snapshot_download(**kw):
        raise RuntimeError("simulated network failure")

    monkeypatch.setattr(manager, "snapshot_download", fake_snapshot_download)

    job_id = await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    job = manager._JOBS[job_id]
    import asyncio

    for _ in range(200):
        if job.status in ("done", "error"):
            break
        await asyncio.sleep(0.01)

    assert job.status == "error"
    assert "simulated network failure" in job.error


def test_get_job_unknown_returns_none() -> None:
    assert manager.get_job("does-not-exist") is None


# ── models_root ───────────────────────────────────────────────────────────────


def test_models_root_created_with_restrictive_perms() -> None:
    root = manager.models_root()
    assert root.is_dir()
    mode = oct(os.stat(root).st_mode & 0o777)
    assert mode == oct(0o700)
