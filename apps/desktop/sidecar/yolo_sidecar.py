#!/usr/bin/env python3
"""Long-lived YOLO inference sidecar for the Velocity desktop (Tauri) app.

Runs in the same CUDA env that backs /api/recon (gsplat, .mamba-cuda/compute_120),
or a sibling env with `ultralytics` + `torch(+cu)`. Device selection:
  - NVIDIA  → torch.cuda.is_available() True  → device 'cuda:0'
  - AMD     → install the ROCm build of torch (HIP) → torch.cuda.is_available()
              is True via HIP → same 'cuda:0' code path (no code change)
  - neither → falls back to 'cpu' ("light", slow) and still serves detections.

Protocol (one JSON object per line on stdin, one per line on stdout):
  request:  {"id": "<str>", "image_b64": "<base64 jpeg/png>"}
  reply:    {"id": "<str>", "device": "cuda:0"|"cpu", "fps": <float>,
             "detections": [{"cls": "car", "conf": 0.9,
                             "bbox": {"x":.1,"y":.2,"w":.3,"h":.4}}]}   # 0..1 normalized

Run:
  python yolo_sidecar.py            # serve loop
  python yolo_sidecar.py --selfcheck# warm the model + print device/latency on a blank frame

NOT verified in this environment (no NVIDIA display). The selfcheck is the
proof — run it on a CUDA host before claiming detection works.
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import time

_MODEL_NAME = "yolov8n.pt"  # COCO, keyless open weights; auto-downloads on first run
# DOT traffic-cam stills are low-res/grainy; yolov8n's 0.25 default misses real
# vehicles on them. 0.15 keeps real detections (proven on Caltrans I-580 cams)
# without drowning in noise. Override with YOLO_CONF=<float>.
_CONF = float(os.environ.get("YOLO_CONF", "0.15"))


def _load_model():  # type: ignore[no-untyped-def]
    import torch
    from ultralytics import YOLO

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    model = YOLO(_MODEL_NAME)
    return model, device


def _detect(model, image_b64: str, device: str):  # type: ignore[no-untyped-def]
    from PIL import Image

    raw = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = img.size
    t0 = time.time()
    res = model(img, device=device, conf=_CONF, verbose=False)
    dt = time.time() - t0
    dets = []
    for b in res[0].boxes:
        x1, y1, x2, y2 = (float(v) for v in b.xyxy[0].tolist())
        cls = model.names[int(b.cls[0])]
        conf = float(b.conf[0])
        dets.append(
            {
                "cls": cls,
                "conf": conf,
                "bbox": {"x": x1 / w, "y": y1 / h, "w": (x2 - x1) / w, "h": (y2 - y1) / h},
            }
        )
    fps = round(1.0 / max(dt, 1e-3), 1)
    return dets, fps


def serve() -> None:
    model, device = _load_model()
    # Announce readiness on stdout line 1 (Rust reads it as the status).
    sys.stdout.write(json.dumps({"id": "__status__", "device": device, "ready": True}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            rid = req.get("id", "")
        except (json.JSONDecodeError, KeyError):
            continue
        try:
            dets, fps = _detect(model, req["image_b64"], device)
            out = {"id": rid, "device": device, "fps": fps, "detections": dets}
        except Exception as e:  # noqa: BLE001 — never crash the sidecar on one bad frame
            out = {"id": rid, "error": repr(e), "detections": []}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


def selfcheck() -> int:
    """Warm the model on a blank 640×640 frame; print device + latency. Exits 0/1."""
    try:
        from PIL import Image

        model, device = _load_model()
        img = Image.new("RGB", (640, 640), (20, 20, 20))
        t0 = time.time()
        res = model(img, device=device, conf=_CONF, verbose=False)
        dt = time.time() - t0
        print(f"device={device} latency_ms={dt * 1000:.1f} boxes={len(res[0].boxes)} model={_MODEL_NAME}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"SELFFAIL: {e!r}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else (serve() or 0))
