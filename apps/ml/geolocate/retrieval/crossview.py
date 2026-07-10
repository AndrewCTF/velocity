#!/usr/bin/env python3
"""Stage C1 — cross-view / reference-photo retrieval by CLIP embedding.

Embeds the query ground photo and a set of georeferenced reference images
(street-level photos from Panoramax/KartaView via reference_photos.py, and/or VHR
basemap tiles the caller supplies) with CLIP, then ranks references by cosine
similarity (sklearn NearestNeighbors, cosine metric — no faiss). Emits the top-K
as `candidates.json` entries per pipeline doc §4:
    {lat, lon, radius_m, score, sources, evidence}

HONEST OOD CAVEAT (doc §0.3): the released cross-view / CLIP-style models are
trained on urban/road panoramas and web imagery. A rural forest-interior query is
out-of-distribution, so the cosine is a *ranker of candidates*, not a calibrated
P(location). We surface an `ood` flag + a low-margin warning in every candidate's
notes and deliberately keep `score` a relative retrieval score, never a
localisation probability. This is plumbing that returns ranked candidates; it does
NOT claim to correctly localise a woodland shot.

Runs KEYLESS in the CUDA sidecar venv `~/.venv` (transformers CLIP + sklearn +
torch). The task's spec: no open_clip / no faiss → CLIP via transformers, kNN via
sklearn.

Usage:
  # fetch references live + rank:
  python crossview.py --query photo.png --lat 43.61 --lon 1.45 --radius-km 0.5 \
      --out candidates.json --cache /tmp/refs --top-k 5
  # or rank against a prebuilt reference manifest (reference_photos.py --out):
  python crossview.py --query photo.png --refs-json refs.json --out candidates.json

Emits the canonical geolocate.contracts.Candidate schema (§4) when importable.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference_photos as rp  # noqa: E402

log = logging.getLogger("geolocate.retrieval.crossview")

# Canonical §4 candidate schema (lat/lon/radius_m/score/sources/evidence). Guarded
# so the module still runs if contracts.py isn't importable; extras below are added
# on top and are ignored by Candidate.from_dict.
try:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    from geolocate.contracts import Candidate as _Candidate  # noqa: E402
except Exception:
    _Candidate = None

_MODEL = "openai/clip-vit-base-patch32"
_clip = {"model": None, "proc": None, "device": None}


def _load_clip():
    if _clip["model"] is None:
        import torch
        from transformers import CLIPModel, CLIPProcessor
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        _clip["model"] = CLIPModel.from_pretrained(_MODEL).to(dev).eval()
        _clip["proc"] = CLIPProcessor.from_pretrained(_MODEL, use_fast=True)
        _clip["device"] = dev
    return _clip["model"], _clip["proc"], _clip["device"]


def embed_images(paths: list[str], batch: int = 16) -> np.ndarray:
    """CLIP image embeddings, L2-normalised, shape (N, 512). Skips unreadable files
    (returns a zero row so indices stay aligned with `paths`)."""
    import torch
    from PIL import Image
    model, proc, dev = _load_clip()
    feats: list[np.ndarray] = []
    for i in range(0, len(paths), batch):
        chunk = paths[i:i + batch]
        imgs, ok = [], []
        for p in chunk:
            try:
                imgs.append(Image.open(p).convert("RGB"))
                ok.append(True)
            except Exception:
                ok.append(False)
        out = np.zeros((len(chunk), 512), np.float32)
        if imgs:
            with torch.no_grad():
                inp = proc(images=imgs, return_tensors="pt").to(dev)
                f = model.get_image_features(**inp)
                # transformers 5.x returns a BaseModelOutputWithPooling; the 512-d
                # CLIP joint-space embedding is .pooler_output (older versions return
                # the tensor directly).
                if not isinstance(f, torch.Tensor):
                    f = getattr(f, "pooler_output", None)
                    if f is None:
                        f = getattr(f, "image_embeds")
                f = torch.nn.functional.normalize(f, dim=-1).cpu().numpy().astype(np.float32)
            j = 0
            for k, good in enumerate(ok):
                if good:
                    out[k] = f[j]
                    j += 1
        feats.append(out)
    return np.concatenate(feats, 0) if feats else np.zeros((0, 512), np.float32)


def _candidate(ref: rp.ReferencePhoto, cosine: float, score: float, rank: int,
               ood: bool, margin: float, radius_m: float) -> dict:
    """One candidates.json entry (doc §4 schema + honest extras)."""
    ood_note = (" OOD-WARNING: query appears out-of-distribution for street-view-"
                "trained retrieval (low top-1 margin); treat as weak ranker only."
                if ood else "")
    evidence = (f"CLIP cross-view match to {ref.source} photo {ref.id} "
                f"(cosine={cosine:.3f}, rank #{rank + 1})."
                + (f" heading={ref.heading:.0f}deg." if ref.heading is not None else "")
                + ood_note)
    sources = [f"C1:{ref.source}"]
    radius_m = round(radius_m, 1)
    score = round(float(score), 4)
    # canonical §4 fields via the shared contract (falls back to a literal dict).
    if _Candidate is not None:
        base = _Candidate(lat=ref.lat, lon=ref.lon, radius_m=radius_m, score=score,
                          sources=sources, evidence=evidence).to_dict()
    else:
        base = {"lat": ref.lat, "lon": ref.lon, "radius_m": radius_m, "score": score,
                "sources": sources, "evidence": evidence}
    return {
        **base,
        # ---- honest extras (not in §4; ignored by strict consumers) ----
        "cosine": round(float(cosine), 4),
        "rank": rank,
        "ref_id": ref.id,
        "captured_at": ref.captured_at,
        "ood": bool(ood),
        "ood_margin": round(float(margin), 4),
    }


def crossview_rank(query_path: str, references: list[rp.ReferencePhoto],
                   top_k: int = 5) -> dict:
    """Embed query + references, rank by cosine (sklearn NearestNeighbors), return
    a candidates.json-shaped payload with an honest OOD assessment."""
    from sklearn.neighbors import NearestNeighbors

    refs = [r for r in references if r.local_path and os.path.exists(r.local_path)]
    if not refs:
        return {"candidates": [], "note": "no reference photos with local pixels to match against",
                "n_refs": 0, "ood": True}

    ref_emb = embed_images([r.local_path for r in refs])
    q_emb = embed_images([query_path])
    # drop reference rows that failed to embed (all-zero)
    keep = np.linalg.norm(ref_emb, axis=1) > 1e-6
    refs = [r for r, k in zip(refs, keep) if k]
    ref_emb = ref_emb[keep]
    if len(refs) == 0 or np.linalg.norm(q_emb[0]) < 1e-6:
        return {"candidates": [], "note": "query or all references failed to embed",
                "n_refs": 0, "ood": True}

    nn = NearestNeighbors(n_neighbors=min(top_k, len(refs)), metric="cosine")
    nn.fit(ref_emb)
    dist, idx = nn.kneighbors(q_emb[:1])  # cosine distance = 1 - cosine sim
    dist, idx = dist[0], idx[0]
    cos = 1.0 - dist

    # OOD / ambiguity assessment: how far the top match stands above the field.
    all_cos = ref_emb @ q_emb[0]
    mean_cos = float(all_cos.mean())
    top1 = float(cos[0])
    margin = top1 - mean_cos
    # rural/forest OOD signature: weak absolute match AND a flat similarity field.
    ood = (top1 < 0.75) or (margin < 0.06)

    # Relative retrieval score in (0,1]: softmax over the returned neighbours'
    # cosines (temperature 0.05). Explicitly a RANK score, not P(location).
    z = cos / 0.05
    z = z - z.max()
    soft = np.exp(z)
    soft = soft / soft.sum()

    radius_km = _spread_km(refs)
    cands = [
        _candidate(refs[int(i)], float(c), float(s), rank, ood, margin,
                   radius_m=max(150.0, radius_km * 1000))
        for rank, (i, c, s) in enumerate(zip(idx, cos, soft))
    ]
    note = ("CLIP cross-view retrieval over street-level references. "
            f"top1_cosine={top1:.3f}, margin_over_mean={margin:.3f}. ")
    note += ("HONEST: query looks OUT-OF-DISTRIBUTION for street-view-trained "
             "retrieval (weak/flat similarity) — these candidates are a weak ranker, "
             "NOT a localisation claim." if ood else
             "In-distribution-ish match; still fuse with other stages before pinning.")
    return {"candidates": cands, "note": note, "n_refs": len(refs),
            "top1_cosine": round(top1, 4), "mean_cosine": round(mean_cos, 4),
            "ood": bool(ood), "model": _MODEL}


def _spread_km(refs: list[rp.ReferencePhoto]) -> float:
    """Rough radius of the reference cluster (km) — used as candidate radius."""
    import math
    if len(refs) < 2:
        return 0.3
    lat0 = sum(r.lat for r in refs) / len(refs)
    lon0 = sum(r.lon for r in refs) / len(refs)
    cos = max(0.2, abs(math.cos(math.radians(lat0))))
    d = [math.hypot((r.lat - lat0) * 111.32, (r.lon - lon0) * 111.32 * cos) for r in refs]
    return max(0.15, float(np.percentile(d, 75)))


# --------------------------------------------------------------------------- #
# search() — call-site contract entrypoint for pipeline.py's Stage C1
# (doc §5/§6): ``retrieval.crossview.search(evidence, priors) -> list[Candidate]``
# --------------------------------------------------------------------------- #

_DEFAULT_TOP_PRIORS = 2
_DEFAULT_REFS_PER_PRIOR = 12
# Stage B's prior bbox is typically country-scale (spec §2 Stage B); unlike
# osm.py (which queries the whole bbox with a span cap) reference_photos.
# fetch_reference_photos takes a point + radius, not a bbox. Probing a SMALL
# radius around the bbox centroid is an honest, bounded first cut that keeps
# every live call (and its per-reference downloads) fast — tiling the whole
# bbox is future work, not a silent narrowing (logged in the per-call note).
_MAX_QUERY_RADIUS_KM = 5.0
_SEARCH_BUDGET_S = 60.0  # soft wall-clock cap across all photo x prior fetches
_DEFAULT_REFS_CACHE = "/tmp/geolocate_refs"


def _bbox_center(bbox: tuple[float, float, float, float]) -> tuple[float, float]:
    """(west, south, east, north) -> (lat, lon) centroid."""
    w, s, e, n = bbox
    return (s + n) / 2.0, (w + e) / 2.0


def _resolve_query_path(photo_name: str, image_dirs: list[str | Path] | None) -> Path | None:
    """``contracts.Evidence.photo`` is set from ``Path(original_path).name``
    (forensics.run_stage_a) — the §4 evidence contract does not carry the
    photo's original directory, so pipeline.py's router hands `search()`
    only a filename. Try the caller-supplied `image_dirs`, a
    ``GEOLOC_IMAGE_DIR`` env override (``os.pathsep``-separated, mirrors
    PATH-style env vars), then the obvious repo convention (CWD and
    CWD/test_images/) — first hit wins. Returns None (never raises) if the
    photo isn't found anywhere; the caller treats that as a graceful
    per-photo skip, never a pipeline crash.
    """
    candidates: list[Path] = [Path(d) for d in (image_dirs or [])]
    env_dirs = os.environ.get("GEOLOC_IMAGE_DIR", "")
    candidates.extend(Path(d) for d in env_dirs.split(os.pathsep) if d)
    candidates.append(Path.cwd())
    candidates.append(Path.cwd() / "test_images")
    for d in candidates:
        p = d / photo_name
        if p.is_file():
            return p
    return None


def _attr(obj: Any, key: str, default: Any = None) -> Any:
    return obj.get(key, default) if isinstance(obj, dict) else getattr(obj, key, default)


def _score_of(c: Any) -> float:
    return float(_attr(c, "score", 0.0))


def search(
    evidence: list[Any],
    priors: list[Any],
    *,
    top_priors: int = _DEFAULT_TOP_PRIORS,
    refs_per_prior: int = _DEFAULT_REFS_PER_PRIOR,
    radius_km: float = _MAX_QUERY_RADIUS_KM,
    top_k: int = 5,
    cache_dir: str | Path = _DEFAULT_REFS_CACHE,
    image_dirs: list[str | Path] | None = None,
) -> list[Any]:
    """Call-site contract entrypoint for pipeline.py's Stage C1 (doc §5/§6):
    ``retrieval.crossview.search(evidence, priors) -> list[Candidate]``.

    For each evidence photo (the router already filters to OPEN/SEMI_OPEN —
    canopy-interior/indoor never reach here, see pipeline.route_scene / doc
    §0.2), fetches a small, capped set of georeferenced street-level
    reference photos (keyless Panoramax/KartaView via
    ``reference_photos.fetch_reference_photos``) around each of the top
    `top_priors` geo-prior bbox centroids, then ranks them against the query
    photo with :func:`crossview_rank` (CLIP cosine) — reusing that function
    and :func:`_candidate` unchanged (this is plumbing, not new CLIP logic).

    Degrades to ``[]`` with a logged reason — NEVER raises into the pipeline
    — on any of: no priors, no evidence, a query photo whose original path
    isn't resolvable from Evidence alone (§4 only carries the filename, see
    :func:`_resolve_query_path`), a reference-photo fetch failure or empty
    result, or the CLIP backend not being importable in this venv (Stage C1
    needs the CUDA sidecar venv ``~/.venv`` per doc §3 — apps/api/.venv has
    no torch/transformers/sklearn, so :func:`crossview_rank` raises
    ``ModuleNotFoundError`` there; that is caught here, not a crash).
    """
    if not priors:
        log.info("Stage C1 search(): no geo_prior regions supplied — nothing to query, returning [].")
        return []
    if not evidence:
        return []

    ranked_priors = sorted(priors, key=lambda p: _attr(p, "p", 0.0), reverse=True)[:top_priors]

    out: list[Any] = []
    t_start = time.monotonic()
    for ev in evidence:
        photo = _attr(ev, "photo")
        if not photo:
            continue
        query_path = _resolve_query_path(photo, image_dirs)
        if query_path is None:
            log.info(
                "Stage C1 search(): %s — query photo not found on disk in any candidate "
                "directory (Evidence only carries the filename, doc §4); skipping.",
                photo,
            )
            continue

        for prior in ranked_priors:
            if time.monotonic() - t_start > _SEARCH_BUDGET_S:
                log.info(
                    "Stage C1 search(): wall-clock budget (%.0fs) exhausted, stopping early.",
                    _SEARCH_BUDGET_S,
                )
                out.sort(key=_score_of, reverse=True)
                return out

            bbox_val = _attr(prior, "bbox")
            if not bbox_val or len(bbox_val) != 4:
                continue
            region = _attr(prior, "region", "?")
            lat, lon = _bbox_center(tuple(bbox_val))

            try:
                refs = rp.fetch_reference_photos(
                    lat, lon, radius_km, str(cache_dir), limit=refs_per_prior, download=True
                )
            except Exception as exc:  # noqa: BLE001 - any network/parsing failure degrades gracefully
                log.warning(
                    "Stage C1 search(): reference-photo fetch failed for %s x region=%s: %r",
                    photo, region, exc,
                )
                continue

            if not refs:
                log.info(
                    "Stage C1 search(): %s x region=%s -> 0 reference photos within %.1fkm of "
                    "bbox centroid, skipping rank.",
                    photo, region, radius_km,
                )
                continue

            try:
                result = crossview_rank(str(query_path), refs, top_k=top_k)
            except Exception as exc:  # noqa: BLE001 - e.g. torch/transformers/sklearn not installed
                log.warning(
                    "Stage C1 search(): CLIP ranking unavailable for %s x region=%s (%r) — Stage "
                    "C1 needs the CUDA sidecar venv (~/.venv) per doc §3, not apps/api/.venv; "
                    "skipping, not crashing.",
                    photo, region, exc,
                )
                continue

            cands = result.get("candidates", [])
            log.info(
                "Stage C1 search(): %s x region=%s -> %d ref(s), %d candidate(s) (%s)",
                photo, region, len(refs), len(cands), result.get("note", ""),
            )
            for row in cands:
                out.append(_Candidate.from_dict(row) if _Candidate is not None else row)

    out.sort(key=_score_of, reverse=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Stage C1 CLIP cross-view retrieval")
    ap.add_argument("--query", required=True)
    ap.add_argument("--out", help="write candidates.json here")
    ap.add_argument("--top-k", type=int, default=5)
    # live fetch mode
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--radius-km", type=float, default=0.5)
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--cache", default="/tmp/geolocate_refs")
    # prebuilt manifest mode
    ap.add_argument("--refs-json", help="reference_photos.py manifest instead of live fetch")
    a = ap.parse_args()

    if a.refs_json:
        with open(a.refs_json) as f:
            refs = [rp.ReferencePhoto(**d) for d in json.load(f)]
        print(f"loaded {len(refs)} references from {a.refs_json}", flush=True)
    else:
        if a.lat is None or a.lon is None:
            ap.error("need --lat/--lon (live fetch) or --refs-json")
        print(f"fetching references within {a.radius_km} km of ({a.lat},{a.lon}) ...", flush=True)
        refs = rp.fetch_reference_photos(a.lat, a.lon, a.radius_km, a.cache, a.limit, download=True)
        print(f"got {len(refs)} reference photos with pixels", flush=True)

    result = crossview_rank(a.query, refs, a.top_k)
    print(f"\nn_refs={result['n_refs']} ood={result.get('ood')} "
          f"top1_cosine={result.get('top1_cosine')}")
    print(result["note"])
    for c in result["candidates"]:
        print(f"  #{c['rank']+1} ({c['lat']:.5f},{c['lon']:.5f}) cos={c['cosine']} "
              f"score={c['score']} r={c['radius_m']}m  {c['sources']}")
    if a.out:
        # candidates.json per §4 is the list; we also stash the assessment alongside.
        with open(a.out, "w") as f:
            json.dump(result["candidates"], f, indent=2)
        with open(a.out.replace(".json", ".assessment.json"), "w") as f:
            json.dump({k: v for k, v in result.items() if k != "candidates"}, f, indent=2)
        print(f"\ncandidates -> {a.out}")


if __name__ == "__main__":
    main()
