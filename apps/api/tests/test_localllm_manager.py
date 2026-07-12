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


async def test_start_download_dedups_in_flight_job(monkeypatch: pytest.MonkeyPatch) -> None:
    """A second download of a model already in flight returns the SAME job id
    instead of spawning a second snapshot_download into the same dir."""
    _fake_hf_api(
        monkeypatch,
        [SimpleNamespace(rfilename="model-UD-Q4_K_XL.gguf", size=10, lfs=None)],
    )
    started = {"n": 0}

    def slow_snapshot_download(**kw):
        started["n"] += 1
        import time as _t

        _t.sleep(0.2)  # keep the job in "downloading" long enough to race a 2nd POST
        target = Path(kw["local_dir"])
        target.mkdir(parents=True, exist_ok=True)
        (target / "model-UD-Q4_K_XL.gguf").write_bytes(b"0123456789")

    monkeypatch.setattr(manager, "snapshot_download", slow_snapshot_download)

    job_id_1 = await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    job_id_2 = await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    assert job_id_1 == job_id_2  # deduped, not a second job

    import asyncio

    job = manager._JOBS[job_id_1]
    for _ in range(200):
        if job.status in ("done", "error"):
            break
        await asyncio.sleep(0.01)
    assert job.status == "done", job.error
    assert started["n"] == 1  # snapshot_download ran exactly once


async def test_delete_model_refuses_while_download_running() -> None:
    """A model whose bytes are still landing cannot be deleted (409)."""
    key = _install_fake_model()
    # Plant a live download job targeting the same key.
    job = manager.Job(
        job_id="j1",
        repo_id="unsloth/Qwen3.5-9B-GGUF",
        quant="UD-Q4_K_XL",
        key=key,
        status="downloading",
    )
    manager._JOBS[job.job_id] = job
    with pytest.raises(HTTPException) as exc:
        manager.delete_model(key)
    assert exc.value.status_code == 409
    # A finished job no longer blocks deletion.
    job.status = "done"
    manager.delete_model(key)
    assert key not in {m["key"] for m in manager.list_installed()}


async def test_delete_model_blocks_racing_download_via_deleting_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """delete_model must hold the key in _DELETING across the wipe so a
    start_download racing between the running-job check and the rmdir is
    rejected (409) instead of writing into the directory being deleted."""
    key = _install_fake_model()
    _fake_hf_api(
        monkeypatch,
        [SimpleNamespace(rfilename="model-UD-Q4_K_XL.gguf", size=10, lfs=None)],
    )
    # A key claimed for deletion rejects a racing start_download with 409.
    manager._DELETING.add(key)
    try:
        with pytest.raises(HTTPException) as exc:
            await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
        assert exc.value.status_code == 409
    finally:
        manager._DELETING.discard(key)
    # And delete_model releases the guard in finally even on wipe error.
    boom = _install_fake_model()

    def raise_wipe(k: str) -> None:
        raise RuntimeError("wipe blew up")

    monkeypatch.setattr(manager, "_delete_model_files", raise_wipe)
    with pytest.raises(RuntimeError):
        manager.delete_model(boom)
    assert boom not in manager._DELETING


