"""Stage C training-data prep — tile a co-registered stack into aligned
(SAR, optical) patch pairs for the cross-modal colorizer.

Because Stage A returns every sensor on one grid, tiling both arrays with the
SAME window yields pixel-aligned (input SAR, target optical) pairs — exactly the
supervision the reference-conditioned colorizer needs. Patches that are mostly
no-data (the optical mosaic can have empty regions) are dropped.
"""

from __future__ import annotations

from typing import Any

from app.fusion.ingest import grid_lonlat


def tile_pairs(
    stack: dict[str, Any],
    sar_layer: str = "S1_GRD_VV",
    optical_layer: str = "S2_L2A_TRUECOLOR",
    patch: int = 256,
    stride: int = 256,
    min_content: float = 0.2,
) -> list[dict[str, Any]]:
    """Return co-registered (sar, optical) patch pairs from an aligned stack.

    Each item: {row, col, lon, lat, sar (H,W), optical (H,W,3)}. ``min_content``
    drops patches whose optical target is mostly black (no-data)."""
    arrays = stack["arrays"]
    if sar_layer not in arrays or optical_layer not in arrays:
        return []
    sar = arrays[sar_layer]
    opt = arrays[optical_layer]
    if sar.shape[:2] != opt.shape[:2]:
        raise ValueError("sar/optical grids differ — stack not co-registered")
    bbox = stack["bbox"]
    w, h = stack["size"]
    out: list[dict[str, Any]] = []
    H, W = sar.shape[:2]
    for r in range(0, H - patch + 1, stride):
        for c in range(0, W - patch + 1, stride):
            opt_p = opt[r : r + patch, c : c + patch]
            # fraction of non-black optical pixels (no-data guard)
            content = float((opt_p.reshape(-1, opt_p.shape[-1]).max(axis=1) > 8).mean())
            if content < min_content:
                continue
            lon, lat = grid_lonlat(bbox, w, h, c + patch / 2, r + patch / 2)
            out.append(
                {
                    "row": r,
                    "col": c,
                    "lon": lon,
                    "lat": lat,
                    "sar": sar[r : r + patch, c : c + patch],
                    "optical": opt_p,
                }
            )
    return out
