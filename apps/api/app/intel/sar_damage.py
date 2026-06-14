"""SAR change-detection for conflict damage — Sentinel-1 amplitude log-ratio.

All-weather, free, satellite. Fetch S1 VV backscatter over a war-zone AOI at a
PRE date and a POST date (each a ~12-day mosaic via CDSE), co-registered on one
grid, and compute the log-ratio change. Building collapse changes radar
scattering (loss of double-bounce -> backscatter drop), so large |change| flags
damage CANDIDATES.

HONEST LIMITS (do not over-claim): amplitude change detects CHANGE, not
specifically destruction — construction, flooding, agriculture and seasonal
effects also change backscatter, and speckle is noisy. The demonstrated
damage-grade method is SLC *coherence* loss (InSAR), a heavier pipeline; this
amplitude version is the fast first pass and must be validated against UNOSAT /
Copernicus EMS before any damage claim. Output is labelled "SAR change
(candidate)", never "confirmed destroyed".
"""

from __future__ import annotations

from io import BytesIO
from typing import Any

import numpy as np

from app.imagery import cdse

# Conflict AOIs (lon0, lat0, lon1, lat1).
AOIS: dict[str, tuple[float, float, float, float]] = {
    "gaza-city": (34.42, 31.49, 34.53, 31.56),
    "khan-younis": (34.27, 31.32, 34.37, 31.39),
    "mariupol": (37.50, 47.07, 37.62, 47.14),
    "bakhmut": (37.97, 48.57, 38.04, 48.62),
}


def _to_gray(img: bytes) -> np.ndarray:
    from PIL import Image

    return np.asarray(Image.open(BytesIO(img)).convert("L")).astype(np.float32)


def log_ratio(pre: np.ndarray, post: np.ndarray) -> np.ndarray:
    """Log-ratio change in [-1,1]-ish: negative = backscatter drop (collapse),
    positive = increase. Computed on calibrated amplitude proxies (+1 to avoid
    log(0))."""
    r = np.log((post + 1.0) / (pre + 1.0))
    # robust scale to [-1,1] by the 98th percentile of |r|
    s = np.percentile(np.abs(r), 98) or 1.0
    return np.clip(r / s, -1.0, 1.0)


async def detect_damage(
    aoi: str,
    date_pre: str,
    date_post: str,
    width: int = 1024,
    height: int = 768,
    thresh: float = 0.45,
) -> dict[str, Any]:
    """Fetch pre/post S1 VV over the AOI (same grid), return change map + stats.

    Returns arrays under `_`-prefixed keys for the caller to render; a JSON-safe
    summary otherwise."""
    if aoi not in AOIS:
        raise KeyError(aoi)
    if not cdse.available():
        raise RuntimeError("cdse credentials not configured")
    bbox = cdse.lonlat_bbox_3857(*AOIS[aoi])
    pre_b = await cdse.fetch_image("S1_GRD_VV", bbox, width, height, date_pre)
    post_b = await cdse.fetch_image("S1_GRD_VV", bbox, width, height, date_post)
    if not pre_b or not post_b:
        return {"aoi": aoi, "error": "missing S1 imagery for one of the dates"}
    pre = _to_gray(pre_b)
    post = _to_gray(post_b)
    change = log_ratio(pre, post)
    drop = change < -thresh  # collapse candidates (backscatter loss)
    rise = change > thresh
    return {
        "aoi": aoi,
        "date_pre": date_pre,
        "date_post": date_post,
        "summary": {
            "px_total": int(change.size),
            "px_drop_pct": round(100.0 * float(drop.mean()), 2),
            "px_rise_pct": round(100.0 * float(rise.mean()), 2),
            "mean_abs_change": round(float(np.abs(change).mean()), 3),
        },
        "_pre": pre,
        "_post": post,
        "_change": change,
        "_bbox": bbox,
        "_size": [width, height],
    }
