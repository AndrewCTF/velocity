"""Models root, install registry, download jobs, active/hot roles.

Security invariants enforced here (design doc "Security invariants" 1-3, 8):
  1. Downloads are HF ``repo_id`` only (``unsloth/`` org regex), never a raw
     URL — ``snapshot_download(allow_patterns=[f"*{quant}*.gguf"])`` is the
     only network fetch path, so there is no SSRF surface.
  2. Disk preflight: the matched-file byte sum (from ``HfApi.model_info``)
     times 1.2 must fit free disk, else 507 — checked BEFORE any bytes move.
  3. Delete: single ``models_root``; the target is resolved and required to
     be ``relative_to`` the root, symlinks are rejected; ``.gguf`` +
     ``metadata.json``/``.cache`` are removed by name, then any remaining
     regular file is reclaimed too so the whole directory is freed — a
     symlink is still never followed.
  8. Only ``.gguf`` is ever accepted/served — never ``.bin``/``.pt``/``.ckpt``
     (the pickle-RCE class); ``allow_patterns`` also only ever matches quant
     substrings within ``*.gguf``-suffixed filenames.

Job state and the active/hot registry are in-memory + a small JSON sidecar
under the models root (``.manager_state.json``) — same "fresh read/write, no
long-lived connection" idiom as ``app.foundry.store`` / ``app.history``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from huggingface_hub import HfApi, snapshot_download

from app.config import Settings, get_settings

from . import catalog

log = logging.getLogger("localllm.manager")

# ── validation ────────────────────────────────────────────────────────────────
# Custom repos are restricted to the unsloth org exactly like every catalog
# entry — one regex, one code path, no separate "trusted catalog" bypass.
REPO_ID_PATTERN = r"^unsloth/[A-Za-z0-9._\-]{1,96}$"
QUANT_PATTERN = r"^[A-Za-z0-9._\-]{1,32}$"
_REPO_ID_RE = re.compile(REPO_ID_PATTERN)
_QUANT_RE = re.compile(QUANT_PATTERN)
_KEY_RE = re.compile(r"^[0-9a-f]{12}$")

_DISK_PREFLIGHT_MARGIN = 1.2


def key_for(repo_id: str, quant: str) -> str:
    """Server-issued opaque model key — never a filesystem path."""
    return hashlib.sha1(f"{repo_id}:{quant}".encode()).hexdigest()[:12]


def validate_repo_id(repo_id: str) -> None:
    if not _REPO_ID_RE.match(repo_id):
        raise HTTPException(
            status_code=422,
            detail="repo_id must match ^unsloth/[A-Za-z0-9._-]{1,96}$",
        )


def validate_quant(quant: str) -> None:
    if not _QUANT_RE.match(quant):
        raise HTTPException(status_code=422, detail="invalid quant string")


# ── models root ───────────────────────────────────────────────────────────────

_models_dir_override: str | None = None


def override_models_dir(path: str | None) -> None:
    """Point the models root at a custom dir (tests). None clears it."""
    global _models_dir_override
    _models_dir_override = path


def models_root(settings: Settings | None = None) -> Path:
    if _models_dir_override is not None:
        root = Path(_models_dir_override)
    else:
        s = settings or get_settings()
        root = Path(s.local_models_dir) if s.local_models_dir else Path("./data/models")
    root.mkdir(parents=True, exist_ok=True)
    try:
        root.chmod(0o700)
    except OSError:  # noqa: S110 — best-effort perms tightening, not fatal
        pass
    return root


# ── install registry ─────────────────────────────────────────────────────────

_STATE_FILENAME = ".manager_state.json"


def _state_path(root: Path) -> Path:
    return root / _STATE_FILENAME


def _default_state() -> dict[str, Any]:
    return {"active": {"main": None, "selection": None}, "hot": []}


def _load_state(root: Path) -> dict[str, Any]:
    p = _state_path(root)
    if p.exists():
        try:
            data = json.loads(p.read_text())
            data.setdefault("active", {"main": None, "selection": None})
            data["active"].setdefault("main", None)
            data["active"].setdefault("selection", None)
            data.setdefault("hot", [])
            return data
        except (OSError, json.JSONDecodeError):
            pass
    return _default_state()


def _save_state(root: Path, state: dict[str, Any]) -> None:
    _state_path(root).write_text(json.dumps(state))


def _tier_for_repo(repo_id: str) -> str | None:
    return catalog.tier_for_repo_id(repo_id)


def list_installed() -> list[dict[str, Any]]:
    """Installed models — scans ``models_root/<key>/metadata.json``."""
    root = models_root()
    st = _load_state(root)
    active = st["active"]
    hot_set = set(st["hot"])
    out: list[dict[str, Any]] = []
    for child in sorted(root.iterdir()):
        if child.is_symlink() or not child.is_dir():
            continue
        meta_path = child / "metadata.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        key = meta.get("key", child.name)
        roles = [r for r in ("main", "selection") if active.get(r) == key]
        out.append(
            {
                "key": key,
                "repo_id": meta.get("repo_id"),
                "quant": meta.get("quant"),
                "filename": meta.get("filename"),
                "size_bytes": meta.get("size_bytes"),
                "tier": meta.get("tier"),
                "roles": roles,
                "hot": key in hot_set,
            }
        )
    return out


def _installed_keys() -> set[str]:
    return {m["key"] for m in list_installed()}


def _write_metadata(target_dir: Path, key: str, repo_id: str, quant: str, size_bytes: int) -> None:
    filenames = sorted(p.name for p in target_dir.iterdir() if p.is_file() and p.suffix == ".gguf")
    meta = {
        "key": key,
        "repo_id": repo_id,
        "quant": quant,
        "filename": filenames[0] if len(filenames) == 1 else filenames,
        "size_bytes": size_bytes,
        "tier": _tier_for_repo(repo_id),
        "installed_at": time.time(),
    }
    (target_dir / "metadata.json").write_text(json.dumps(meta))


# ── delete (containment invariant #3) ────────────────────────────────────────


def delete_model(key: str) -> None:
    """Delete an installed model by its server-issued key.

    Rejects anything that is not exactly a 12-hex-char key (so ``../``,
    absolute paths, and multi-segment strings 4xx before any filesystem call),
    then re-verifies containment via ``resolve().relative_to(root)`` and
    refuses to follow a symlinked model directory. ``.gguf`` files, the
    ``metadata.json`` sidecar, and the ``.cache`` dir HF's own downloader
    writes are removed by name; any other remaining regular file is then
    reclaimed too so the whole model directory is freed. A symlink anywhere
    inside is never followed.
    """
    if not _KEY_RE.match(key):
        raise HTTPException(status_code=404, detail="unknown model key")
    root = models_root().resolve()
    target = root / key
    if target.is_symlink():  # checked BEFORE resolve() — never follow it anywhere
        raise HTTPException(status_code=404, detail="unknown model key")
    try:
        resolved = target.resolve()
        resolved.relative_to(root)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail="invalid model key") from exc
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="unknown model key")
    meta_path = target / "metadata.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="unknown model key")

    for child in list(target.iterdir()):
        if child.is_symlink():
            continue  # never follow — could point outside the models root
        if child.is_file() and (child.suffix == ".gguf" or child.name == "metadata.json"):
            child.unlink()
        elif child.is_dir() and child.name == ".cache":
            shutil.rmtree(child, ignore_errors=True)  # HF's own local_dir metadata

    # Reclaim the whole directory, not just the known filenames: a stray
    # regular file (e.g. a README/config.json a looser historical
    # allow_patterns pulled down alongside the .gguf) must not be left behind
    # forever. Still bounded by the containment guard above — never follows a
    # symlink, and only ever touches files inside `target`.
    if target.is_dir():
        for child in list(target.iterdir()):
            if child.is_symlink():
                continue  # never follow
            if child.is_file():
                child.unlink()
        try:
            target.rmdir()
        except OSError:
            pass  # unexpected leftover subdirectory — leave for the operator, not a security issue
    _drop_active_refs(key)


def _drop_active_refs(key: str) -> None:
    root = models_root()
    st = _load_state(root)
    changed = False
    for role in ("main", "selection"):
        if st["active"].get(role) == key:
            st["active"][role] = None
            changed = True
    if key in st["hot"]:
        st["hot"].remove(key)
        changed = True
    if changed:
        _save_state(root, st)


# ── active / hot roles ────────────────────────────────────────────────────────


def get_active() -> dict[str, str | None]:
    return dict(_load_state(models_root())["active"])


def get_hot() -> list[str]:
    return list(_load_state(models_root())["hot"])


def set_active(role: str, key: str | None) -> dict[str, str | None]:
    if role not in ("main", "selection"):
        raise HTTPException(status_code=422, detail="role must be 'main' or 'selection'")
    if key is not None and key not in _installed_keys():
        raise HTTPException(status_code=404, detail="unknown model key")
    root = models_root()
    st = _load_state(root)
    st["active"][role] = key
    _save_state(root, st)
    return dict(st["active"])


def set_hot(key: str, hot: bool) -> list[str]:
    if key not in _installed_keys():
        raise HTTPException(status_code=404, detail="unknown model key")
    root = models_root()
    st = _load_state(root)
    hot_set = set(st["hot"])
    if hot:
        hot_set.add(key)
    else:
        hot_set.discard(key)
    st["hot"] = sorted(hot_set)
    _save_state(root, st)
    return list(st["hot"])


# ── download jobs ─────────────────────────────────────────────────────────────


@dataclass
class Job:
    job_id: str
    repo_id: str
    quant: str
    key: str
    status: str = "queued"  # queued|downloading|verifying|done|error
    bytes_total: int = 0
    bytes_done: int = 0
    progress_pct: float = 0.0
    error: str | None = None
    created: float = field(default_factory=time.time)

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "progress_pct": self.progress_pct,
            "bytes_done": self.bytes_done,
            "bytes_total": self.bytes_total,
            "error": self.error,
            "key": self.key if self.status == "done" else None,
        }


_JOBS: dict[str, Job] = {}
_MAX_JOBS = 100


def get_job(job_id: str) -> dict[str, Any] | None:
    job = _JOBS.get(job_id)
    return job.as_dict() if job else None


def _prune_jobs() -> None:
    if len(_JOBS) <= _MAX_JOBS:
        return
    finished = sorted(
        (j for j in _JOBS.values() if j.status in ("done", "error")),
        key=lambda j: j.created,
    )
    for j in finished[: len(_JOBS) - _MAX_JOBS]:
        _JOBS.pop(j.job_id, None)


def _matched_files(repo_id: str, quant: str) -> list[dict[str, Any]]:
    """HF Hub metadata for the ``.gguf`` files matching *quant* — never
    downloads bytes; used for the size preflight + post-download sha256
    verification. Only ``.gguf`` files are ever matched (invariant #8)."""
    info = HfApi().model_info(repo_id, files_metadata=True)
    matched: list[dict[str, Any]] = []
    for sib in info.siblings or []:
        fname = sib.rfilename
        if not fname.endswith(".gguf") or quant.lower() not in fname.lower():
            continue
        lfs = getattr(sib, "lfs", None)
        sha256 = getattr(lfs, "sha256", None) if lfs is not None else None
        matched.append({"filename": fname, "size": sib.size or 0, "sha256": sha256})
    return matched


def _verify_sha256(target_dir: Path, sha256_by_file: dict[str, str]) -> bool:
    for fname, expected in sha256_by_file.items():
        fp = target_dir / fname
        if not fp.is_file():
            return False
        h = hashlib.sha256()
        with fp.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != expected:
            return False
    return True


def _dir_size(path: Path) -> int:
    total = 0
    for f in path.rglob("*"):
        if f.is_file():
            try:
                total += f.stat().st_size
            except OSError:
                continue
    return total


async def _progress_monitor(job: Job, target_dir: Path) -> None:
    try:
        while True:
            await asyncio.sleep(0.5)
            done = await asyncio.to_thread(_dir_size, target_dir)
            job.bytes_done = done
            if job.bytes_total:
                job.progress_pct = min(99.0, done / job.bytes_total * 100.0)
    except asyncio.CancelledError:
        pass


async def _run_job(job: Job, sha256_by_file: dict[str, str]) -> None:
    root = models_root()
    target_dir = root / job.key
    target_dir.mkdir(parents=True, exist_ok=True)
    job.status = "downloading"
    monitor = asyncio.create_task(_progress_monitor(job, target_dir))
    try:
        await asyncio.to_thread(
            snapshot_download,
            repo_id=job.repo_id,
            # .gguf-scoped, not a bare quant substring (invariant #8) — a
            # same-quant non-.gguf sibling (README, config.json, a stray .bin)
            # must never even be REQUESTED from the hub, not just filtered
            # after the fact. Every repo we serve is single-file-per-quant or
            # numbered-shard-per-quant (e.g. "...-00001-of-00003.gguf"), and
            # both still end in ".gguf", so one pattern covers both layouts —
            # consistent with ``_matched_files``'s own ``endswith(".gguf")``.
            allow_patterns=[f"*{job.quant}*.gguf"],
            local_dir=str(target_dir),
        )
    except Exception as exc:  # noqa: BLE001 — surface any HF/network failure to the job
        job.status = "error"
        job.error = str(exc)
        monitor.cancel()
        return
    monitor.cancel()

    job.status = "verifying"
    ok = await asyncio.to_thread(_verify_sha256, target_dir, sha256_by_file)
    if not ok:
        job.status = "error"
        job.error = "sha256 verification failed"
        return

    size_bytes = await asyncio.to_thread(
        lambda: sum(
            p.stat().st_size for p in target_dir.iterdir() if p.is_file() and p.suffix == ".gguf"
        )
    )
    await asyncio.to_thread(
        _write_metadata, target_dir, job.key, job.repo_id, job.quant, size_bytes
    )
    job.bytes_done = job.bytes_total
    job.progress_pct = 100.0
    job.status = "done"


async def start_download(repo_id: str, quant: str) -> str:
    """Validate, preflight disk, and kick off the background download job.

    Raises 422 for a bad repo_id/quant, 404 when no matching ``.gguf`` file
    exists for the quant, and 507 when the preflight (matched size * 1.2)
    exceeds free disk — all BEFORE any bytes move.
    """
    validate_repo_id(repo_id)
    validate_quant(quant)

    matched = await asyncio.to_thread(_matched_files, repo_id, quant)
    if not matched:
        raise HTTPException(
            status_code=404,
            detail=f"no .gguf files matching quant {quant!r} found for {repo_id}",
        )
    total_bytes = sum(m["size"] for m in matched)

    root = models_root()
    disk_free = await asyncio.to_thread(lambda: shutil.disk_usage(root).free)
    if total_bytes * _DISK_PREFLIGHT_MARGIN > disk_free:
        needed_gb = total_bytes * _DISK_PREFLIGHT_MARGIN / 1e9
        free_gb = disk_free / 1e9
        raise HTTPException(
            status_code=507,
            detail=f"insufficient disk space: need ~{needed_gb:.1f}GB free, have {free_gb:.1f}GB",
        )

    key = key_for(repo_id, quant)
    job_id = uuid.uuid4().hex
    job = Job(job_id=job_id, repo_id=repo_id, quant=quant, key=key, bytes_total=total_bytes)
    _JOBS[job_id] = job
    sha_map = {m["filename"]: m["sha256"] for m in matched if m["sha256"]}
    asyncio.create_task(_run_job(job, sha_map))
    _prune_jobs()
    return job_id
