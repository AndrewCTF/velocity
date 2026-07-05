"""Object detection on a satellite chip → geo-referenced GeoJSON.

Pulls one image chip for an AOI via the existing CDSE fetch path, runs the
proven YOLO sidecar (the same JSON-line protocol the desktop app uses), and
maps each normalized pixel box back to lon/lat so detections drop onto the
globe as points — closing the tip-and-cue loop (a detector tips an AOI, this
counts what's in it).

Torch is NEVER imported here: YOLO runs in its own CUDA venv as a one-shot
subprocess (``yolo_python`` config). Absent venv → an honest note, empty
features — never a fake detection.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import os
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.imagery import cdse

log = logging.getLogger(__name__)

# Spherical web-mercator radius (EPSG:3857) — matches cdse.lonlat_to_3857.
_R = 6378137.0

# Chip sizing: cap the long edge so a wide AOI can't request a huge render.
_MAX_PX = 1280
_MIN_PX = 256

# detect.py is apps/api/app/imagery/detect.py → parents[4] is the repo root.
_SIDECAR = Path(__file__).resolve().parents[4] / "apps" / "desktop" / "sidecar" / "yolo_sidecar.py"
_YOLO_TIMEOUT_S = 120.0  # cold model load + one frame


def _3857_to_lonlat(x: float, y: float) -> tuple[float, float]:
    """Inverse spherical mercator: EPSG:3857 metres → WGS84 lon/lat (deg)."""
    lon = math.degrees(x / _R)
    lat = math.degrees(2 * math.atan(math.exp(y / _R)) - math.pi / 2)
    return lon, lat


def pixel_to_lonlat(
    bbox3857: list[float], nx: float, ny: float
) -> tuple[float, float]:
    """Normalized pixel (nx, ny) in [0,1] → lon/lat, for a chip covering bbox3857.

    Image pixel origin is top-left, so ny=0 is the NORTH (max-y) edge in 3857.
    bbox3857 is [minx, miny, maxx, maxy].
    """
    minx, miny, maxx, maxy = bbox3857
    x = minx + nx * (maxx - minx)
    y = maxy - ny * (maxy - miny)  # invert: top of image = north
    return _3857_to_lonlat(x, y)


def _chip_px(bbox3857: list[float]) -> tuple[int, int]:
    """Pixel dims preserving the AOI aspect, long edge clamped to [_MIN_PX,_MAX_PX]."""
    minx, miny, maxx, maxy = bbox3857
    span_x = max(1.0, maxx - minx)
    span_y = max(1.0, maxy - miny)
    if span_x >= span_y:
        w = _MAX_PX
        h = max(_MIN_PX, int(_MAX_PX * span_y / span_x))
    else:
        h = _MAX_PX
        w = max(_MIN_PX, int(_MAX_PX * span_x / span_y))
    return w, h


async def _run_yolo(image_bytes: bytes) -> list[dict[str, Any]] | None:
    """One-shot YOLO over a chip via the CUDA-venv sidecar. None → sidecar absent."""
    settings = get_settings()
    py = getattr(settings, "yolo_python", "") or ""
    if not py or not _SIDECAR.exists():
        return None
    req = json.dumps({"id": "chip", "image_b64": base64.b64encode(image_bytes).decode()}) + "\n"
    try:
        proc = await asyncio.create_subprocess_exec(
            py, str(_SIDECAR),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ},
        )
        out, _ = await asyncio.wait_for(proc.communicate(req.encode()), _YOLO_TIMEOUT_S)
    except (OSError, asyncio.TimeoutError) as e:
        log.warning("yolo sidecar failed: %r", e)
        return None
    # The sidecar emits a __status__ line then one reply per request; take the
    # first line carrying a detections array for our id.
    for line in out.decode(errors="replace").splitlines():
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("id") == "chip" and "detections" in msg:
            return msg["detections"]
    return []


async def detect_chip(
    bbox: list[float], date: str, layer_id: str = "S2_L2A_TRUECOLOR"
) -> dict[str, Any]:
    """Detect objects in an AOI. bbox = [min_lon, min_lat, max_lon, max_lat].

    Returns a GeoJSON FeatureCollection of point detections + a summary. Degrades
    to empty features + a note when imagery or the YOLO sidecar is unavailable.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    bbox3857 = cdse.lonlat_bbox_3857(min_lon, min_lat, max_lon, max_lat)
    w, h = _chip_px(bbox3857)

    img = await cdse.fetch_image(layer_id, bbox3857, w, h, date)
    if not img:
        return {"type": "FeatureCollection", "features": [],
                "summary": {"detections": 0, "note": "imagery unavailable (check CDSE creds / date)"}}

    dets = await _run_yolo(img)
    if dets is None:
        return {"type": "FeatureCollection", "features": [],
                "summary": {"detections": 0, "note": "YOLO sidecar offline (set yolo_python to the CUDA venv)"}}

    features = []
    for i, d in enumerate(dets):
        b = d.get("bbox") or {}
        # centre of the normalized box
        cx = float(b.get("x", 0.0)) + float(b.get("w", 0.0)) / 2
        cy = float(b.get("y", 0.0)) + float(b.get("h", 0.0)) / 2
        lon, lat = pixel_to_lonlat(bbox3857, cx, cy)
        features.append({
            "type": "Feature",
            "id": f"detect:{layer_id}:{date}:{i}",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "kind": "detection",
                "source": f"yolo:{layer_id}",
                "cls": d.get("cls"),
                "conf": round(float(d.get("conf", 0.0)), 3),
                "date": date,
            },
        })

    classes: dict[str, int] = {}
    for f in features:
        c = str(f["properties"]["cls"])
        classes[c] = classes.get(c, 0) + 1
    return {
        "type": "FeatureCollection",
        "features": features,
        "summary": {"detections": len(features), "classes": classes, "layer": layer_id, "date": date},
    }