async def test_start_download_concurrent_dedups_to_single_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Concurrent (not merely sequential) POSTs for the same model register
    exactly ONE job — the check-and-reserve is atomic, so a second caller
    racing the first through the (slow) HF preflight dedups against the queued
    placeholder instead of spawning a second download."""
    import asyncio

    def slow_matched_files(repo_id, quant):  # noqa: ARG001
        import time as _t

        _t.sleep(0.15)  # widen the check→register window both callers race
        return [{"filename": "model-UD-Q4_K_XL.gguf", "size": 10, "sha256": None}]

    monkeypatch.setattr(manager, "_matched_files", slow_matched_files)

    def fake_snapshot_download(**kw):
        target = Path(kw["local_dir"])
        target.mkdir(parents=True, exist_ok=True)
        (target / "model-UD-Q4_K_XL.gguf").write_bytes(b"0123456789")

    monkeypatch.setattr(manager, "snapshot_download", fake_snapshot_download)

    ids = await asyncio.gather(
        manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL"),
        manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL"),
    )
    assert ids[0] == ids[1], "concurrent starts must dedup to one job id"
    # Only the reserved job (and no orphan placeholder) is registered.
    key = manager.key_for("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    jobs_for_key = [j for j in manager._JOBS.values() if j.key == key]
    assert len(jobs_for_key) == 1

    job = manager._JOBS[ids[0]]
    for _ in range(200):
        if job.status in ("done", "error"):
            break
        await asyncio.sleep(0.01)
    assert job.status == "done", job.error


async def test_start_download_drops_placeholder_on_preflight_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 404/507 preflight failure must mark the placeholder job status='error'
    (so a deduped second caller polling that job_id sees the failure instead of a
    404) rather than pop it — and it must no longer count as a running job."""
    _fake_hf_api(
        monkeypatch,
        [SimpleNamespace(rfilename="model-Q8_0.gguf", size=1000, lfs=None)],
    )
    with pytest.raises(HTTPException) as exc:
        await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    assert exc.value.status_code == 404
    key = manager.key_for("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    jobs = [j for j in manager._JOBS.values() if j.key == key]
    assert len(jobs) == 1
    assert jobs[0].status == "error"
    assert jobs[0].error
    # An errored placeholder is not "running": it must neither dedup a future
    # start nor block deletion.
    assert manager._running_job_for_key(key) is None


def test_running_job_for_key_survives_concurrent_mutation() -> None:
    """_running_job_for_key must not raise "dict changed size during iteration"
    while other threads register/pop jobs — reads and writes share _JOBS_LOCK."""
    import threading

    key = manager.key_for("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    stop = threading.Event()

    def churn() -> None:
        i = 0
        while not stop.is_set():
            jid = f"j{i}"
            with manager._JOBS_LOCK:
                manager._JOBS[jid] = manager.Job(
                    job_id=jid, repo_id="unsloth/x", quant="q", key=f"{i:012d}"[:12]
                )
            with manager._JOBS_LOCK:
                manager._JOBS.pop(jid, None)
            i += 1

    t = threading.Thread(target=churn)
    t.start()
    try:
        for _ in range(2000):
            manager._running_job_for_key(key)  # must never raise
    finally:
        stop.set()
        t.join()


def test_set_active_validates_installed_under_lock() -> None:
    """Regression for the resurrection race: set_active must reject a key that
    is not installed even though the check now lives inside the state lock."""
    with pytest.raises(HTTPException) as exc:
        manager.set_active("main", "abcabcabcabc")
    assert exc.value.status_code == 404


async def test_download_without_upstream_sha_is_unverified(monkeypatch: pytest.MonkeyPatch) -> None:
    """No lfs.sha256 published → the download is accepted but flagged
    verified:false rather than silently passing verification."""
    _fake_hf_api(
        monkeypatch,
        [SimpleNamespace(rfilename="model-UD-Q4_K_XL.gguf", size=10, lfs=None)],
    )

    def fake_snapshot_download(**kw):
        target = Path(kw["local_dir"])
        target.mkdir(parents=True, exist_ok=True)
        (target / "model-UD-Q4_K_XL.gguf").write_bytes(b"0123456789")

    monkeypatch.setattr(manager, "snapshot_download", fake_snapshot_download)

    import asyncio

    job_id = await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    job = manager._JOBS[job_id]
    for _ in range(200):
        if job.status in ("done", "error"):
            break
        await asyncio.sleep(0.01)
    assert job.status == "done", job.error
    assert manager.get_job(job_id)["verified"] is False


async def test_download_with_matching_sha_is_verified(monkeypatch: pytest.MonkeyPatch) -> None:
    import hashlib as _h

    payload = b"verified-payload"
    sha = _h.sha256(payload).hexdigest()
    _fake_hf_api(
        monkeypatch,
        [
            SimpleNamespace(
                rfilename="model-UD-Q4_K_XL.gguf", size=len(payload), lfs=SimpleNamespace(sha256=sha)
            )
        ],
    )

    def fake_snapshot_download(**kw):
        target = Path(kw["local_dir"])
        target.mkdir(parents=True, exist_ok=True)
        (target / "model-UD-Q4_K_XL.gguf").write_bytes(payload)

    monkeypatch.setattr(manager, "snapshot_download", fake_snapshot_download)

    import asyncio

    job_id = await manager.start_download("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    job = manager._JOBS[job_id]
    for _ in range(200):
        if job.status in ("done", "error"):
            break
        await asyncio.sleep(0.01)
    assert job.status == "done", job.error
    assert manager.get_job(job_id)["verified"] is True


# ── models_root ───────────────────────────────────────────────────────────────


def test_models_root_created_with_restrictive_perms() -> None:
    root = manager.models_root()
    assert root.is_dir()
    mode = oct(os.stat(root).st_mode & 0o777)
    assert mode == oct(0o700)
