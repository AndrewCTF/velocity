"""Stage A -- forensics & scene understanding (spec §2 Stage A).

Runs per photo, keyless and fully offline:
  - EXIF extraction (GPS / timestamp / camera / orientation / focal length) via
    stdlib Pillow only (no piexif -- not installed in apps/api/.venv, and
    Pillow's ``Image.getexif()`` + ``get_ifd()`` already parse the GPS IFD).
  - a perceptual hash (dHash, hand-rolled with Pillow+numpy -- no new deps) and
    near-duplicate grouping across a photo set, so a burst from one spot isn't
    over-counted downstream.
  - classical (non-model) scene features -> a heuristic ``scene_type``.
  - a pluggable, OFF-by-default VLM captioning hook.

Emits ``evidence/{photo}.json`` (spec §4) -- the only contract downstream
stages read from this stage.
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .contracts import Attributes, Evidence, ExifData, GpsCoord, SceneType

# --------------------------------------------------------------------------- #
# Perceptual hash + near-duplicate grouping
# --------------------------------------------------------------------------- #


def compute_phash(path: str | Path, hash_size: int = 8) -> str:
    """dHash (difference hash): downscale to grayscale (hash_size+1) x hash_size,
    bit[i] = 1 iff pixel[i] > pixel[i+1] along each row. Robust to resizing,
    recompression and minor crop -- exactly the kind of variation a burst of
    photos of the same spot has, unlike a cryptographic hash. Returns a hex
    string (``hash_size**2`` bits, 8 -> 16 hex chars)."""
    im = Image.open(path).convert("L").resize((hash_size + 1, hash_size), Image.Resampling.LANCZOS)
    arr = np.asarray(im, dtype=np.int16)
    bits = (arr[:, 1:] > arr[:, :-1]).flatten()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    nbits = hash_size * hash_size
    return format(value, f"0{(nbits + 3) // 4}x")


def hamming_distance(hash_a: str, hash_b: str) -> int:
    """Bit-differences between two same-size hex phashes."""
    return bin(int(hash_a, 16) ^ int(hash_b, 16)).count("1")


# Default near-dup threshold: 10 bits of 64 (~15.6%). Calibrated against the
# repo's test_images/ set: exact-duplicate pairs land at distance 0, a genuine
# near-duplicate burst (same subject, camera moved a step) lands at ~6-10,
# and unrelated photos of the same forest land at >=25. See test_forensics.py.
DEFAULT_DEDUP_THRESHOLD = 10


def group_near_duplicates(hashes: dict[str, str], threshold: int = DEFAULT_DEDUP_THRESHOLD) -> list[list[str]]:
    """Union-find clustering of photo keys whose phash Hamming distance is
    <= ``threshold``. Returns clusters (each a sorted list of keys, including
    singletons), ordered deterministically by each cluster's smallest key."""
    keys = list(hashes.keys())
    parent = {k: k for k in keys}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            if hamming_distance(hashes[keys[i]], hashes[keys[j]]) <= threshold:
                union(keys[i], keys[j])

    clusters: dict[str, list[str]] = {}
    for k in keys:
        clusters.setdefault(find(k), []).append(k)
    return sorted((sorted(v) for v in clusters.values()), key=lambda g: g[0])


# --------------------------------------------------------------------------- #
# EXIF / XMP
# --------------------------------------------------------------------------- #

# Standard EXIF GPS IFD tag ids (not exposed on PIL.ExifTags.Base -- those live
# under the separate ExifTags.GPS enum keyed by these same integers).
_GPS_LAT_REF, _GPS_LAT, _GPS_LON_REF, _GPS_LON = 1, 2, 3, 4
_GPS_ALT_REF, _GPS_ALT = 5, 6


def _dms_to_decimal(dms: Any, ref: Any) -> float | None:
    try:
        d, m, s = (float(x) for x in dms)
    except (TypeError, ValueError):
        return None
    dd = d + m / 60.0 + s / 3600.0
    if ref in ("S", "W"):
        dd = -dd
    return dd


