#!/usr/bin/env python3
"""Stage D1 — 6-DoF camera-pose registration by RENDER-AND-COMPARE against a
Gaussian splat.

Given a scene splat (a `splat.pt` from `train_gs.py`, or a DC-only INRIA `.ply`
from `rpc_stereo.write_splat_ply`) and a single ground/oblique query photo, we
estimate the 6-DoF pose of the camera that took the photo by *rendering* the
splat from candidate poses and *comparing* the render to the query — maximising a
photometric (zero-mean NCC) + edge (Sobel-gradient NCC) similarity. Optimisation
is gradient-free (coarse look-at seed grid → Nelder-Mead refine over full se(3)),
so it is robust to the non-differentiable, appearance-gap cost surface you get
between a satellite-built splat and a ground photo.

This reuses the exact rasterisation path + look-at/view-matrix convention of
`apps/ml/fusion/recon/render_views.py` (gsplat `rasterization`, camera looks down
+z, `vm[:3,:3]=R_c2w.T`, `vm[:3,3]=-R_c2w.T@pos`). render_views only orbits a
fixed arc; here we generalise its `render(vm)` half into a pose-optimisation loop.

MUST run in a venv with gsplat + torch + CUDA — i.e. the fusion sidecar venv
`apps/ml/fusion/.venv`, NOT apps/api/.venv (repo invariant: torch/GPU off the API
venv). Hand-off to other stages is via JSON/PNG.

Usage:
  # correctness gate — build a tiny synthetic splat, render a known pose, recover it:
  python splat_pose.py --self-check

  # real: register a query photo against a built splat:
  python splat_pose.py --splat scene.ply --query photo.jpg --out outdir/ [--res 160]

Outputs (to --out): pose.json (6-DoF pose + alignment error + metadata),
render.png (best render), overlay.png (render⊕query false-colour for eyeballing).

Note: geolocate.contracts models Stage A/B/C JSON (Evidence/GeoPrior/Candidate)
only; there is no canonical pose contract, so pose.json is a Stage-D-internal shape
consumed by Stage E, not a cross-stage wire format.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from dataclasses import dataclass, field

import numpy as np
import torch

# gsplat is the same rasteriser train_gs/render_views use. Import lazily-friendly.
try:
    from gsplat import rasterization
except Exception as _e:  # pragma: no cover - environment guard
    rasterization = None
    _GSPLAT_ERR = _e


# --------------------------------------------------------------------------- #
# Splat container + loaders
# --------------------------------------------------------------------------- #
@dataclass
class Splat:
    """Render-ready Gaussians (activations already applied)."""

    means: torch.Tensor           # (N,3)
    quats: torch.Tensor           # (N,4) raw (gsplat normalises internally)
    scales: torch.Tensor          # (N,3) LINEAR (already exp'd)
    opacities: torch.Tensor       # (N,) LINEAR 0..1 (already sigmoid'd)
    colors: torch.Tensor          # (N,3) RGB in 0..1  OR  (N,K,3) SH coeffs
    sh_degree: int | None         # None => colors are direct RGB; int => SH
    device: str = "cuda"

    @property
    def n(self) -> int:
        return int(self.means.shape[0])

    def scene(self) -> tuple[np.ndarray, float]:
        """Robust centroid (median) + radius (90th pct distance) in world units."""
        m = self.means.detach().cpu().numpy()
        c = np.median(m, axis=0)
        r = float(np.percentile(np.linalg.norm(m - c, axis=1), 90))
        return c.astype(np.float64), max(r, 1e-3)


def load_splat(path: str, device: str = "cuda") -> Splat:
    """Load a splat from `.pt` (train_gs) or INRIA `.ply` (pt_to_ply/rpc_stereo)."""
    if path.endswith(".pt"):
        ck = torch.load(path, map_location=device, weights_only=True)
        means = ck["means"].to(device).float()
        scales = torch.exp(ck["scales"].to(device).float())
        quats = ck["quats"].to(device).float()
        opac = torch.sigmoid(ck["opacities"].to(device).float()).reshape(-1)
        colors = torch.cat([ck["sh0"], ck["shN"]], 1).to(device).float()
        shdeg = int(round(colors.shape[1] ** 0.5)) - 1
        return Splat(means, quats, scales, opac, colors, shdeg, device)
    if path.endswith(".ply"):
        return _load_inria_ply(path, device)
    raise ValueError(f"unknown splat format: {path}")


def _load_inria_ply(path: str, device: str) -> Splat:
    """Parse a binary_little_endian INRIA Gaussian .ply (property order per
    pt_to_ply._attr_names). Handles DC-only (f_dc_* only) and full-SH files.
    Raw values are de-activated exactly as train_gs stored them: scale=log,
    opacity=logit, SH DC → colour via the SH0 basis constant."""
    with open(path, "rb") as f:
        assert f.readline().strip() == b"ply"
        fmt = f.readline().strip()
        assert b"binary_little_endian" in fmt, f"only binary LE .ply supported ({fmt!r})"
        n = None
        props: list[str] = []
        while True:
            line = f.readline()
            if line.startswith(b"element vertex"):
                n = int(line.split()[2])
            elif line.startswith(b"property"):
                props.append(line.split()[-1].decode())
            elif line.startswith(b"end_header"):
                break
            elif not line:
                raise ValueError("no end_header")
        raw = np.frombuffer(f.read(n * len(props) * 4), dtype="<f4").reshape(n, len(props))
    col = {name: i for i, name in enumerate(props)}
    xyz = raw[:, [col["x"], col["y"], col["z"]]]
    f_dc = raw[:, [col["f_dc_0"], col["f_dc_1"], col["f_dc_2"]]]
    scale = raw[:, [col["scale_0"], col["scale_1"], col["scale_2"]]]
    rot = raw[:, [col["rot_0"], col["rot_1"], col["rot_2"], col["rot_3"]]]
    opac = raw[:, col["opacity"]]
    # SH DC (band 0) -> RGB:  c = 0.5 + C0 * f_dc,  C0 = 0.28209479177387814
    C0 = 0.28209479177387814
    rgb = np.clip(0.5 + C0 * f_dc, 0.0, 1.0)
    t = lambda a: torch.tensor(a, dtype=torch.float32, device=device)
    return Splat(
        means=t(xyz),
        quats=t(rot),
        scales=torch.exp(t(scale)),
        opacities=torch.sigmoid(t(opac)).reshape(-1),
        colors=t(rgb),
        sh_degree=None,
        device=device,
    )


# --------------------------------------------------------------------------- #
# Camera geometry (matches render_views.py conventions exactly)
# --------------------------------------------------------------------------- #
def rotvec_to_R(rv: np.ndarray) -> np.ndarray:
    """Rodrigues: axis-angle (3,) -> rotation matrix (3,3)."""
    theta = float(np.linalg.norm(rv))
    if theta < 1e-9:
        return np.eye(3)
    k = rv / theta
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(theta) * K + (1 - math.cos(theta)) * (K @ K)


def R_to_rotvec(R: np.ndarray) -> np.ndarray:
    ang = math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2)))
    if ang < 1e-9:
        return np.zeros(3)
    if abs(ang - math.pi) < 1e-6:  # near-180: use symmetric part
        A = (R + np.eye(3)) / 2
        axis = np.sqrt(np.clip(np.diag(A), 0, 1))
        return axis / (np.linalg.norm(axis) + 1e-12) * ang
    w = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    return w / (2 * math.sin(ang)) * ang


def R_to_quat(R: np.ndarray) -> list[float]:
    tr = np.trace(R)
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s
        y = (R[0, 2] - R[2, 0]) / s
        z = (R[1, 0] - R[0, 1]) / s
    else:
        i = int(np.argmax(np.diag(R)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = math.sqrt(1.0 + R[i, i] - R[j, j] - R[k, k]) * 2
        q = [0.0, 0.0, 0.0]
        q[i] = 0.25 * s
        q[j] = (R[j, i] + R[i, j]) / s
        q[k] = (R[k, i] + R[i, k]) / s
        w = (R[k, j] - R[j, k]) / s
        x, y, z = q
    return [float(w), float(x), float(y), float(z)]


def lookat_R(pos: np.ndarray, target: np.ndarray, up: np.ndarray) -> np.ndarray:
    """camera-to-world rotation looking from pos to target (camera +z = forward),
    identical convention to render_views.lookat_vm."""
    z = target - pos
    z = z / (np.linalg.norm(z) + 1e-12)
    x = np.cross(-up, z)
    if np.linalg.norm(x) < 1e-4:
        x = np.cross(np.array([1.0, 0, 0]), z)
    x = x / (np.linalg.norm(x) + 1e-12)
    y = np.cross(z, x)
    return np.stack([x, y, z], axis=1)  # columns = camera axes in world


def c2w_to_vm(R_c2w: np.ndarray, pos: np.ndarray, device: str) -> torch.Tensor:
    vm = np.eye(4, dtype=np.float32)
    vm[:3, :3] = R_c2w.T
    vm[:3, 3] = -R_c2w.T @ pos
    return torch.tensor(vm, device=device)


# --------------------------------------------------------------------------- #
# Render + comparison cost
# --------------------------------------------------------------------------- #
def render(splat: Splat, vm: torch.Tensor, K: torch.Tensor, W: int, H: int) -> np.ndarray:
    """Rasterise the splat to an (H,W,3) float image in 0..1 (numpy). Same call
    as render_views.render()."""
    with torch.no_grad():
        c, _, _ = rasterization(
            means=splat.means, quats=splat.quats, scales=splat.scales,
            opacities=splat.opacities, colors=splat.colors,
            viewmats=vm[None], Ks=K[None], width=W, height=H,
            sh_degree=splat.sh_degree, packed=False, rasterize_mode="classic",
        )
    return c[0, ..., :3].clamp(0, 1).detach().cpu().numpy()


def _gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 3:
        return (0.299 * img[..., 0] + 0.587 * img[..., 1] + 0.114 * img[..., 2])
    return img


def _ncc(a: np.ndarray, b: np.ndarray) -> float:
    """Zero-mean normalised cross-correlation (Pearson) over the whole image."""
    a = a.ravel() - a.mean()
    b = b.ravel() - b.mean()
    denom = (np.linalg.norm(a) * np.linalg.norm(b)) + 1e-8
    return float((a @ b) / denom)


def _sobel_mag(g: np.ndarray) -> np.ndarray:
    gy, gx = np.gradient(g.astype(np.float64))
    return np.hypot(gx, gy)


def compare(render_img: np.ndarray, query_gray: np.ndarray,
            w_edge: float = 0.5) -> tuple[float, float, float]:
    """Return (cost, ncc_photo, ncc_edge). Cost in [0,2], lower is better.
    Empty/near-constant renders are penalised (their NCC is ~0)."""
    rg = _gray(render_img)
    ncc_p = _ncc(rg, query_gray)
    ncc_e = _ncc(_sobel_mag(rg), _sobel_mag(query_gray))
    # A near-empty render has ~0 std -> _ncc ~0; the (1-ncc) terms push it away.
    cost = (1.0 - ncc_p) + w_edge * (1.0 - ncc_e)
    return cost, ncc_p, ncc_e


# --------------------------------------------------------------------------- #
# Pose optimisation
# --------------------------------------------------------------------------- #
@dataclass
class RegisterResult:
    position: list[float]
    rotvec: list[float]
    quaternion: list[float]
    c2w: list[list[float]]
    viewmat: list[list[float]]
    cost: float
    ncc_photo: float
    ncc_edge: float
    n_evals: int
    n_gaussians: int
    render_wh: list[int]
    scene_centroid: list[float]
    scene_radius: float
    seconds: float
    tag: str
    notes: str = ""
    extra: dict = field(default_factory=dict)


def _params_to_vm(p: np.ndarray, device: str) -> tuple[torch.Tensor, np.ndarray, np.ndarray]:
    pos = p[:3]
    R = rotvec_to_R(p[3:6])
    return c2w_to_vm(R, pos, device), pos, R


def register(splat: Splat, query_gray: np.ndarray, K: torch.Tensor, W: int, H: int,
             seed_pose: np.ndarray | None = None, n_az: int = 12, n_el: int = 4,
             radii: tuple[float, ...] = (0.9, 1.3, 1.8), n_refine_seeds: int = 3,
             maxiter: int = 220, verbose: bool = False) -> RegisterResult:
    """Coarse look-at seed grid → Nelder-Mead refine over full 6-DoF se(3)."""
    from scipy.optimize import minimize

    t0 = time.time()
    centroid, radius = splat.scene()
    up = np.array([0.0, 0.0, 1.0])  # world up (ENU-up for real satellite clouds)
    evals = {"n": 0}

    def cost_of(p: np.ndarray) -> float:
        evals["n"] += 1
        vm, _, _ = _params_to_vm(p, splat.device)
        img = render(splat, vm, K, W, H)
        c, _, _ = compare(img, query_gray)
        return c

    # ---- coarse seed grid (or use provided seed, e.g. a PnP result) ----
    seeds: list[tuple[float, np.ndarray]] = []
    if seed_pose is not None:
        seeds.append((cost_of(seed_pose), seed_pose.copy()))
    for r_scale in radii:
        r = radius * 3.0 * r_scale  # cameras sit outside the scene
        for ie in range(n_el):
            el = math.radians(10 + 60 * (ie / max(1, n_el - 1)))  # 10..70 deg
            for ia in range(n_az):
                az = 2 * math.pi * ia / n_az
                pos = centroid + r * np.array([
                    math.cos(el) * math.cos(az),
                    math.cos(el) * math.sin(az),
                    math.sin(el),
                ])
                R = lookat_R(pos, centroid, up)
                p = np.concatenate([pos, R_to_rotvec(R)])
                seeds.append((cost_of(p), p))
    seeds.sort(key=lambda s: s[0])
    if verbose:
        print(f"grid: {len(seeds)} seeds, best cost {seeds[0][0]:.4f}", flush=True)

    # ---- refine the best few seeds with Nelder-Mead; keep the global best ----
    best_p, best_c = seeds[0][1], seeds[0][0]
    scale = np.array([radius, radius, radius, 0.3, 0.3, 0.3])
    for _, sp in seeds[:n_refine_seeds]:
        res = minimize(
            cost_of, sp, method="Nelder-Mead",
            options={"maxiter": maxiter, "xatol": radius * 1e-3, "fatol": 1e-4,
                     "initial_simplex": np.vstack([sp, sp + np.diag(scale) * 0.15]).astype(float)},
        )
        if res.fun < best_c:
            best_c, best_p = float(res.fun), res.x
    if verbose:
        print(f"refined best cost {best_c:.4f} after {evals['n']} renders", flush=True)

    vm, pos, R = _params_to_vm(best_p, splat.device)
    img = render(splat, vm, K, W, H)
    cost, ncc_p, ncc_e = compare(img, query_gray)
    c2w = np.eye(4)
    c2w[:3, :3] = R
    c2w[:3, 3] = pos
    return RegisterResult(
        position=pos.tolist(),
        rotvec=best_p[3:6].tolist(),
        quaternion=R_to_quat(R),
        c2w=c2w.tolist(),
        viewmat=vm.detach().cpu().numpy().tolist(),
        cost=float(cost), ncc_photo=float(ncc_p), ncc_edge=float(ncc_e),
        n_evals=evals["n"], n_gaussians=splat.n, render_wh=[W, H],
        scene_centroid=centroid.tolist(), scene_radius=float(radius),
        seconds=round(time.time() - t0, 2),
        tag="heuristic",
        notes="render-and-compare NCC pose; alignment error = 1-ncc_photo",
        extra={"render": img},
    )


# --------------------------------------------------------------------------- #
# Overlay for eyeballing
# --------------------------------------------------------------------------- #
def save_overlay(render_img: np.ndarray, query_gray: np.ndarray, path: str) -> None:
    from PIL import Image
    rg = _gray(render_img)
    rg = (rg - rg.min()) / (np.ptp(rg) + 1e-8)
    q = (query_gray - query_gray.min()) / (np.ptp(query_gray) + 1e-8)
    over = np.zeros((*rg.shape, 3), np.uint8)
    over[..., 0] = (rg * 255).astype(np.uint8)   # render -> red
    over[..., 1] = (q * 255).astype(np.uint8)    # query  -> green (yellow = aligned)
    Image.fromarray(over).save(path)


def load_query_gray(path: str, W: int, H: int) -> np.ndarray:
    from PIL import Image
    im = Image.open(path).convert("L").resize((W, H))
    return np.asarray(im, dtype=np.float64) / 255.0


def default_K(W: int, H: int, fov_deg: float = 55.0) -> torch.Tensor:
    f = 0.5 * W / math.tan(math.radians(fov_deg) / 2)
    return torch.tensor([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], dtype=torch.float32)


# --------------------------------------------------------------------------- #
# Synthetic scene for the self-check
# --------------------------------------------------------------------------- #
def _synthetic_splat(device: str, seed: int = 0) -> Splat:
    """A strongly ASYMMETRIC textured toy scene: a speckled ground plane plus
    four coloured 'buildings' of distinct height/colour/footprint. Asymmetry +
    texture give the NCC cost a clear basin at the true pose (no rotational
    ambiguity)."""
    rng = np.random.default_rng(seed)
    means, colors, scales = [], [], []

    def box(cx, cy, w, h, height, rgb, nz=6, nxy=7):
        for zi in range(nz):
            z = height * zi / (nz - 1)
            for xi in range(nxy):
                for yi in range(nxy):
                    x = cx + w * (xi / (nxy - 1) - 0.5)
                    y = cy + w * (yi / (nxy - 1) - 0.5)
                    means.append([x, y, z])
                    jitter = 0.12 * (rng.random(3) - 0.5)
                    colors.append(np.clip(np.array(rgb) + jitter, 0, 1))
                    scales.append([0.12, 0.12, 0.12])

    # speckled ground (texture so NCC has signal everywhere)
    for _ in range(1400):
        x, y = rng.uniform(-6, 6, 2)
        g = rng.uniform(0.25, 0.65)
        means.append([x, y, 0.0]); colors.append([g, g, g]); scales.append([0.14, 0.14, 0.05])

    # four distinct buildings — unique colour, footprint and height, asymmetric layout
    box(-2.5, -1.0, 1.6, 1.6, 3.0, (0.85, 0.15, 0.15))   # red, tall, SW
    box(2.0, 1.5, 2.2, 2.2, 1.6, (0.15, 0.55, 0.9))      # blue, wide, NE
    box(1.0, -2.8, 1.0, 1.0, 2.2, (0.2, 0.75, 0.2))      # green, narrow, SE
    box(-3.2, 2.6, 1.2, 1.2, 1.1, (0.9, 0.8, 0.15))      # yellow, low, NW

    means = np.array(means, np.float32)
    colors = np.array(colors, np.float32)
    scales = np.array(scales, np.float32)
    quats = np.tile(np.array([1, 0, 0, 0], np.float32), (len(means), 1))
    opac = np.full(len(means), 0.9, np.float32)
    t = lambda a: torch.tensor(a, device=device)
    return Splat(t(means), t(quats), t(scales), t(opac), t(colors), None, device)


def _pose_errors(res: RegisterResult, true_pos: np.ndarray, true_R: np.ndarray,
                 scene_radius: float) -> tuple[float, float]:
    est_pos = np.array(res.position)
    pos_err = float(np.linalg.norm(est_pos - true_pos))
    est_R = np.array(res.c2w)[:3, :3]
    dR = true_R.T @ est_R
    ang = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(dR) - 1) / 2))))
    return pos_err / scene_radius, ang


def self_check(device: str = "cuda", res: int = 160) -> bool:
    """Build synthetic splat, render a KNOWN pose, and confirm the optimiser
    recovers it from a from-scratch coarse grid. Correctness gate — must pass."""
    if rasterization is None:  # pragma: no cover
        print(f"self-check CANNOT RUN: gsplat import failed: {_GSPLAT_ERR}")
        return False
    if not torch.cuda.is_available():  # pragma: no cover
        print("self-check CANNOT RUN: CUDA not available (gsplat needs GPU)")
        return False

    W = H = res
    K = default_K(W, H).to(device)
    splat = _synthetic_splat(device)
    centroid, radius = splat.scene()

    # ground-truth camera: looks at the scene centre from az=40, el=28, r=~3.4*radius
    az, el = math.radians(40), math.radians(28)
    r = radius * 3.4
    true_pos = centroid + r * np.array([math.cos(el) * math.cos(az),
                                        math.cos(el) * math.sin(az), math.sin(el)])
    true_R = lookat_R(true_pos, centroid, np.array([0.0, 0, 1]))
    vm = c2w_to_vm(true_R, true_pos, device)
    query = render(splat, vm, K, W, H)
    query_gray = _gray(query)
    print(f"synthetic splat: {splat.n} gaussians, scene r={radius:.2f}, "
          f"true cam pos={np.round(true_pos,2).tolist()}", flush=True)

    res_reg = register(splat, query_gray, K, W, H, verbose=True)
    pos_err_frac, rot_err_deg = _pose_errors(res_reg, true_pos, true_R, radius)

    print("\n--- RECOVERED vs TRUE ---")
    print(f"true  pos {np.round(true_pos,3).tolist()}")
    print(f"est   pos {np.round(np.array(res_reg.position),3).tolist()}")
    print(f"position error : {pos_err_frac*100:.1f}% of scene radius "
          f"({pos_err_frac*radius:.3f} world units)")
    print(f"rotation error : {rot_err_deg:.2f} deg")
    print(f"final cost {res_reg.cost:.4f}  ncc_photo {res_reg.ncc_photo:.3f} "
          f"ncc_edge {res_reg.ncc_edge:.3f}  renders {res_reg.n_evals}  "
          f"{res_reg.seconds}s")

    ok = pos_err_frac < 0.12 and rot_err_deg < 8.0
    print(f"\nself-check {'OK' if ok else 'FAIL'}: "
          f"pos<12%r ({pos_err_frac*100:.1f}) & rot<8deg ({rot_err_deg:.2f})")
    return ok


# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description="Stage D1 render-and-compare pose registration")
    ap.add_argument("--splat", help="scene splat (.pt or .ply)")
    ap.add_argument("--query", help="query photo")
    ap.add_argument("--out", help="output dir")
    ap.add_argument("--res", type=int, default=160, help="render resolution (square)")
    ap.add_argument("--fov", type=float, default=55.0, help="assumed query h-FOV deg")
    ap.add_argument("--self-check", action="store_true")
    a = ap.parse_args()

    if a.self_check:
        sys.exit(0 if self_check(res=a.res) else 1)

    if not (a.splat and a.query and a.out):
        ap.error("--splat, --query, --out required (or --self-check)")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    os.makedirs(a.out, exist_ok=True)
    W = H = a.res
    K = default_K(W, H, a.fov).to(device)
    splat = load_splat(a.splat, device)
    query_gray = load_query_gray(a.query, W, H)
    print(f"registering {a.query} against {splat.n} gaussians ...", flush=True)
    res = register(splat, query_gray, K, W, H, verbose=True)

    render_img = res.extra.pop("render")
    from PIL import Image
    Image.fromarray((render_img * 255).astype(np.uint8)).save(os.path.join(a.out, "render.png"))
    save_overlay(render_img, query_gray, os.path.join(a.out, "overlay.png"))
    with open(os.path.join(a.out, "pose.json"), "w") as f:
        json.dump(res.__dict__, f, indent=2)
    print(f"pose cost={res.cost:.4f} ncc_photo={res.ncc_photo:.3f} "
          f"-> {a.out}/pose.json  (tag={res.tag})")


if __name__ == "__main__":
    main()
