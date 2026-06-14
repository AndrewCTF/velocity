"""Stage A — multi-sensor co-registered ingest.

Fetch several sensors (Sentinel-2 optical, Sentinel-1 SAR, ...) for one AOI onto a
SINGLE EPSG:3857 grid via the CDSE Sentinel Hub Process API. Because every layer
is requested with the *identical* bbox + width + height, the returned rasters are
pixel-aligned by construction (Sentinel Hub resamples each product to the request
grid) — this sidesteps the classic RPC co-registration problem for the 2-D
colorization stack. Residual misalignment (product geolocation error) is measured
empirically by `alignment_offset` so we never *assume* alignment without a number.

NOTE: this grid alignment is for the 2-D fused stack (colorization input). The 3DGS
stage still needs per-acquisition camera models (RPC) for multi-view geometry —
handled later in the recon stage, not here.
"""

from __future__ import annotations

import math
from io import BytesIO
from typing import Any

import numpy as np

from app.imagery import cdse

# Intact-first, then damaged (operator decision 2026-06-14).
AOIS: dict[str, tuple[float, float, float, float]] = {
    # Intact, clear-sky, dense structure — validate fidelity + colorization.
    "dubai": (55.05, 25.05, 55.30, 25.28),
    # Damaged AOI for the destruction stage / Phase 4 hand-off.
    "gaza": (34.40, 31.45, 34.58, 31.60),
}

# Default sensor stack: optical (color reference) + C-band SAR (all-weather).
DEFAULT_LAYERS = ("S2_L2A_TRUECOLOR", "S1_GRD_VV")


def grid_lonlat(bbox: list[float], w: int, h: int, col: float, row: float) -> tuple[float, float]:
    """Pixel center (col,row) on the request grid -> WGS84 lon/lat."""
    minx, miny, maxx, maxy = bbox
    x = minx + (col + 0.5) / w * (maxx - minx)
    y = maxy - (row + 0.5) / h * (maxy - miny)  # row 0 = top = maxy
    lon = math.degrees(x / cdse._R)
    lat = math.degrees(2.0 * math.atan(math.exp(y / cdse._R)) - math.pi / 2.0)
    return lon, lat


def _grad_mag(a: np.ndarray) -> np.ndarray:
    """Gradient magnitude — shared cross-modal edge signal (SAR vs optical have
    different intensities but the same structural edges)."""
    g = a.astype(np.float32)
    if g.ndim == 3:
        g = g.mean(axis=2)
    gy, gx = np.gradient(g)
    m = np.hypot(gx, gy)
    s = m.std() or 1.0
    return (m - m.mean()) / s


def alignment_offset(a: np.ndarray, b: np.ndarray) -> tuple[int, int]:
    """Estimate integer (dy, dx) shift of ``b`` relative to ``a`` via phase
    correlation on gradient magnitudes. ~(0,0) means well co-registered."""
    fa = _grad_mag(a)
    fb = _grad_mag(b)
    if fa.shape != fb.shape:
        raise ValueError("alignment_offset requires equal shapes")
    A = np.fft.fft2(fa)
    B = np.fft.fft2(fb)
    R = A * np.conj(B)
    R /= np.abs(R) + 1e-9
    r = np.fft.ifft2(R).real
    dy, dx = np.unravel_index(int(np.argmax(r)), r.shape)
    h, w = fa.shape
    if dy > h // 2:
        dy -= h
    if dx > w // 2:
        dx -= w
    return int(dy), int(dx)


def _to_array(img: bytes) -> np.ndarray:
    from PIL import Image

    return np.asarray(Image.open(BytesIO(img)))


async def fetch_aligned_stack(
    aoi: str,
    date: str,
    layers: tuple[str, ...] = DEFAULT_LAYERS,
    width: int = 1024,
    height: int = 1024,
) -> dict[str, Any]:
    """Fetch every layer over the AOI on one grid. Returns arrays keyed by layer
    id plus the shared bbox/size, so all rasters share pixel coordinates."""
    if aoi not in AOIS:
        raise KeyError(aoi)
    if not cdse.available():
        raise RuntimeError("cdse credentials not configured")
    bbox = cdse.lonlat_bbox_3857(*AOIS[aoi])
    arrays: dict[str, np.ndarray] = {}
    for layer in layers:
        img = await cdse.fetch_image(layer, bbox, width, height, date)
        if img:
            arrays[layer] = _to_array(img)
    return {"aoi": aoi, "date": date, "bbox": bbox, "size": [width, height], "arrays": arrays}


def alignment_report(stack: dict[str, Any], reference: str = "S2_L2A_TRUECOLOR") -> dict[str, Any]:
    """Measure each non-reference layer's pixel offset vs the optical reference."""
    arrays = stack["arrays"]
    out: dict[str, Any] = {"reference": reference, "offsets": {}}
    if reference not in arrays:
        out["error"] = "reference layer missing"
        return out
    ref = arrays[reference]
    for layer, arr in arrays.items():
        if layer == reference:
            continue
        out["offsets"][layer] = alignment_offset(ref, arr)
    return out