def _parse_gps_ifd(gps_ifd: dict[int, Any] | None) -> GpsCoord | None:
    if not gps_ifd:
        return None
    lat = _dms_to_decimal(gps_ifd.get(_GPS_LAT), gps_ifd.get(_GPS_LAT_REF))
    lon = _dms_to_decimal(gps_ifd.get(_GPS_LON), gps_ifd.get(_GPS_LON_REF))
    if lat is None or lon is None:
        return None
    alt_m: float | None = None
    raw_alt = gps_ifd.get(_GPS_ALT)
    if raw_alt is not None:
        try:
            alt_m = float(raw_alt)
        except (TypeError, ValueError):
            alt_m = None
        if alt_m is not None:
            ref_raw = gps_ifd.get(_GPS_ALT_REF)
            ref_byte = ref_raw[0] if isinstance(ref_raw, (bytes, bytearray)) and ref_raw else ref_raw
            if ref_byte == 1:  # 1 == below sea level
                alt_m = -alt_m
    return GpsCoord(lat=lat, lon=lon, alt_m=alt_m)


def extract_exif(path: str | Path) -> ExifData:
    """Best-effort EXIF read. Never raises -- a photo with stripped/absent/
    malformed EXIF (the repo's test_images/ set) yields an all-``None`` ExifData,
    not an exception, so Stage A always emits an evidence file."""
    from PIL import ExifTags

    try:
        with Image.open(path) as im:
            exif = im.getexif()
            if not exif:
                return ExifData()

            make = exif.get(ExifTags.Base.Make)
            model = exif.get(ExifTags.Base.Model)
            camera = " ".join(str(p).strip() for p in (make, model) if p) or None
            orientation = exif.get(ExifTags.Base.Orientation)
            ts = exif.get(ExifTags.Base.DateTime)

            focal: float | None = None
            try:
                exif_ifd = exif.get_ifd(ExifTags.IFD.Exif)
                if not ts:
                    ts = exif_ifd.get(ExifTags.Base.DateTimeOriginal)
                raw_focal = exif_ifd.get(ExifTags.Base.FocalLength)
                if raw_focal is not None:
                    focal = float(raw_focal)
            except Exception:
                pass

            gps: GpsCoord | None = None
            try:
                gps_ifd = exif.get_ifd(ExifTags.Base.GPSInfo)
                gps = _parse_gps_ifd(gps_ifd)
            except Exception:
                gps = None

            return ExifData(gps=gps, ts=ts, camera=camera, orientation=orientation, focal_length_mm=focal)
    except Exception:
        return ExifData()


# --------------------------------------------------------------------------- #
# Classical scene features -> heuristic scene_type
# --------------------------------------------------------------------------- #


def _load_thumbnail_arrays(path: str | Path, max_side: int = 256) -> tuple[np.ndarray, np.ndarray]:
    """Return (uint8 RGB array, float64 RGB array in 0..1), downscaled so the
    stats below are cheap on full-resolution camera photos (the accuracy of a
    scene-openness/green-fraction estimate does not need full resolution)."""
    im = Image.open(path).convert("RGB")
    im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    arr_u8 = np.asarray(im, dtype=np.uint8)
    return arr_u8, arr_u8.astype(np.float64) / 255.0


