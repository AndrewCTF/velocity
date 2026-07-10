#!/usr/bin/env python3
"""Stage C3 — terrain / skyline retrieval
(docs/photo-geolocation-pipeline.md §2 Stage C, "C3 terrain/skyline").

Given Stage B's prior bbox and (when available) a terrain-slope or horizon-
skyline cue from Stage A, samples the keyless global DEM (AWS terrarium
tiles — same decode as apps/api/app/intel/offroad.py._decode_terrarium,
copied/adapted self-contained here) and scores ~1 km AOI windows by terrain
match: mean slope against a qualitative/numeric slope hint, or a computed
skyline profile against an observed horizon (when a horizon azimuth->
elevation profile is supplied).

Rangeland/hill shots only — this is Stage C3's whole point. MOST forest-
interior shots (a nadir DEM cannot see a horizon through canopy — spec §0.2)
have no usable cue at all, so `retrieve_candidates` is a deliberate NO-OP in
that case: it logs why and returns an empty candidate list rather than
inventing a terrain signal. That is the expected, correct outcome for those
shots, not a failure.

CLI:
  apps/api/.venv/bin/python -m geolocate.retrieval.terrain \
      --bbox 8.0 54.5 15.2 57.8 --evidence evidence/photo1.json -o candidates.json
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import math
import re
import time
from pathlib import Path
from typing import Any

import numpy as np

try:  # geolocate.contracts is another builder's module (spec §4/§5)
    from geolocate.contracts import Candidate, dump_candidates
except ImportError:  # pragma: no cover - contracts.py not yet present
    Candidate = None  # type: ignore[assignment,misc]
    dump_candidates = None  # type: ignore[assignment]

log = logging.getLogger("geolocate.retrieval.terrain")

_TERRARIUM_OFFSET = 32768.0  # elev_m = (R*256 + G + B/256) - 32768
_MAX_TILES_PER_SIDE = 4  # matches offroad.py's cap — keeps a country-scale bbox from melting AWS
_EARTH_LAT_DEG_M = 110_574.0

# Qualitative Attributes.terrain_slope -> a (low, high) degree range. Code-
# adjacent numeric convention (not a geographic prior), so unlike geoprior's
# cues.yaml this lives in code, not YAML.
_SLOPE_CLASS_RANGES: dict[str, tuple[float, float]] = {
    "gentle": (3.0, 10.0),
    "moderate": (10.0, 20.0),
    "steep": (20.0, 90.0),
}


# ── DEM fetch (self-contained copy/adaptation of offroad.py's tile stitcher) ─


def decode_terrarium(png_bytes: bytes) -> np.ndarray:
    from PIL import Image  # noqa: PLC0415 - heavy import, keep local

    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    arr = np.asarray(img, dtype=np.float32)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    return (r * 256.0 + g + b / 256.0) - _TERRARIUM_OFFSET


def _lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def _tile_to_lonlat(x: float, y: float, z: int) -> tuple[float, float]:
    n = 2**z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def _pick_zoom(min_lon: float, min_lat: float, max_lon: float, max_lat: float, max_tiles: int) -> int:
    """Largest zoom whose tile span over the bbox stays <= max_tiles per side."""
    for z in range(13, 1, -1):
        x0, y0 = _lonlat_to_tile(min_lon, max_lat, z)
        x1, y1 = _lonlat_to_tile(max_lon, min_lat, z)
        if (abs(x1 - x0) + 1) <= max_tiles and (abs(y1 - y0) + 1) <= max_tiles:
            return z
    return 2


def fetch_dem_mosaic(
    bbox: tuple[float, float, float, float], *, max_tiles_per_side: int = _MAX_TILES_PER_SIDE
) -> tuple[np.ndarray, dict[str, Any]]:
    """Fetch + stitch AWS terrarium tiles covering `bbox` (west,south,east,north).

    A large (e.g. country-scale) bbox is capped to `max_tiles_per_side` tiles
    per axis, same as offroad.py — this means a big prior bbox gets a coarse,
    low-zoom mosaic (several km/pixel), which is honestly coarse but keeps
    the request keyless-safe and bounded. Returns (elev_m grid, geo dict with
    nw/se corners + meters_per_cell for pixel<->lonlat conversion).
    """
    import urllib.request  # noqa: PLC0415

    w, s, e, n = bbox
    z = _pick_zoom(w, s, e, n, max_tiles_per_side)
    x0, y0 = _lonlat_to_tile(w, n, z)
    x1, y1 = _lonlat_to_tile(e, s, z)
    xs = list(range(min(x0, x1), max(x0, x1) + 1))
    ys = list(range(min(y0, y1), max(y0, y1) + 1))

    rows: list[np.ndarray] = []
    for ty in ys:
        cols: list[np.ndarray] = []
        for tx in xs:
            url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx}/{ty}.png"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                if resp.status != 200:
                    raise ValueError(f"DEM tile {z}/{tx}/{ty} -> HTTP {resp.status}")
                cols.append(decode_terrarium(resp.read()))
        rows.append(np.hstack(cols))
    elev = np.vstack(rows)

    nw_lon, nw_lat = _tile_to_lonlat(xs[0], ys[0], z)
    se_lon, se_lat = _tile_to_lonlat(xs[-1] + 1, ys[-1] + 1, z)
    h, w_px = elev.shape
    mid_lat = (nw_lat + se_lat) / 2
    meters_per_cell = abs(se_lat - nw_lat) * _EARTH_LAT_DEG_M / max(1, h)

    geo = {
        "nw_lon": nw_lon, "nw_lat": nw_lat, "se_lon": se_lon, "se_lat": se_lat,
        "meters_per_cell": meters_per_cell, "zoom": z, "mid_lat": mid_lat,
        "shape": [h, w_px],
    }
    return elev, geo


def _rc_to_lonlat(r: int, c: int, geo: dict[str, Any]) -> tuple[float, float]:
    h, w = geo["shape"]
    lon = geo["nw_lon"] + (c / max(1, w - 1)) * (geo["se_lon"] - geo["nw_lon"])
    lat = geo["nw_lat"] + (r / max(1, h - 1)) * (geo["se_lat"] - geo["nw_lat"])
    return lon, lat


# ── pure terrain math (network-free — unit-tested on synthetic grids) ──────


def slope_deg_grid(elev: np.ndarray, meters_per_cell: float) -> np.ndarray:
    """Per-cell slope in degrees from the elevation gradient."""
    dzdy, dzdx = np.gradient(elev, meters_per_cell)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy)))


def skyline_from_point(
    elev: np.ndarray,
    origin_rc: tuple[int, int],
    meters_per_cell: float,
    *,
    azimuths_deg: tuple[float, ...] = tuple(range(0, 360, 15)),
    max_range_cells: int = 40,
) -> dict[float, float]:
    """Ray-march outward from `origin_rc` in each azimuth, returning the max
    angular elevation (degrees above the local horizontal) seen along that
    ray — i.e. the terrain skyline as seen FROM that point. Azimuth is
    clockwise-from-north (matches shadow_az_deg convention in contracts.SunCue).
    """
    h, w = elev.shape
    r0, c0 = origin_rc
    z0 = float(elev[r0, c0])
    out: dict[float, float] = {}
    for az in azimuths_deg:
        az_r = math.radians(az)
        d_north, d_east = math.cos(az_r), math.sin(az_r)
        best = -90.0
        for k in range(1, max_range_cells + 1):
            r = int(round(r0 - d_north * k))
            c = int(round(c0 + d_east * k))
            if not (0 <= r < h and 0 <= c < w):
                break
            horiz = k * meters_per_cell
            ang = math.degrees(math.atan2(float(elev[r, c]) - z0, horiz))
            if ang > best:
                best = ang
        out[az] = round(best, 3)
    return out


def match_skyline_profile(
    observed: dict[float, float], predicted: dict[float, float]
) -> tuple[float, float]:
    """Score how well an observed horizon profile matches a predicted (DEM)
    one, searching over azimuth ROTATION (the photo's absolute heading is
    unknown) for the best alignment. Returns (score in (0,1], best_rotation_deg).
    """
    obs_azs = sorted(observed)
    if not obs_azs or not predicted:
        return 0.0, 0.0
    step = obs_azs[1] - obs_azs[0] if len(obs_azs) > 1 else 15.0
    pred_azs = sorted(predicted)
    n = len(obs_azs)
    best_mae = float("inf")
    best_rot = 0.0
    for shift in range(n):
        rot_deg = shift * step
        errs = []
        for i, az in enumerate(obs_azs):
            src_az = obs_azs[(i + shift) % n]
            nearest = min(pred_azs, key=lambda a: abs(((a - src_az + 180) % 360) - 180))
            errs.append(abs(observed[az] - predicted[nearest]))
        mae = sum(errs) / len(errs)
        if mae < best_mae:
            best_mae, best_rot = mae, rot_deg
    return 1.0 / (1.0 + best_mae), best_rot


# ── evidence -> terrain cue (graceful no-op is the common case) ────────────


def _terrain_cue(
    evidence_attrs: dict[str, Any] | Any, horizon_profile: dict[float, float] | None
) -> dict[str, Any] | None:
    if horizon_profile:
        return {"kind": "horizon_profile", "profile": dict(horizon_profile)}

    if hasattr(evidence_attrs, "to_dict"):
        evidence_attrs = evidence_attrs.to_dict()
    attrs = evidence_attrs.get("attributes", evidence_attrs) if isinstance(evidence_attrs, dict) else {}
    slope_hint = attrs.get("terrain_slope") if isinstance(attrs, dict) else None
    if not slope_hint:
        return None
    s = str(slope_hint).strip().lower()
    if s in ("", "none", "unknown", "n/a", "flat"):
        # "flat" is a legitimate answer but not discriminative on its own —
        # most inhabited lowland is flat; this is the common canopy-interior
        # no-op path, not a missing-data failure.
        return None
    m = re.match(r"[-+]?\d+(\.\d+)?", s)
    if m:
        return {"kind": "slope_deg", "value": float(m.group())}
    if s in _SLOPE_CLASS_RANGES:
        return {"kind": "slope_class", "value": s}
    return None


# ── top-level entry point ───────────────────────────────────────────────


def retrieve_candidates(
    evidence_attrs: dict[str, Any] | Any,
    bbox: tuple[float, float, float, float],
    *,
    horizon_profile: dict[float, float] | None = None,
    cell_km: float = 1.0,
    max_tiles_per_side: int = _MAX_TILES_PER_SIDE,
    max_candidates: int = 10,
) -> tuple[list[Any], dict[str, Any]]:
    """Top-level Stage C3 entrypoint. Degrades gracefully (empty list +
    logged `meta["note"]`) when no terrain/horizon cue is available, or when
    the DEM fetch itself fails — never raises into the pipeline.
    """
    cue = _terrain_cue(evidence_attrs, horizon_profile)
    meta: dict[str, Any] = {"cue": cue}

    if cue is None:
        meta["note"] = (
            "no usable terrain/horizon cue (terrain_slope missing/'flat'/unknown, and no "
            "horizon_profile supplied) — most forest-interior shots have no visible skyline "
            "for a nadir DEM to match, so C3 is a deliberate no-op here, not a failure"
        )
        meta["skipped"] = True
        log.info("Stage C3: %s", meta["note"])
        return [], meta

    t0 = time.monotonic()
    try:
        elev, geo = fetch_dem_mosaic(bbox, max_tiles_per_side=max_tiles_per_side)
    except Exception as e:  # noqa: BLE001 - intentionally broad: any failure degrades gracefully
        meta["error"] = str(e)
        meta["note"] = f"DEM fetch failed ({e}) — returning empty candidate list, not crashing"
        log.warning("Stage C3: %s", meta["note"])
        return [], meta
    meta["elapsed_s"] = round(time.monotonic() - t0, 2)
    meta["dem_shape"] = geo["shape"]
    meta["dem_zoom"] = geo["zoom"]

    candidates = _scan_windows(elev, geo, cue, cell_km=cell_km, max_candidates=max_candidates)
    meta["note"] = f"scanned {geo['shape'][0]}x{geo['shape'][1]} DEM mosaic (zoom {geo['zoom']}) -> {len(candidates)} candidate(s)"

    out: list[Any] = []
    for row in candidates:
        if Candidate is not None:
            out.append(Candidate(**row))
        else:  # pragma: no cover - contracts.py not yet present
            out.append(row)
    return out, meta


def _scan_windows(
    elev: np.ndarray,
    geo: dict[str, Any],
    cue: dict[str, Any],
    *,
    cell_km: float,
    max_candidates: int,
) -> list[dict[str, Any]]:
    h, w = elev.shape
    mpc = geo["meters_per_cell"]
    win = max(3, int(round(cell_km * 1000.0 / max(mpc, 1.0))))
    step = max(1, win // 2)

    scored: list[dict[str, Any]] = []
    if cue["kind"] in ("slope_deg", "slope_class"):
        slope = slope_deg_grid(elev, mpc)
        if cue["kind"] == "slope_deg":
            lo, hi = cue["value"] - 5.0, cue["value"] + 5.0
        else:
            lo, hi = _SLOPE_CLASS_RANGES[cue["value"]]
        target = (lo + hi) / 2.0
        for r in range(win // 2, h - win // 2, step):
            for c in range(win // 2, w - win // 2, step):
                window = slope[r - win // 2 : r + win // 2, c - win // 2 : c + win // 2]
                mean_slope = float(np.mean(window))
                if not (lo <= mean_slope <= hi):
                    continue
                score = 1.0 - min(1.0, abs(mean_slope - target) / max(target, 1e-6))
                lon, lat = _rc_to_lonlat(r, c, geo)
                scored.append(
                    {
                        "lat": round(lat, 6), "lon": round(lon, 6),
                        "radius_m": cell_km * 1000.0 / 2.0,
                        "score": round(score, 3),
                        "sources": ["C3:slope"],
                        "evidence": f"DEM mean slope {mean_slope:.1f} deg vs expected "
                                    f"{cue['value']} ({lo:.0f}-{hi:.0f} deg)",
                    }
                )
    elif cue["kind"] == "horizon_profile":
        observed = cue["profile"]
        for r in range(win // 2, h - win // 2, step):
            for c in range(win // 2, w - win // 2, step):
                predicted = skyline_from_point(elev, (r, c), mpc, max_range_cells=min(40, win))
                score, rot = match_skyline_profile(observed, predicted)
                if score <= 0.0:
                    continue
                lon, lat = _rc_to_lonlat(r, c, geo)
                scored.append(
                    {
                        "lat": round(lat, 6), "lon": round(lon, 6),
                        "radius_m": cell_km * 1000.0 / 2.0,
                        "score": round(score, 3),
                        "sources": ["C3:skyline"],
                        "evidence": f"DEM skyline match score {score:.2f} at heading offset {rot:.0f} deg",
                    }
                )

    scored.sort(key=lambda c: c["score"], reverse=True)
    return scored[:max_candidates]


def _score_of(c: Any) -> float:
    return float(c.get("score", 0.0)) if isinstance(c, dict) else float(getattr(c, "score", 0.0))


def search(
    evidence: list[Any],
    priors: list[Any],
    *,
    top_priors: int = 2,
    cell_km: float = 1.0,
) -> list[Any]:
    """Call-site contract entrypoint for pipeline.py's Stage C3 (spec §5/§6):
    ``retrieval.terrain.search(evidence, priors) -> list[Candidate]``.

    Fans out :func:`retrieve_candidates` over every eligible evidence photo
    x the top `top_priors` geo-prior regions. In practice most calls are a
    no-op (most photos carry no usable terrain/horizon cue — see
    `_terrain_cue`); DEM fetches only happen for photos that DO carry one.
    """
    if not priors:
        log.info("Stage C3 search(): no geo_prior regions supplied — nothing to scan, returning [].")
        return []
    ranked = sorted(priors, key=lambda p: (p.get("p", 0.0) if isinstance(p, dict) else getattr(p, "p", 0.0)), reverse=True)[:top_priors]
    out: list[Any] = []
    for ev in evidence:
        for prior in ranked:
            bbox_val = prior.get("bbox") if isinstance(prior, dict) else getattr(prior, "bbox", None)
            if not bbox_val or len(bbox_val) != 4:
                continue
            candidates, meta = retrieve_candidates(ev, tuple(bbox_val), cell_km=cell_km)
            region = prior.get("region") if isinstance(prior, dict) else getattr(prior, "region", "?")
            photo = ev.get("photo") if isinstance(ev, dict) else getattr(ev, "photo", "?")
            log.info("Stage C3 search(): %s x region=%s -> %s", photo, region, meta.get("note"))
            out.extend(candidates)
    out.sort(key=_score_of, reverse=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bbox", type=float, nargs=4, metavar=("W", "S", "E", "N"), required=True)
    ap.add_argument("--evidence", type=Path, required=True, help="evidence/{photo}.json")
    ap.add_argument("-o", "--out", type=Path, default=Path("candidates.json"))
    ap.add_argument("--cell-km", type=float, default=1.0)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    evidence = json.loads(args.evidence.read_text(encoding="utf-8"))
    candidates, meta = retrieve_candidates(evidence, tuple(args.bbox), cell_km=args.cell_km)

    print(json.dumps(meta, indent=2, default=str))
    if dump_candidates is not None:
        dump_candidates(candidates, args.out)
    else:  # pragma: no cover
        args.out.write_text(json.dumps(candidates, indent=2), encoding="utf-8")
    print(f"wrote {len(candidates)} candidate(s) -> {args.out}")


if __name__ == "__main__":
    main()
