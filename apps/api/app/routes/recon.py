"""Local 3D Gaussian Splatting reconstruction jobs (Studio backend).

POST images or a video → frames (ffmpeg) → COLMAP SfM (.mamba-colmap) → gsplat
train (.venv, built against the .mamba-cuda 12.8 toolchain for Blackwell sm_120)
→ INRIA .ply export. Progress streams over SSE; the finished .ply is served for
the in-app WebGL viewer. Everything runs LOCALLY on the box's GPU — no upload,
no cloud, no telemetry.

Reuses the repo's background-task pattern (asyncio.create_task, like
adsb.start_snapshot) and SSE idiom (StreamingResponse text/event-stream, like
intel.py). The route inherits ApiKeyMiddleware; a keyless local run passes through.

ponytail: ONE job at a time (a single GPU). _GPU_LOCK serializes; concurrent
POSTs queue. Multi-GPU scheduling is a later concern — note the ceiling, don't
build a scheduler for one card.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import struct
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

router = APIRouter(tags=["recon"], prefix="/api/recon")

# ── paths (env-overridable; default to the repo's GPU lab) ───────────────────
_REPO_ROOT = Path(__file__).resolve().parents[4]  # .../OSINT
_FUSION = Path(os.environ.get("FUSION_DIR") or (_REPO_ROOT / "apps" / "ml" / "fusion"))
_MAMBA = os.environ.get("MICROMAMBA_BIN") or shutil.which("micromamba") or str(
    Path.home() / ".local" / "bin" / "micromamba"
)
_JOBS_ROOT = _FUSION / ".recon_jobs"

_VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}
_LOG_CAP = 400  # keep the tail; a full COLMAP/train log is large

Stage = Literal["queued", "frames", "sfm", "train", "export", "done", "error"]

# job_id -> {id, status, stage, pct, log: list[str], error, n_gaussians, created}
_JOBS: dict[str, dict[str, Any]] = {}
_GPU_LOCK = asyncio.Lock()


def _cuda_env() -> dict[str, str]:
    """SKYFALL_3DGS_SETUP env so gsplat's JIT compile targets sm_120 with the
    bundled CUDA 12.8 toolchain — NOT the system nvcc (which fatals on
    'compute_120'). This is the single most load-bearing detail of the pipeline."""
    ch = _FUSION / ".mamba-cuda"
    env = dict(os.environ)
    env.update(
        CUDA_HOME=str(ch),
        PATH=f"{ch / 'bin'}:{env.get('PATH', '')}",
        CC=str(ch / "bin" / "x86_64-conda-linux-gnu-gcc"),
        CXX=str(ch / "bin" / "x86_64-conda-linux-gnu-g++"),
        NVCC_PREPEND_FLAGS=f"-ccbin {ch / 'bin' / 'x86_64-conda-linux-gnu-g++'}",
        TORCH_CUDA_ARCH_LIST="12.0",
        FORCE_CUDA="1",
        MAX_JOBS="8",
        C_INCLUDE_PATH=str(ch / "include"),
        CPATH=str(ch / "include"),
        LIBRARY_PATH=str(ch / "lib"),
        LD_LIBRARY_PATH=str(ch / "lib"),
        PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True",
    )
    return env


def _log(job: dict[str, Any], line: str) -> None:
    line = line.rstrip()
    if not line:
        return
    job["log"].append(line)
    if len(job["log"]) > _LOG_CAP:
        del job["log"][: len(job["log"]) - _LOG_CAP]


def _set(job: dict[str, Any], *, stage: Stage | None = None, pct: float | None = None) -> None:
    if stage is not None:
        job["stage"] = stage
    if pct is not None:
        job["pct"] = round(max(0.0, min(100.0, pct)), 1)


async def _run(job: dict[str, Any], argv: list[str], env: dict[str, str], cwd: Path) -> None:
    """Run a subprocess, streaming stdout into the job log. Raises on non-zero."""
    _log(job, f"$ {' '.join(argv[:4])} …")
    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=str(cwd), env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    assert proc.stdout is not None
    async for raw in proc.stdout:
        line = raw.decode("utf-8", "replace")
        _log(job, line)
        # train_gs prints "step N/T loss …" — surface coarse train progress.
        if job["stage"] == "train" and line.lstrip().startswith("step "):
            try:
                frac = eval_step_fraction(line)
                if frac is not None:
                    _set(job, pct=40 + frac * 55)  # train spans 40→95
            except Exception:  # noqa: BLE001
                pass
    rc = await proc.wait()
    if rc != 0:
        raise RuntimeError(f"{argv[3] if len(argv) > 3 else argv[0]} exited {rc}")


def eval_step_fraction(line: str) -> float | None:
    """Parse 'step 350/400 loss …' → 0.875. Pure + tested below."""
    parts = line.split()
    if len(parts) < 2 or parts[0] != "step":
        return None
    a, _, b = parts[1].partition("/")
    if not b:
        return None
    cur, tot = int(a), int(b)
    return cur / tot if tot > 0 else None


_IMG_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}


async def _pipeline_mapany(job_id: str) -> None:
    """Single (or few) image(s) → MapAnything feed-forward metric 3D → INRIA .ply.

    One GPU forward pass — no SfM, no per-scene training — so a single satellite
    chip works. NOTE: a single near-overhead satellite view carries little height
    cue, so the splat is near-2.5D relief (textured plane); true building 3D needs
    multi-view (the EOGS path). Reuses the same job/SSE/.ply plumbing as `_pipeline`
    so the Studio Spark viewer serves the result identically (`out/point_cloud.ply`).
    """
    job = _JOBS[job_id]
    work = _JOBS_ROOT / job_id
    inp = work / "images"
    out = work / "out"
    try:
        async with _GPU_LOCK:
            _set(job, stage="frames", pct=8)
            n_imgs = sum(1 for p in inp.iterdir() if p.suffix.lower() in _IMG_EXT)
            _log(job, f"{n_imgs} input image(s) → MapAnything feed-forward")
            if n_imgs < 1:
                raise RuntimeError("no input image")
            _set(job, stage="sfm", pct=20)  # 'sfm' label = feed-forward geometry step
            out.mkdir(parents=True, exist_ok=True)
            await _run(job, [
                str(_FUSION / ".venv" / "bin" / "python"),
                str(_FUSION / "recon" / "mapany_to_splat.py"),
                "--images", str(inp),
                "--ply", str(out / "point_cloud.ply"),
            ], dict(os.environ), _FUSION)
        ply = out / "point_cloud.ply"
        if not ply.exists():
            raise RuntimeError("MapAnything produced no point_cloud.ply")
        job["n_gaussians"] = _ply_vertex_count(ply)
        _set(job, stage="done", pct=100)
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = f"{type(exc).__name__}: {exc}"
        _set(job, stage="error")
        _log(job, f"ERROR {job['error']}")


def register_image_job(images: list[tuple[str, bytes]], mode: str = "mapany") -> str:
    """Create a recon job from in-memory image bytes (used by the EUSI / imagery →
    splat routes). Writes the images into the job dir and launches the chosen
    pipeline. Must be called from within the running event loop."""
    if not _FUSION.exists() or not (_FUSION / ".venv").exists():
        raise HTTPException(503, f"recon GPU lab not found at {_FUSION}")
    job_id = uuid.uuid4().hex[:12]
    inp = _JOBS_ROOT / job_id / "images"
    inp.mkdir(parents=True, exist_ok=True)
    saved = 0
    for name, data in images:
        fn = Path(name).name or f"img{saved}.png"
        (inp / fn).write_bytes(data)
        saved += 1
    if saved == 0:
        raise HTTPException(400, "no images")
    _JOBS[job_id] = {
        "id": job_id, "status": "running", "stage": "queued", "pct": 0.0,
        "log": [], "error": None, "n_gaussians": 0, "created": time.time(),
    }
    task = (
        _pipeline_mapany(job_id) if mode == "mapany"
        else _pipeline(job_id, 7000, 3, 1, "sequential")
    )
    asyncio.create_task(task)
    return job_id


_SAT_ROOT = _FUSION / ".sat_data" / "mvs3dm"


def register_sat_job(dataset: str, *, max_views: int = 20, gsd: float = 1.0) -> tuple[str, int]:
    """Build a recon job from a local MVS3DM AOI (keyless WV-3 + RPC). Copies up to
    *max_views* chips + their RPC sidecars into the job dir and runs the RPC-native
    plane-sweep stereo → DSM → height-coloured splat. Returns (job_id, n_views).

    NOTE: this uses rpc_stereo (classical RPC stereo), NOT gsplat-from-scratch — a
    near-orthographic ~600 km camera makes per-scene gsplat diverge to a diffuse blob,
    whereas the plane sweep validates to ~2.8 m RMSE vs the MVS3DM LiDAR truth."""
    if not re.fullmatch(r"[A-Za-z0-9_]{1,40}", dataset):
        raise HTTPException(400, "bad dataset name")
    src = _SAT_ROOT / dataset
    aoi = src / dataset if (src / dataset).is_dir() else src  # zips unpack into a same-named subdir
    tifs = sorted(aoi.glob("*.tif"))
    if not tifs:
        known = [p.name for p in _SAT_ROOT.iterdir()] if _SAT_ROOT.exists() else "none"
        raise HTTPException(404, f"no MVS3DM AOI '{dataset}' on disk at {_SAT_ROOT} "
                                 f"(known: {known})")
    if max_views > 0:
        tifs = tifs[:max_views]
    job_id = uuid.uuid4().hex[:12]
    work = _JOBS_ROOT / job_id
    scene = work / "aoi"  # rpc_stereo reads *.tif + rpc_*.txt from ONE dir
    scene.mkdir(parents=True, exist_ok=True)
    for tif in tifs:
        shutil.copy(tif, scene / tif.name)
        rpc = aoi / ("rpc_" + tif.stem + ".txt")
        if not rpc.exists():
            hits = list(aoi.glob("*" + tif.stem + "*.txt"))
            rpc = hits[0] if hits else None
        if rpc is None:
            raise HTTPException(502, f"missing RPC sidecar for {tif.name}")
        shutil.copy(rpc, scene / ("rpc_" + tif.stem + ".txt"))
    _JOBS[job_id] = {
        "id": job_id, "status": "running", "stage": "queued", "pct": 0.0,
        "log": [], "error": None, "n_gaussians": 0, "created": time.time(),
    }
    asyncio.create_task(_pipeline_sat(job_id, gsd))
    return job_id, len(tifs)


async def _pipeline_sat(job_id: str, gsd: float) -> None:
    """MVS3DM AOI (<work>/aoi/*.tif + rpc) → RPC plane-sweep DSM → height-coloured splat."""
    job = _JOBS[job_id]
    work = _JOBS_ROOT / job_id
    out = work / "out"
    try:
        async with _GPU_LOCK:  # CPU-bound but serialise with GPU jobs (shares the box)
            out.mkdir(parents=True, exist_ok=True)
            _set(job, stage="sfm", pct=15)
            _log(job, "RPC plane-sweep stereo (rpc_stereo)")
            await _run(job, [
                str(_FUSION / ".venv" / "bin" / "python"),
                str(_FUSION / "recon" / "rpc_stereo.py"),
                "--aoi", str(work / "aoi"),
                "--ply", str(out / "point_cloud.ply"),
                "--gsd", str(gsd),
            ], dict(os.environ), _FUSION)
        ply = out / "point_cloud.ply"
        if not ply.exists():
            raise RuntimeError("rpc_stereo produced no point_cloud.ply")
        job["n_gaussians"] = _ply_vertex_count(ply)
        _set(job, stage="done", pct=100)
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = f"{type(exc).__name__}: {exc}"
        _set(job, stage="error")
        _log(job, f"ERROR {job['error']}")


async def _pipeline(job_id: str, steps: int, sh: int, down: int, matcher: str,
                    sfm: str = "pi3") -> None:
    job = _JOBS[job_id]
    work = _JOBS_ROOT / job_id
    inp = work / "images"  # SfM + train_gs both read <work>/images/
    out = work / "out"
    try:
        async with _GPU_LOCK:
            if sfm == "rpc":
                # SATELLITE RPC path: <work>/images/*.tif + <work>/rpc/rpc_*.txt → COLMAP
                # model via the rigorous rational-polynomial camera (real multi-view
                # geometry, not a monocular depth prior). See rpc_sfm.py + the
                # docs/rpc-satellite-3dgs-plan.md write-up.
                _set(job, stage="sfm", pct=15)
                n_tif = sum(1 for p in inp.iterdir() if p.suffix.lower() in {".tif", ".tiff"})
                _log(job, f"{n_tif} RPC satellite views → rpc_sfm")
                if n_tif < 2:
                    raise RuntimeError(f"need ≥2 RPC views, got {n_tif}")
                await _run(job, [
                    str(_FUSION / ".venv" / "bin" / "python"),
                    str(_FUSION / "recon" / "rpc_sfm.py"),
                    "--scene_dir", str(work), "--downsample", "2",
                ], _cuda_env(), _FUSION)
                if not (work / "sparse" / "0" / "cameras.bin").exists():
                    raise RuntimeError("rpc_sfm produced no sparse model")
                _set(job, pct=40)
            else:
                # 1) FRAMES — if input is a single video, extract; else images already in input/.
                _set(job, stage="frames", pct=5)
                vids = [p for p in inp.iterdir() if p.suffix.lower() in _VIDEO_EXT]
                if vids:
                    src = vids[0]
                    _log(job, f"ffmpeg extract frames from {src.name}")
                    await _run(
                        job,
                        ["ffmpeg", "-i", str(src), "-qscale:v", "2", "-vf", "fps=2",
                         str(inp / "frame_%05d.jpg")],
                        dict(os.environ), work,
                    )
                    src.unlink(missing_ok=True)
                n_imgs = sum(
                    1 for p in inp.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"}
                )
                _log(job, f"{n_imgs} input images")
                if n_imgs < 3:
                    raise RuntimeError(f"need ≥3 images, got {n_imgs}")

                # 2) SFM — Pi3X feed-forward (pretrained yyfz233/Pi3X, permutation-
                # equivariant): ONE GPU forward pass → cam2world poses + dense world
                # points → COLMAP sparse/0 (+ resized frames). Replaces COLMAP
                # feature/match/mapper/undistort — seconds, no incremental SfM. The
                # `matcher` form field is ignored on this path (kept for API compat).
                _set(job, stage="sfm", pct=15)
                await _run(job, [
                    str(_FUSION / ".venv" / "bin" / "python"),
                    str(_FUSION / "recon" / "pi3_sfm.py"),
                    "--scene_dir", str(work),
                ], _cuda_env(), _FUSION)
                if not (work / "sparse" / "0" / "cameras.bin").exists():
                    raise RuntimeError("Pi3X SfM produced no sparse model")
                _set(job, pct=40)

            # 3) TRAIN — gsplat on the GPU (mamba-cuda env so JIT targets sm_120).
            _set(job, stage="train")
            out.mkdir(parents=True, exist_ok=True)
            try:
                await _run(job, [
                    str(_FUSION / ".venv" / "bin" / "python"),
                    str(_FUSION / "recon" / "train_gs.py"),
                    "--data", str(work), "--out", str(out),
                    "--steps", str(steps), "--sh", str(sh), "--down", str(down),
                    "--no-video",  # Studio uses the live WebGL viewer, not the mp4s
                ], _cuda_env(), _FUSION)
            except RuntimeError:
                # train_gs writes splat.pt BEFORE any optional post-step; if the
                # checkpoint exists the GPU train succeeded — carry on to export.
                if not (out / "splat.pt").exists():
                    raise
                _log(job, "train exited nonzero but splat.pt present — continuing")

            # 4) EXPORT — splat.pt → INRIA .ply for the WebGL viewer.
            _set(job, stage="export", pct=96)
            await _run(job, [
                str(_FUSION / ".venv" / "bin" / "python"),
                str(_FUSION / "recon" / "pt_to_ply.py"),
                "--pt", str(out / "splat.pt"), "--ply", str(out / "point_cloud.ply"),
                # Full SH (Spark renders it); cap most-opaque as a size guard so the
                # .ply stays browser-loadable. ponytail: ~1.2M ≈ 300MB; raise once .spz
                # streaming lands (Spark SpzWriter) to drop the cap entirely.
                "--max", "1200000",
            ], dict(os.environ), _FUSION)

        ply = out / "point_cloud.ply"
        if not ply.exists():
            raise RuntimeError("export produced no point_cloud.ply")
        job["n_gaussians"] = _ply_vertex_count(ply)
        _set(job, stage="done", pct=100)
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = f"{type(exc).__name__}: {exc}"
        _set(job, stage="error")
        _log(job, f"ERROR {job['error']}")


def _ply_vertex_count(path: Path) -> int:
    with open(path, "rb") as f:
        for _ in range(60):
            line = f.readline()
            if line.startswith(b"element vertex"):
                return int(line.split()[2])
            if line.startswith(b"end_header") or not line:
                break
    return 0


# ── initial-camera computation (so the in-app viewer opens at a real training
#    viewpoint, not a guessed pose — guessing put the camera inside the cloud
#    → "spilled paint"). Pure-python COLMAP .bin readers (no numpy/torch). ──
def _qvec2rot(q: list[float]) -> list[list[float]]:
    w, x, y, z = q
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]


def _read_images_poses(path: Path) -> list[tuple[list[float], list[float]]]:
    out: list[tuple[list[float], list[float]]] = []
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            f.read(4)  # image_id
            q = list(struct.unpack("<dddd", f.read(32)))
            t = list(struct.unpack("<ddd", f.read(24)))
            f.read(4)  # camera_id
            while f.read(1) not in (b"\x00", b""):  # name
                pass
            (npts,) = struct.unpack("<Q", f.read(8))
            f.read(24 * npts)
            out.append((q, t))
    return out


def _read_points_median(path: Path, sample: int = 4000) -> list[float]:
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        xs: list[float] = []
        ys: list[float] = []
        zs: list[float] = []
        step = max(1, n // sample)
        for i in range(n):
            f.read(8)  # point id
            x, y, z = struct.unpack("<ddd", f.read(24))
            f.read(3 + 8)  # rgb + error
            (tl,) = struct.unpack("<Q", f.read(8))
            f.read(8 * tl)
            if i % step == 0:
                xs.append(x)
                ys.append(y)
                zs.append(z)
    med = lambda a: sorted(a)[len(a) // 2] if a else 0.0  # noqa: E731
    return [med(xs), med(ys), med(zs)]


def _initial_camera(sparse0: Path) -> dict[str, list[float]] | None:
    imgs = sparse0 / "images.bin"
    pts = sparse0 / "points3D.bin"
    if not imgs.exists() or not pts.exists():
        return None
    poses = _read_images_poses(imgs)
    if not poses:
        return None
    med = _read_points_median(pts)
    q, t = poses[len(poses) // 2]  # a central view
    R = _qvec2rot(q)
    Rt = [[R[j][i] for j in range(3)] for i in range(3)]  # R^T
    mul = lambda M, v: [sum(M[r][c] * v[c] for c in range(3)) for r in range(3)]  # noqa: E731
    C = [(-mul(Rt, t)[i]) - med[i] for i in range(3)]      # cam centre in centered space
    fwd = mul(Rt, [0.0, 0.0, 1.0])                          # OpenCV looks +Z
    up = [-x for x in mul(Rt, [0.0, 1.0, 0.0])]             # cam +Y down → up = -y
    dist = sum(c * c for c in C) ** 0.5 * 0.6 + 1.0
    tgt = [C[i] + fwd[i] * dist for i in range(3)]
    return {"position": C, "target": tgt, "up": up}


# ── routes ───────────────────────────────────────────────────────────────────
@router.post("/jobs")
async def create_job(
    files: list[UploadFile] = File(...),
    steps: int = Form(7000),
    sh: int = Form(3),
    down: int = Form(1),
    matcher: str = Form("sequential"),
    mode: str = Form("full"),  # full=Pi3X SfM+gsplat; mapany=single-image feed-forward
) -> dict[str, Any]:
    if not _FUSION.exists() or not (_FUSION / ".venv").exists():  # noqa: ASYNC240 — one-shot filesystem check for the recon job, blocking is fine
        raise HTTPException(503, f"recon GPU lab not found at {_FUSION}")
    steps = max(200, min(steps, 30000))
    sh = max(0, min(sh, 3))
    down = max(1, min(down, 8))
    job_id = uuid.uuid4().hex[:12]
    work = _JOBS_ROOT / job_id
    inp = work / "images"  # Pi3X SfM + train_gs read <work>/images/
    inp.mkdir(parents=True, exist_ok=True)
    saved = 0
    for uf in files:
        name = Path(uf.filename or f"f{saved}").name
        if not name:
            continue
        with open(inp / name, "wb") as out:  # noqa: ASYNC230 — one-shot write of the recon input chip, blocking is fine
            shutil.copyfileobj(uf.file, out)
        saved += 1
    if saved == 0:
        raise HTTPException(400, "no files received")
    _JOBS[job_id] = {
        "id": job_id, "status": "running", "stage": "queued", "pct": 0.0,
        "log": [], "error": None, "n_gaussians": 0, "created": time.time(),
    }
    task = (
        _pipeline_mapany(job_id) if mode == "mapany"
        else _pipeline(job_id, steps, sh, down, matcher)
    )
    asyncio.create_task(task)
    return {"job_id": job_id, "status": "running"}


@router.post("/sat")
async def create_sat_job(
    dataset: str = Form("MasterProvisional1"),
    max_views: int = Form(20),
    gsd: float = Form(1.0),
) -> dict[str, Any]:
    """3D from KEYLESS WV-3 satellite + RPC (IARPA MVS3DM). Unlike source=eusi (a
    rendered ortho tile with no camera model → flat "hills"), these carry the rigorous
    RPC sensor model, so RPC plane-sweep stereo yields a real DSM (~2.8 m RMSE vs the
    bundled LiDAR truth). Datasets live under apps/ml/fusion/.sat_data/mvs3dm/
    (e.g. MasterProvisional1..3, Explorer). Result serves at jobs/{id}/result.ply."""
    if not _FUSION.exists() or not (_FUSION / ".venv").exists():  # noqa: ASYNC240 — one-shot filesystem check for the recon job, blocking is fine
        raise HTTPException(503, f"recon GPU lab not found at {_FUSION}")
    gsd = max(0.3, min(gsd, 5.0))
    job_id, n = register_sat_job(dataset, max_views=max_views, gsd=gsd)
    return {"job_id": job_id, "status": "running", "dataset": dataset, "n_views": n}


def _public(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job["id"], "status": job["status"], "stage": job["stage"],
        "pct": job["pct"], "error": job["error"], "n_gaussians": job["n_gaussians"],
        "log_tail": job["log"][-12:],
    }


@router.get("/jobs")
async def list_jobs() -> dict[str, Any]:
    return {"jobs": [_public(j) for j in sorted(_JOBS.values(), key=lambda j: -j["created"])]}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    return _public(job)


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str) -> StreamingResponse:
    if job_id not in _JOBS:
        raise HTTPException(404, "no such job")

    async def gen() -> AsyncIterator[str]:
        last = None
        while True:
            job = _JOBS.get(job_id)
            if job is None:
                break
            snap = _public(job)
            key = (snap["stage"], snap["pct"], snap["status"], len(job["log"]))
            if key != last:
                yield f"data: {json.dumps(snap)}\n\n"
                last = key
            if job["status"] in ("done", "error"):
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _job_dir(job_id: str) -> Path:
    # job_id is a URL path component → validate it's a bare hex token (no
    # traversal) before joining. Serve from DISK so artifacts survive a restart
    # (the in-memory _JOBS dict does not).
    if not re.fullmatch(r"[0-9a-f]{6,32}", job_id):
        raise HTTPException(404, "no such job")
    return _JOBS_ROOT / job_id


@router.get("/jobs/{job_id}/result.ply")
async def job_result(job_id: str) -> FileResponse:
    ply = _job_dir(job_id) / "out" / "point_cloud.ply"
    if not ply.exists():
        raise HTTPException(404, "result not ready")
    return FileResponse(str(ply), media_type="application/octet-stream", filename="point_cloud.ply")


@router.get("/jobs/{job_id}/result.spz")
async def job_result_spz(job_id: str) -> FileResponse:
    """Full-SH .spz (Niantic, ~10x smaller than .ply) — the streamed artifact for
    the in-app Spark viewer, so the WHOLE splat loads with no opacity cap."""
    spz = _job_dir(job_id) / "out" / "point_cloud.spz"
    if not spz.exists():
        raise HTTPException(404, "spz not ready")
    return FileResponse(str(spz), media_type="application/octet-stream", filename="point_cloud.spz")


@router.get("/jobs/{job_id}/camera.json")
async def job_camera(job_id: str) -> dict[str, Any]:
    """A good initial viewer camera (a real training viewpoint, in the splat's
    median-centered space) so the in-app viewer opens framed on the scene."""
    cam = _initial_camera(_job_dir(job_id) / "sparse" / "0")
    if cam is None:
        raise HTTPException(404, "camera not ready")
    return cam