def _dominant_colors(arr_u8: np.ndarray, k: int = 3, bins: int = 4) -> list[str]:
    """Coarse dominant-colour swatches: quantise each channel to ``bins``
    levels, histogram in that reduced space, return the top-k bin centres as
    hex. A real palette clusterer (k-means) is unnecessary heavy machinery for
    "what are the 2-3 big colour masses in this photo"."""
    step = 256 // bins
    q = (arr_u8 // step).astype(np.int32)
    flat = (q[..., 0] * bins * bins + q[..., 1] * bins + q[..., 2]).reshape(-1)
    values, counts = np.unique(flat, return_counts=True)
    order = np.argsort(-counts)[:k]
    colors = []
    for idx in order:
        v = int(values[idx])
        r = (v // (bins * bins)) % bins
        g = (v // bins) % bins
        b = v % bins
        center = lambda c: int((c + 0.5) * step)  # noqa: E731
        colors.append(f"#{center(r):02x}{center(g):02x}{center(b):02x}")
    return colors


def compute_scene_features(path: str | Path) -> dict[str, Any]:
    """Classical (no-model) scene features: colour stats, green fraction, a
    sky/canopy-openness proxy, edge density and dominant colours.

    ``openness_score`` is the load-bearing signal for scene_type: mean +
    stddev of luminance in the *upper half* of the frame. Physical reasoning:
    - Deep under a closed canopy, the upper half is uniformly dim (light is
      scattered/absorbed by leaves from every direction) -> LOW mean, LOW std.
    - Any scene with a real gap to the sky (a clearing, a yard beside a
      building, open pasture beyond a hedgerow) has a BRIGHT patch next to a
      darker one in the upper half (branch silhouette against sky, roofline
      against sky, treeline against open field) -> mean and/or std rise. Using
      mean+std together (rather than mean alone) is what lets a photo with a
      tree branch overhanging the very top of frame but an open yard below
      (the barn shot in this repo's test set) still register as open: the
      overhang lowers the mean but the sky patch beside it raises the std.
    Upper HALF (not just the top strip) is used so a wide low branch overhang
    doesn't dominate the estimate.
    """
    arr_u8, arr_f = _load_thumbnail_arrays(path)
    h, w, _ = arr_f.shape

    r, g, b = arr_f[..., 0], arr_f[..., 1], arr_f[..., 2]
    green_mask = (g > r * 1.05) & (g > b * 1.05)
    green_frac = float(green_mask.mean())

    upper = arr_f[: max(1, h // 2), :, :]
    upper_lum = upper.mean(axis=2)
    sky_open_mean = float(upper_lum.mean())
    sky_open_std = float(upper_lum.std())
    openness_score = sky_open_mean + sky_open_std

    gray = arr_f.mean(axis=2)
    gx = np.abs(np.diff(gray, axis=1))
    gy = np.abs(np.diff(gray, axis=0))
    edge_density = float((gx.mean() + gy.mean()) / 2.0)

    return {
        "mean_rgb": tuple(float(x) for x in arr_f.mean(axis=(0, 1))),
        "std_rgb": tuple(float(x) for x in arr_f.std(axis=(0, 1))),
        "green_frac": green_frac,
        "sky_open_mean": sky_open_mean,
        "sky_open_std": sky_open_std,
        "openness_score": openness_score,
        "edge_density": edge_density,
        "dominant_colors": _dominant_colors(arr_u8),
    }


# Thresholds tuned against the physical reasoning in compute_scene_features'
# docstring and validated on the repo's test_images/ set (6 unique scenes: 3
# dense chicken-in-tree canopy shots, a forest path, a fenced woodland
# clearing, a pasture, and a barn yard -- see tests/test_forensics.py and the
# CLI proof run). They are deliberately generic (no colour/texture value tied
# to a specific place), just physically-reasoned cutoffs on the features above.
_OPENNESS_CANOPY_MAX = 0.50  # below: little/no bright sky gap overhead
_OPENNESS_OPEN_MIN = 0.65  # at/above: a large open area or sky is visible
_GREEN_MIN_FOR_CANOPY = 0.15  # canopy interior must also be foliage-dominated
_INDOOR_GREEN_MAX = 0.08  # indoor scenes have ~no outdoor vegetation
_INDOOR_EDGE_MAX = 0.035  # and much less texture than any outdoor scene
_INDOOR_OPENNESS_MAX = 0.50  # and no bright sky patch


def classify_scene_type(features: dict[str, Any]) -> tuple[SceneType, str]:
    """Heuristic scene_type from :func:`compute_scene_features` output. Returns
    (scene_type, human-readable rationale) -- the rationale is folded into the
    evidence's ``confidence_notes`` so the classification is auditable, never a
    silent number."""
    openness = features["openness_score"]
    green = features["green_frac"]
    edge = features["edge_density"]

    if openness < _OPENNESS_CANOPY_MAX and green >= _GREEN_MIN_FOR_CANOPY:
        return (
            SceneType.CANOPY_INTERIOR,
            f"openness={openness:.2f}<{_OPENNESS_CANOPY_MAX} (dim upper-frame, no sky gap) "
            f"and green_frac={green:.2f}>={_GREEN_MIN_FOR_CANOPY} (foliage-dominated) "
            "-> enclosed under tree canopy.",
        )
    if green < _INDOOR_GREEN_MAX and edge < _INDOOR_EDGE_MAX and openness < _INDOOR_OPENNESS_MAX:
        return (
            SceneType.INDOOR,
            f"green_frac={green:.2f}<{_INDOOR_GREEN_MAX}, edge_density={edge:.3f}<{_INDOOR_EDGE_MAX}, "
            f"openness={openness:.2f}<{_INDOOR_OPENNESS_MAX} (no vegetation, low texture, no sky) "
            "-> likely indoor.",
        )
    if openness >= _OPENNESS_OPEN_MIN:
        return (
            SceneType.OPEN,
            f"openness={openness:.2f}>={_OPENNESS_OPEN_MIN} (bright/high-contrast upper frame) "
            "-> wide sightline, sky or open ground visible.",
        )
    return (
        SceneType.SEMI_OPEN,
        f"openness={openness:.2f} between {_OPENNESS_CANOPY_MAX} and {_OPENNESS_OPEN_MIN} "
        "-> partial occlusion with an open area beyond it.",
    )


def _heuristic_biome(scene_type: SceneType, green_frac: float) -> str | None:
    """Best-effort, explicitly-heuristic biome guess from classical features
    only (no species/land-use model in this build's scope)."""
    if scene_type == SceneType.CANOPY_INTERIOR:
        return "forest"
    if scene_type in (SceneType.OPEN, SceneType.SEMI_OPEN) and green_frac > 0.5:
        return "vegetated_open"  # grassland / farmland / parkland -- underdetermined here
    return None


# --------------------------------------------------------------------------- #
# Pluggable VLM hook (spec §2 Stage A, §3) -- OFF by default, no hard dep
# --------------------------------------------------------------------------- #


def caption_via_vlm(path: str | Path) -> dict[str, Any] | None:
    """Optional VLM captioning hook. Returns ``None`` whenever no model is
    configured, which is the default -- Stage A stays keyless/offline
    (repo invariant) with zero import-time dependency on ollama or any other
    VLM client.

    Opt in by setting ``GEOLOCATE_VLM_MODEL`` (mirrors the repo's existing
    ``OLLAMA_MODEL_*`` local-inference toggle) to a model name served by a
    local Ollama daemon (``OLLAMA_HOST``, default ``http://localhost:11434``).
    On any failure (daemon not running, model missing, timeout) this returns
    ``None`` rather than raising -- a photo must never fail Stage A because an
    optional caption step is unavailable.

    Contract: return ``None`` (skip) or a dict with at least a ``"caption"``
    key (str) and optionally an ``"attributes"`` key (a partial
    ``Attributes``-shaped dict) for :func:`run_stage_a` to merge in.
    """
    model = os.environ.get("GEOLOCATE_VLM_MODEL")
    if not model:
        return None

    import json as _json
    import urllib.request
    from base64 import b64encode

    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    prompt = (
        "Describe this outdoor/indoor photo for geolocation forensics in one or two "
        "sentences: biome, architecture/material, vegetation, signage text, and any "
        "other geographically distinctive detail. Be concise and concrete."
    )
    try:
        with open(path, "rb") as fh:
            img_b64 = b64encode(fh.read()).decode("ascii")
        payload = _json.dumps(
            {"model": model, "prompt": prompt, "images": [img_b64], "stream": False}
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{host.rstrip('/')}/api/generate", data=payload, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = _json.loads(resp.read().decode("utf-8"))
        caption = (data.get("response") or "").strip()
        if not caption:
            return None
        return {"caption": caption, "attributes": {}}
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# Per-photo / batch orchestration
# --------------------------------------------------------------------------- #


def run_stage_a(
    path: str | Path,
    *,
    use_vlm: bool = False,
    dedup_note: str = "",
    attributes_overrides: dict[str, dict[str, Any]] | None = None,
) -> Evidence:
    """Run Stage A on one photo: EXIF + phash + classical features/scene_type
    + (optional) VLM caption. Never raises on a malformed/EXIF-stripped image
    -- every input yields an Evidence record.

    ``attributes_overrides``: an optional ``{photo_filename: {"caption": ...,
    "attributes": {...}}}`` map (§4 ``Attributes`` shape) -- INJECTABLE
    semantic attributes from any vision model (or an analyst), keyed by
    ``Path(path).name`` exactly like ``Evidence.photo``. This build's
    classical heuristics cannot fill architecture/vegetation/husbandry/etc.
    (spec §2 Stage A) without a VLM; this lets a caller supply that VLM's (or
    any vision model's, or a human analyst's) output without requiring a live
    model call in-process -- e.g. ``pipeline.py``'s ``--attributes-json``.
    Composes with ``use_vlm``: both merge into the same ``Attributes`` dict
    via the same flat-merge path (last writer wins per top-level key), with
    the override applied LAST so it takes precedence over both the heuristic
    biome guess and a live VLM result. Missing/absent for a given photo is a
    silent no-op -- never breaks a run.
    """
    path = Path(path)
    phash = compute_phash(path)
    exif = extract_exif(path)
    features = compute_scene_features(path)
    scene_type, rationale = classify_scene_type(features)
    biome = _heuristic_biome(scene_type, features["green_frac"])

    caption: str | None = None
    merged_attrs: dict[str, Any] = {"biome": biome}
    vlm_ran = False
    if use_vlm:
        result = caption_via_vlm(path)
        vlm_ran = result is not None
        if result:
            caption = result.get("caption")
            merged_attrs.update(dict(result.get("attributes") or {}))

    override = (attributes_overrides or {}).get(path.name)
    override_used = bool(override)
    if override:
        if override.get("caption"):
            caption = override["caption"]
        merged_attrs.update(dict(override.get("attributes") or {}))

    attributes = Attributes.from_dict(merged_attrs)

    notes = (
        f"scene_type heuristic: {rationale} "
        f"[green_frac={features['green_frac']:.2f}, openness={features['openness_score']:.2f}, "
        f"edge_density={features['edge_density']:.3f}]."
    )
    if exif.gps is not None:
        notes += " EXIF GPS present -> Stage E can short-circuit with a proven tag."
    else:
        notes += " No EXIF GPS (stripped or never present)."
    notes += " VLM caption used." if vlm_ran else " No VLM caption (keyless/offline run)."
    if override_used:
        notes += " Attributes overridden by injected vision-model/analyst input (attributes_overrides)."
    if dedup_note:
        notes += f" {dedup_note}"

    return Evidence(
        photo=path.name,
        phash=phash,
        exif=exif,
        scene_type=scene_type,
        caption=caption,
        attributes=attributes,
        confidence_notes=notes,
    )


IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp")


def run_stage_a_batch(
    paths: Iterable[str | Path],
    *,
    use_vlm: bool = False,
    dedup_threshold: int = DEFAULT_DEDUP_THRESHOLD,
    attributes_overrides: dict[str, dict[str, Any]] | None = None,
) -> tuple[list[Evidence], list[list[str]]]:
    """Run Stage A on every photo, then group near-duplicates across the whole
    set (spec: "near-duplicate grouping across a photo set"). Returns
    (evidence list, dedup groups) where each group is a sorted list of
    filenames sharing a phash cluster (including singletons).

    ``attributes_overrides`` is forwarded to :func:`run_stage_a` unchanged --
    see its docstring. Keyed by filename, so it applies per-photo across the
    whole batch regardless of dedup grouping.
    """
    path_list = [Path(p) for p in paths]
    evidences = [
        run_stage_a(p, use_vlm=use_vlm, attributes_overrides=attributes_overrides) for p in path_list
    ]
    hashes = {e.photo: e.phash for e in evidences}
    groups = group_near_duplicates(hashes, threshold=dedup_threshold)
    return evidences, groups
