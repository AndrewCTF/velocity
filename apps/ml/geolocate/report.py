"""Stage E — verification, calibrated confidence, and report generation.

Consumes whatever Stages A-D produced (``evidence.json`` per photo,
``geo_prior.json``, ``candidates.json``, and an optional ``pose`` dict — see
docs/photo-geolocation-pipeline.md §4) and turns it into:

  * ``verify_consistency``   — does the pipeline's own "one ~1 km disk" claim
    actually hold across the candidate AOIs it produced?
  * ``calibrate_confidence`` — one conservative, explained confidence number
    PER LEVEL (country / region / AOI / pose), never just a single score.
  * ``write_report``         — ``geo_assessment.md`` (human) + ``result.geojson``
    (globe-ready) built from the above, with a template that makes honesty
    STRUCTURAL: every report has a Verdict, an Evidence section with file
    refs, an Honest Limits section, and a Method-to-go-finer section, in that
    order, regardless of how good or bad the run was.
  * ``to_ontology``          — optional, best-effort writeback of a
    ``photo:<phash>`` object linked to a ``place:*`` object in the local
    ontology. Never touches the keyless critical path: if the ontology
    package isn't importable or a registry isn't supplied, it no-ops with a
    logged reason instead of raising.

``geolocate.contracts`` (``Evidence`` / ``GeoPrior`` / ``Candidate`` /
``SceneType``) landed alongside this module, so every public function below
accepts EITHER a contracts dataclass instance OR a plain dict matching
docs/photo-geolocation-pipeline.md §4 field names exactly — ``_as_dict``
prefers a ``.to_dict()`` method (contracts' wire-format) and falls back to
generic dataclass/attribute introspection. Note: §4 does not define a JSON
shape for Stage D's ``pose`` output, and ``pose/splat_pose.py``'s
``RegisterResult`` is scene-local (position/rotvec in the splat's own frame,
not yet geo-anchored) — this module's ``pose`` parameter therefore expects an
already-georeferenced ``{"lat", "lon", "heading_deg", "reproj_error_px",
"method"}`` dict as the minimal shape needed for a globe point + confidence.
# TODO: once Stage D's glue geo-anchors a ``RegisterResult`` into lat/lon,
# either add that conversion here or confirm it happens before ``pose`` is
# passed in.

Every number this module emits is deliberately conservative: capped well
short of 1.0, tagged ``proven`` / ``plumbed-unverified`` / ``heuristic``, and
accompanied by a rationale that names the evidence it used. See "Evidence
tags" below the imports for the exact meaning of each tag.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .contracts import SceneType

logger = logging.getLogger(__name__)

# ── constants ──────────────────────────────────────────────────────────────

EARTH_RADIUS_M = 6_371_000.0

# The pipeline's own coherence claim (doc §2 Stage E / §0): a real photo burst
# of one scene should cluster its candidate AOIs within about a kilometre.
DEFAULT_COHERENCE_RADIUS_M = 1000.0

# Majority-canopy gate for AOI/pose suppression (doc §0.2): nadir VHR cannot
# see under forest canopy, so once at least half the photos are
# canopy-interior, Stage C/D results — even a nonzero score — are not to be
# trusted at face value. This is a physics limit, not a modelling choice.
CANOPY_MAJORITY_THRESHOLD = 0.5

_DOC_REF = "docs/photo-geolocation-pipeline.md"

# Evidence tags (this module's OWN honesty label — describes how the
# CONFIDENCE NUMBER for a level was derived, not the raw upstream evidence):
#   "proven"             - EXIF GPS ground truth on the photo(s) behind this
#                           level (Stage A's short-circuit, doc §2A).
#   "plumbed-unverified"  - computed from a real upstream signal this run
#                           actually produced (a geo_prior / candidate / pose
#                           value) via a fixed, documented formula; the
#                           formula itself has not been checked against a
#                           labelled ground-truth set.
#   "heuristic"           - no usable upstream signal for this level (empty
#                           prior / no candidates / canopy-suppressed / no
#                           pose), so the number is a conservative rule-of-
#                           thumb fallback (near zero) rather than a
#                           measurement.
EVIDENCE_TAGS = ("proven", "plumbed-unverified", "heuristic")


# ── generic coercion helpers (contracts.py-tolerant) ─────────────────────────


def _as_dict(x: Any) -> dict[str, Any]:
    """Coerce a dict / contracts dataclass / pydantic model / plain object to
    a dict. Prefers a ``.to_dict()`` method (``geolocate.contracts``' stable
    wire format — enums become plain strings, nested dataclasses become
    nested dicts) before falling back to generic dataclass/attr
    introspection, so this module works against both typed ``Evidence`` /
    ``GeoPrior`` / ``Candidate`` instances and raw §4 JSON dicts.
    """
    if x is None:
        return {}
    if isinstance(x, dict):
        return x
    to_dict = getattr(x, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    if dataclasses.is_dataclass(x) and not isinstance(x, type):
        return dataclasses.asdict(x)
    if hasattr(x, "model_dump"):  # pydantic v2
        return x.model_dump()
    if hasattr(x, "__dict__"):
        return dict(vars(x))
    raise TypeError(f"cannot coerce {type(x)!r} into a dict for Stage E")


def _as_dicts(xs: Iterable[Any] | None) -> list[dict[str, Any]]:
    return [_as_dict(x) for x in (xs or [])]


def _num(x: Any, default: float = 0.0) -> float:
    try:
        if x is None:
            return default
        return float(x)
    except (TypeError, ValueError):
        return default


def _clip01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _pct(x: float) -> str:
    return f"{_clip01(x) * 100:.0f}%"


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return slug or "unknown"


# ── geo helpers ────────────────────────────────────────────────────────────


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres. Fine at the ~1-10 km scale this
    module operates at; no ellipsoid correction needed."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


# ── verify_consistency ────────────────────────────────────────────────────


def verify_consistency(
    candidates: Iterable[Any] | None,
    *,
    coherence_radius_m: float = DEFAULT_COHERENCE_RADIUS_M,
) -> dict[str, Any]:
    """Check the pipeline's own coherence claim: do the top candidate AOIs
    fall within one ``coherence_radius_m`` disk (default ~1 km, doc §2 Stage
    E / §0)?

    ``candidates`` follows the ``candidates.json`` contract (doc §4):
    ``[{"lat", "lon", "radius_m", "score", "sources", "evidence"}, ...]``.
    If any candidate additionally carries a ``"photo"`` key (which photo it
    was derived from), the literal reading of the spec is used: group by
    photo, take each photo's single best-scoring candidate ("the top AOI for
    each photo"), and measure the spread across those representatives.
    Otherwise — the common case, a single fused ranked list — the spread is
    measured across the top-N (default 3) highest-scoring candidates.

    Returns a dict with ``coherent`` (bool | None if undetermined),
    ``spread_km``, ``radius_km``, ``centroid``, ``n_points_considered`` and a
    human ``rationale``.
    """
    cands = _as_dicts(candidates)
    radius_km = coherence_radius_m / 1000.0

    if not cands:
        return {
            "coherent": None,
            "n_points_considered": 0,
            "spread_km": None,
            "radius_km": radius_km,
            "centroid": None,
            "rationale": "no candidates were supplied — consistency is undetermined, not confirmed.",
        }

    if any("photo" in c and c.get("photo") for c in cands):
        by_photo: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for c in cands:
            by_photo[str(c.get("photo") or "unknown")].append(c)
        points = [max(group, key=lambda c: _num(c.get("score"))) for group in by_photo.values()]
        grouping = f"top candidate for each of {len(points)} photo(s)"
    else:
        top_n = min(3, len(cands))
        points = sorted(cands, key=lambda c: -_num(c.get("score")))[:top_n]
        grouping = f"top-{top_n} scored candidate(s)"

    coords = [(_num(p.get("lat")), _num(p.get("lon"))) for p in points]

    if len(coords) < 2:
        lat, lon = coords[0]
        return {
            "coherent": True,
            "n_points_considered": 1,
            "spread_km": 0.0,
            "radius_km": radius_km,
            "centroid": {"lat": lat, "lon": lon},
            "rationale": f"only one candidate point ({grouping}) — trivially coherent, not independently corroborated.",
        }

    lat_c = sum(la for la, _ in coords) / len(coords)
    lon_c = sum(lo for _, lo in coords) / len(coords)
    dists_m = [_haversine_m(lat_c, lon_c, la, lo) for la, lo in coords]
    spread_m = max(dists_m)
    coherent = spread_m <= coherence_radius_m

    return {
        "coherent": coherent,
        "n_points_considered": len(coords),
        "spread_km": spread_m / 1000.0,
        "radius_km": radius_km,
        "centroid": {"lat": lat_c, "lon": lon_c},
        "rationale": (
            f"{grouping}: max distance from centroid is {spread_m / 1000.0:.2f} km "
            f"({'within' if coherent else 'EXCEEDS'} the {radius_km:.1f} km coherence disk "
            "the pipeline claims for a single scene)."
        ),
    }


# ── calibrate_confidence ──────────────────────────────────────────────────

# Scalar attribute paths compared for cross-photo agreement. Kept generic —
# no country is hardcoded, these are the cue slots forensics.py's contract
# (doc §2A / §4) defines.
_SCALAR_CUE_PATHS: tuple[tuple[str, ...], ...] = (
    ("biome",),
    ("language",),
    ("driving_side",),
    ("terrain_slope",),
    ("architecture", "material"),
    ("architecture", "roof_type"),
    ("architecture", "style"),
)
_LIST_CUE_KEYS: tuple[str, ...] = ("vegetation", "husbandry", "signage_text")


def _get_path(d: dict[str, Any], path: tuple[str, ...]) -> Any:
    cur: Any = d
    for k in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _agreement_score(evidence: list[dict[str, Any]]) -> tuple[float, list[str]]:
    """Cheap, explicit cross-photo corroboration proxy over Stage A
    attributes. For each scalar cue slot that is populated on >=1 photo:
    identical across every photo that states it -> consistent (+1); photos
    disagree -> conflicting (-1). For each list cue slot: any cross-photo
    overlap -> consistent (+1); disjoint non-empty lists -> conflicting (-1).
    Score = clip01((consistent - conflicting) / slots_checked).

    This is monotonic in the intended sense used by the calibration tests:
    going from "nothing populated" (score 0.0, no signal) to "several
    consistent, non-conflicting cues populated across photos" can only raise
    the score, never invents agreement that wasn't stated.
    """
    notes: list[str] = []
    consistent = 0
    conflicting = 0
    checked = 0
    attrs_list = [(e.get("attributes") or {}) for e in evidence]

    for path in _SCALAR_CUE_PATHS:
        vals = [v for v in (_get_path(a, path) for a in attrs_list) if v not in (None, "", [])]
        if not vals:
            continue
        checked += 1
        uniq = sorted({str(v) for v in vals})
        name = ".".join(path)
        if len(uniq) == 1:
            consistent += 1
            notes.append(f"{name}={uniq[0]!r} agrees across {len(vals)} photo(s)")
        else:
            conflicting += 1
            notes.append(f"{name} conflicts across photos: {uniq}")

    for key in _LIST_CUE_KEYS:
        lists = [set(a.get(key) or []) for a in attrs_list]
        lists = [s for s in lists if s]
        if not lists:
            continue
        checked += 1
        overlap = set.intersection(*lists) if len(lists) > 1 else lists[0]
        if overlap:
            consistent += 1
            notes.append(f"{key} overlap across photos: {sorted(overlap)}")
        elif len(lists) > 1:
            conflicting += 1
            notes.append(f"{key} listed with no cross-photo overlap: {[sorted(s) for s in lists]}")

    if checked == 0:
        return 0.0, ["no comparable Stage-A attributes were populated on any photo"]
    return _clip01((consistent - conflicting) / checked), notes


def _canopy_fraction(evidence: list[dict[str, Any]]) -> tuple[float, int, int]:
    n = len(evidence)
    if n == 0:
        return 0.0, 0, 0
    n_canopy = sum(1 for e in evidence if e.get("scene_type") == SceneType.CANOPY_INTERIOR.value)
    return n_canopy / n, n_canopy, n


def _country_key(entry: dict[str, Any]) -> str:
    country = entry.get("country")
    if country:
        return str(country)
    region = str(entry.get("region") or "unknown")
    return (region.split("/")[0].split(",")[0].strip()) or region


def _prior_confidence(p: float, gap: float, agreement: float, *, granularity_discount: float = 0.0) -> float:
    """Conservative blend of prior mass, ambiguity gap, and cross-photo
    agreement. Hard-capped at 0.93 — a rule fuser + VLM blend that has never
    been checked against a labelled ground-truth set does not get to claim
    near-certainty."""
    base = 0.55 * _clip01(p) + 0.20 * _clip01(gap) + 0.25 * _clip01(agreement)
    base *= 1.0 - _clip01(granularity_discount)
    return _clip01(min(base, 0.93))


def _level(confidence: float, tag: str, rationale: str, label: str | None) -> dict[str, Any]:
    assert tag in EVIDENCE_TAGS, f"unknown evidence tag {tag!r}"
    return {
        "confidence": round(_clip01(confidence), 3),
        "evidence_tag": tag,
        "rationale": rationale,
        "label": label,
    }


def calibrate_confidence(
    evidence: Iterable[Any] | None,
    geo_prior: Iterable[Any] | None,
    candidates: Iterable[Any] | None,
    *,
    pose: Any | None = None,
) -> dict[str, dict[str, Any]]:
    """Calibrated confidence PER LEVEL: ``country``, ``region``, ``aoi``,
    ``pose``. Combines evidence weight (prior mass / candidate score),
    agreement across stages (cross-photo attribute corroboration,
    consistency of the AOI cluster), and retrieval scores. Deliberately
    conservative: every number is capped well short of 1.0 unless EXIF GPS
    makes the claim ``proven``, and every level names the evidence it used.

    ``pose`` is an optional keyword (not part of the 3 positional args named
    in the build spec) so this function can still emit the 4th required
    level without changing the stated 3-arg call form; pass Stage D's pose
    dict when available.

    Returns ``{"country": {...}, "region": {...}, "aoi": {...}, "pose": {...}}``,
    each a ``{"confidence", "evidence_tag", "rationale", "label"}`` dict.
    """
    ev = _as_dicts(evidence)
    prior = _as_dicts(geo_prior)
    cands = _as_dicts(candidates)
    pose_d = _as_dict(pose) if pose is not None else None

    n_photos = len(ev)
    gps_photos = [e for e in ev if (e.get("exif") or {}).get("gps")]
    agreement, agreement_notes = _agreement_score(ev)
    canopy_frac, n_canopy, n_photos_checked = _canopy_fraction(ev)
    consistency = verify_consistency(cands)

    # ── EXIF GPS short-circuit (doc §2A: "if GPS present, short-circuit to
    # Stage E with a proven tag"). Ground truth beats every inference below.
    if gps_photos:
        gps_note = f"EXIF GPS present on {len(gps_photos)}/{n_photos} photo(s) — ground truth position, no inference needed."
        country = _level(0.99, "proven", gps_note, label="GPS-confirmed")
        region = _level(0.97, "proven", gps_note, label="GPS-confirmed")
        aoi = _level(0.95, "proven", gps_note, label="GPS-confirmed")
        # GPS gives position, not camera heading/pose — pose still needs Stage D.
        pose_level = _pose_level(pose_d, canopy_frac, n_canopy, n_photos_checked, bool(cands))
        return {"country": country, "region": region, "aoi": aoi, "pose": pose_level}

    # ── country / region from the geo-prior distribution ──────────────────
    if not prior:
        no_prior = "Stage B produced no geo-prior distribution — nothing to calibrate at country/region level."
        country = _level(0.0, "heuristic", no_prior, label=None)
        region = _level(0.0, "heuristic", no_prior, label=None)
    else:
        ranked = sorted(prior, key=lambda r: -_num(r.get("p")))
        top = ranked[0]
        p_top = _clip01(_num(top.get("p")))
        p_second = _clip01(_num(ranked[1].get("p"))) if len(ranked) > 1 else 0.0
        gap = _clip01(p_top - p_second)

        totals: dict[str, float] = defaultdict(float)
        for entry in ranked:
            totals[_country_key(entry)] += _clip01(_num(entry.get("p")))
        by_country = sorted(totals.items(), key=lambda kv: -kv[1])
        country_key_top, country_p = by_country[0]
        country_p2 = by_country[1][1] if len(by_country) > 1 else 0.0
        country_gap = _clip01(country_p - country_p2)
        n_regions_in_group = sum(1 for e in ranked if _country_key(e) == country_key_top)

        country_conf = _prior_confidence(country_p, country_gap, agreement)
        region_conf = _prior_confidence(p_top, gap, agreement, granularity_discount=0.15)

        country = _level(
            country_conf,
            "plumbed-unverified",
            (
                f"'{country_key_top}' carries {_pct(country_p)} of prior mass across "
                f"{n_regions_in_group} region entr{'y' if n_regions_in_group == 1 else 'ies'} "
                f"(runner-up {_pct(country_p2)}); cross-photo attribute agreement "
                f"{_pct(agreement)} over {n_photos} photo(s)."
            ),
            label=country_key_top,
        )
        region = _level(
            region_conf,
            "plumbed-unverified",
            (
                f"top region '{top.get('region')}' carries {_pct(p_top)} prior mass "
                f"(runner-up {_pct(p_second)}); {top.get('rationale') or 'no Stage B rationale given'}; "
                f"cross-photo attribute agreement {_pct(agreement)}."
            ),
            label=top.get("region"),
        )

    # ── AOI from candidates, structurally gated by canopy physics ─────────
    aoi = _aoi_level(cands, consistency, canopy_frac, n_canopy, n_photos_checked)

    # ── pose ────────────────────────────────────────────────────────────
    pose_level = _pose_level(pose_d, canopy_frac, n_canopy, n_photos_checked, bool(cands))

    return {"country": country, "region": region, "aoi": aoi, "pose": pose_level}


def _aoi_level(
    cands: list[dict[str, Any]],
    consistency: dict[str, Any],
    canopy_frac: float,
    n_canopy: int,
    n_photos: int,
) -> dict[str, Any]:
    canopy_note = (
        f"{n_canopy}/{n_photos} photo(s) are canopy-interior scenes — nadir satellite/aerial "
        f"imagery cannot see under forest canopy (this is a physics limit, not a pipeline gap; "
        f"see {_DOC_REF} §0.2), so cross-view (C1) and terrain-skyline (C3) retrieval are unreliable "
        "here regardless of any score they report. AOI confidence is intentionally suppressed."
    )

    if not cands:
        if canopy_frac >= CANOPY_MAJORITY_THRESHOLD:
            return _level(0.0, "heuristic", canopy_note, label=None)
        return _level(
            0.0,
            "heuristic",
            "Stage C produced no candidate AOIs inside the prior region for this run.",
            label=None,
        )

    ranked = sorted(cands, key=lambda c: -_num(c.get("score")))
    top = ranked[0]
    top_score = _clip01(_num(top.get("score")))
    n_sources = len({str(s).split(":")[0] for s in (top.get("sources") or [])}) or 1
    source_bonus = _clip01((n_sources - 1) * 0.15)
    coherence_bonus = 0.15 if consistency.get("coherent") else (-0.20 if consistency.get("coherent") is False else 0.0)
    base = _clip01(min(0.65 * top_score + source_bonus + coherence_bonus, 0.9))

    label = f"({_num(top.get('lat')):.4f}, {_num(top.get('lon')):.4f})"

    if canopy_frac >= CANOPY_MAJORITY_THRESHOLD:
        capped = min(base, 0.15)
        return _level(capped, "heuristic", canopy_note + f" (raw candidate score would have been {top_score:.2f}.)", label=label)

    rationale = (
        f"top candidate score={top_score:.2f} from {n_sources} independent source group(s); "
        f"consistency={'coherent' if consistency.get('coherent') else 'scattered' if consistency.get('coherent') is False else 'undetermined'} "
        f"(spread {consistency.get('spread_km')} km vs {consistency.get('radius_km')} km disk)."
    )
    return _level(base, "plumbed-unverified", rationale, label=label)


def _pose_level(
    pose_d: dict[str, Any] | None,
    canopy_frac: float,
    n_canopy: int,
    n_photos: int,
    has_candidates: bool,
) -> dict[str, Any]:
    if pose_d is None:
        if canopy_frac >= CANOPY_MAJORITY_THRESHOLD:
            reason = (
                f"Stage D not attempted: {n_canopy}/{n_photos} photo(s) are canopy-interior, and the "
                f"router (doc §2) only invokes D for open/semi-open scenes with a surviving AOI."
            )
        elif not has_candidates:
            reason = "Stage D not attempted: no AOI survived Stage C for the router to hand to D."
        else:
            reason = "no pose was supplied to calibrate_confidence — Stage D likely was not run for this AOI."
        return _level(0.0, "heuristic", reason, label=None)

    reproj = pose_d.get("reproj_error_px")
    method = pose_d.get("method", "unknown")
    if reproj is None:
        conf = 0.3
        detail = "no reprojection error reported"
    else:
        reproj_f = max(0.0, _num(reproj))
        conf = _clip01(0.9 - _clip01(reproj_f / 50.0) * 0.7)
        detail = f"reprojection error {reproj_f:.1f} px"
    label = method
    rationale = f"Stage D ({method}) pose: {detail}."
    return _level(conf, "plumbed-unverified", rationale, label=label)


# ── write_report: geo_assessment.md + result.geojson ──────────────────────

_HONEST_LIMITS_STATIC = (
    f"Free global VHR-with-RPC does not exist — full 3DGS pose (Stage D1) only bites where "
    f"benchmark stereo+RPC coverage is available; elsewhere the pipeline degrades to cross-view "
    f"retrieval + 2.5D DSM ({_DOC_REF} §0.1).",
    f"Nadir satellite imagery cannot see under a forest canopy — this is a property of the physics, "
    f"not an implementation gap; canopy-interior shots are routed to Stages A-C only ({_DOC_REF} §0.2).",
    f"Cross-view retrieval models are trained on urban/road panoramas — rural/forest queries are "
    f"out-of-distribution; retrieval is a ranker of candidates, never a sole oracle ({_DOC_REF} §0.3).",
    "This module's confidence numbers are a conservative fusion heuristic (prior mass + cross-stage "
    "agreement + retrieval score), not independently calibrated against a labelled ground-truth set — "
    "treat as a same-run consistency signal, not a probability guarantee.",
)


def _method_to_go_finer(
    confidence: dict[str, dict[str, Any]],
    canopy_frac: float,
    n_canopy: int,
    n_photos: int,
    cands: list[dict[str, Any]],
) -> list[str]:
    lines: list[str] = []
    if confidence["aoi"]["confidence"] < 0.3:
        if canopy_frac >= CANOPY_MAJORITY_THRESHOLD:
            lines.append(
                f"{n_canopy}/{n_photos} photo(s) are under forest canopy, where nadir VHR/Gaussian-"
                "splat pose (Stage D) cannot bite and cross-view retrieval (C1) has no matching "
                "aerial appearance to rank against. The next lever is NOT more satellite imagery — "
                "it is ground-level REFERENCE-IMAGE CROSS-MATCH: pull geotagged trail/forest photos "
                "for the candidate region (e.g. Mapillary/KartaView street- and trail-level imagery, "
                "or analyst-supplied references) and match on trunk spacing, understory, rock/soil "
                "colour, trail furniture and signage instead of aerial footprint. A human analyst "
                "pass over OSM natural=wood / landuse=forest polygons inside the region prior, "
                "cross-referenced with any partial sightlines (canopy breaks, distant ridgelines) "
                "noted by Stage A, is the realistic path to a tighter AOI."
            )
        elif not cands:
            lines.append(
                "Stage C returned no candidates inside the prior bbox — widen the OSM/Overpass "
                "query tag set (C2) or lower its co-occurrence threshold before concluding the AOI "
                "is unresolvable; the scene is not canopy-blocked, so retrieval should eventually "
                "produce something."
            )
        else:
            lines.append(
                "Candidates exist but score low or scatter beyond the coherence disk — collect more "
                "photos of the same scene from different angles (tightens both cross-view retrieval "
                "and the consistency check), or supply an EXIF timestamp to unlock the sun/shadow cue."
            )
    if confidence["pose"]["confidence"] < 0.3 and confidence["aoi"]["confidence"] >= 0.3:
        lines.append(
            "AOI is resolved with enough confidence to attempt Stage D: if the scene is open/semi-"
            "open, run D1 (stereo+RPC 3DGS render-and-compare) where benchmark stereo coverage "
            "exists, else D2 (single-view VHR + Copernicus DSM silhouette/shadow match)."
        )
    if not lines:
        lines.append("No further automated lever identified at this evidence level — escalate to analyst review.")
    return lines


def _fmt_cues(attrs: dict[str, Any]) -> str:
    parts = []
    for key in ("biome", "language", "driving_side", "terrain_slope"):
        v = attrs.get(key)
        if v:
            parts.append(f"{key}={v}")
    arch = attrs.get("architecture") or {}
    if isinstance(arch, dict):
        for key in ("style", "material", "roof_type", "colour"):
            v = arch.get(key)
            if v:
                parts.append(f"architecture.{key}={v}")
    for key in _LIST_CUE_KEYS:
        v = attrs.get(key)
        if v:
            parts.append(f"{key}={list(v)}")
    return "; ".join(parts) if parts else "no structured cues populated"


def _render_markdown(
    ev: list[dict[str, Any]],
    prior: list[dict[str, Any]],
    cands: list[dict[str, Any]],
    pose_d: dict[str, Any] | None,
    consistency: dict[str, Any],
    confidence: dict[str, dict[str, Any]],
) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    photo_names = ", ".join(f"`{e.get('photo', '?')}`" for e in ev) or "(none supplied)"
    canopy_frac, n_canopy, n_photos = _canopy_fraction(ev)

    lines: list[str] = []
    lines.append("# Photo Geolocation Assessment")
    lines.append("")
    lines.append(f"- Generated: {ts}")
    lines.append(f"- Photos analysed: {len(ev)} ({photo_names})")
    lines.append(f"- Pipeline: `geolocate` Stage E — see {_DOC_REF}")
    lines.append("")

    lines.append("## Verdict")
    lines.append("")
    for key, title, unit in (
        ("country", "Country", ""),
        ("region", "Region", ""),
        ("aoi", "AOI (≤~1 km)", ""),
        ("pose", "Pose", ""),
    ):
        lvl = confidence[key]
        label = lvl["label"] or "not resolved"
        lines.append(f"### {title} — {label} ({_pct(lvl['confidence'])}, {lvl['evidence_tag']})")
        lines.append("")
        lines.append(f"> {lvl['rationale']}")
        lines.append("")

    lines.append("## Consistency check")
    lines.append("")
    if consistency.get("coherent") is None:
        lines.append(f"- Undetermined: {consistency['rationale']}")
    else:
        lines.append(
            f"- {'COHERENT' if consistency['coherent'] else 'SCATTERED'}: {consistency['rationale']}"
        )
    lines.append("")

    lines.append("## Evidence")
    lines.append("")
    lines.append("### Per-photo (Stage A)")
    if ev:
        for e in ev:
            photo = e.get("photo", "?")
            phash = e.get("phash", "?")
            scene = e.get("scene_type", "unknown")
            caption = e.get("caption") or "(no caption)"
            cues = _fmt_cues(e.get("attributes") or {})
            lines.append(
                f"- `{photo}` (phash `{phash}`, see `evidence/{photo}.json`): scene_type=`{scene}`; "
                f'caption: "{caption}"; cues: {cues}'
            )
    else:
        lines.append("- (no per-photo evidence supplied)")
    lines.append("")

    lines.append("### Geo-prior (Stage B)")
    if prior:
        for entry in sorted(prior, key=lambda r: -_num(r.get("p"))):
            lines.append(
                f"- **{entry.get('region', '?')}** p={_num(entry.get('p')):.2f} "
                f"bbox={entry.get('bbox')} — {entry.get('rationale') or '(no rationale given)'}"
            )
    else:
        lines.append("- (no geo-prior distribution supplied)")
    lines.append("")

    lines.append("### Candidates (Stage C)")
    if cands:
        for c in sorted(cands, key=lambda c: -_num(c.get("score"))):
            lines.append(
                f"- ({_num(c.get('lat')):.4f}, {_num(c.get('lon')):.4f}) "
                f"r={c.get('radius_m')} m score={_num(c.get('score')):.2f} "
                f"sources={c.get('sources')} — {c.get('evidence') or '(no evidence note)'}"
            )
    else:
        lines.append("- (no candidates — see Honest Limits / Method to go finer)")
    lines.append("")

    lines.append("### Pose (Stage D)")
    if pose_d:
        lines.append(
            f"- method={pose_d.get('method', 'unknown')} "
            f"reproj_error={pose_d.get('reproj_error_px', 'n/a')} px "
            f"lat/lon={pose_d.get('lat')},{pose_d.get('lon')}"
        )
    else:
        lines.append("- not attempted — see Method to go finer")
    lines.append("")

    lines.append("## Honest limits")
    lines.append("")
    for item in _HONEST_LIMITS_STATIC:
        lines.append(f"- {item}")
    if canopy_frac >= CANOPY_MAJORITY_THRESHOLD:
        lines.append(
            f"- **This run**: {n_canopy}/{n_photos} photo(s) are canopy-interior — AOI and pose "
            "confidence below were structurally suppressed rather than left to the retrieval "
            "scores, per the physics limit above."
        )
    if consistency.get("coherent") is False:
        lines.append(
            f"- **This run**: candidate AOIs did NOT cluster within the coherence disk "
            f"({consistency.get('spread_km')} km spread vs {consistency.get('radius_km')} km claimed) "
            "— treat the AOI verdict as unresolved, not merely low-confidence."
        )
    lines.append("")

    lines.append("## Method to go finer")
    lines.append("")
    for item in _method_to_go_finer(confidence, canopy_frac, n_canopy, n_photos, cands):
        lines.append(f"- {item}")
    lines.append("")

    return "\n".join(lines)


def _prior_polygon_feature(entry: dict[str, Any], country_lvl: dict[str, Any], region_lvl: dict[str, Any]) -> dict[str, Any] | None:
    bbox = entry.get("bbox")
    if not bbox or len(bbox) != 4:
        return None
    w, s, e, n = (_num(v) for v in bbox)
    coords = [[[w, s], [e, s], [e, n], [w, n], [w, s]]]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": coords},
        "properties": {
            "kind": "geo_prior_region",
            "region": entry.get("region"),
            "country": _country_key(entry),
            "p": _clip01(_num(entry.get("p"))),
            "rationale": entry.get("rationale"),
            "confidence_country": country_lvl["confidence"],
            "confidence_region": region_lvl["confidence"],
        },
    }


def _candidate_point_feature(cand: dict[str, Any], aoi_lvl: dict[str, Any]) -> dict[str, Any] | None:
    if cand.get("lat") is None or cand.get("lon") is None:
        return None
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [_num(cand.get("lon")), _num(cand.get("lat"))]},
        "properties": {
            "kind": "candidate_aoi",
            "score": _clip01(_num(cand.get("score"))),
            "radius_m": cand.get("radius_m"),
            "sources": cand.get("sources") or [],
            "evidence": cand.get("evidence"),
            "confidence_aoi": aoi_lvl["confidence"],
        },
    }


def _pose_point_feature(pose_d: dict[str, Any], pose_lvl: dict[str, Any]) -> dict[str, Any] | None:
    if pose_d.get("lat") is None or pose_d.get("lon") is None:
        return None
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [_num(pose_d.get("lon")), _num(pose_d.get("lat"))]},
        "properties": {
            "kind": "pose",
            "heading_deg": pose_d.get("heading_deg"),
            "method": pose_d.get("method"),
            "reproj_error_px": pose_d.get("reproj_error_px"),
            "confidence_pose": pose_lvl["confidence"],
        },
    }


def _render_geojson(
    prior: list[dict[str, Any]],
    cands: list[dict[str, Any]],
    pose_d: dict[str, Any] | None,
    confidence: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    features: list[dict[str, Any]] = []
    for entry in prior:
        feat = _prior_polygon_feature(entry, confidence["country"], confidence["region"])
        if feat is not None:
            features.append(feat)
    for cand in cands:
        feat = _candidate_point_feature(cand, confidence["aoi"])
        if feat is not None:
            features.append(feat)
    if pose_d:
        feat = _pose_point_feature(pose_d, confidence["pose"])
        if feat is not None:
            features.append(feat)
    return {"type": "FeatureCollection", "features": features}


def write_report(
    out_dir: str | Path,
    evidence: Iterable[Any] | None,
    geo_prior: Iterable[Any] | None,
    candidates: Iterable[Any] | None,
    pose: Any | None = None,
) -> dict[str, Any]:
    """Emit ``geo_assessment.md`` and ``result.geojson`` into ``out_dir``.

    Returns ``{"markdown_path", "geojson_path", "confidence", "consistency"}``
    so an orchestrator (pipeline.py) can log/act on the same numbers without
    re-parsing the files.
    """
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    ev = _as_dicts(evidence)
    prior = _as_dicts(geo_prior)
    cands = _as_dicts(candidates)
    pose_d = _as_dict(pose) if pose is not None else None

    consistency = verify_consistency(cands)
    confidence = calibrate_confidence(ev, prior, cands, pose=pose_d)

    md = _render_markdown(ev, prior, cands, pose_d, consistency, confidence)
    geojson = _render_geojson(prior, cands, pose_d, confidence)

    md_path = out_path / "geo_assessment.md"
    geojson_path = out_path / "result.geojson"
    md_path.write_text(md, encoding="utf-8")
    geojson_path.write_text(json.dumps(geojson, indent=2), encoding="utf-8")

    return {
        "markdown_path": str(md_path),
        "geojson_path": str(geojson_path),
        "confidence": confidence,
        "consistency": consistency,
    }


def write(
    evidence: Iterable[Any] | None,
    groups: Any | None,
    router: Any | None,
    priors: Iterable[Any] | None,
    candidates: Iterable[Any] | None,
    outdir: str | Path,
) -> Path:
    """Compatibility adapter for pipeline.py's documented Stage E call site
    (``_CALL_SITE_CONTRACT`` in geolocate/pipeline.py: ``report.write(evidence,
    groups, router, priors, candidates, outdir) -> Path``).

    ``groups`` (phash dedup clusters) and ``router`` (per-photo
    RouterDecision) are accepted for call-site compatibility but not yet
    consumed by the report body — this build's honesty logic derives
    everything it needs (canopy gating, EXIF short-circuit) directly from
    ``evidence``/``candidates``. Returns the ``geo_assessment.md`` path, as
    the call-site contract's ``-> Path`` return type specifies (use
    ``write_report`` directly for the fuller ``{markdown_path, geojson_path,
    confidence, consistency}`` result).
    """
    del groups, router  # accepted for call-site compatibility only, see docstring
    result = write_report(outdir, evidence, priors, candidates, pose=None)
    return Path(result["markdown_path"])


# ── to_ontology: optional local-ontology writeback ────────────────────────


async def to_ontology(
    registry: Any | None,
    evidence: Iterable[Any] | None,
    candidates: Iterable[Any] | None,
) -> dict[str, Any]:
    """Best-effort writeback: mint one ``photo:<phash>`` object per photo,
    linked to a ``place:*`` object via ``located_at`` (if an AOI candidate
    exists) or ``evidence_of`` (region-only fallback, e.g. the canopy case
    where no AOI resolved).

    ``registry`` is expected to be a ``SqliteRegistry`` from
    ``app.intel.ontology_local.get_registry(ctx)`` (async surface — this
    function is itself ``async`` to match it 1:1; a sync caller should
    ``asyncio.run(to_ontology(...))``). This function is a NO-OP (logged, not
    raised) if ``registry`` is ``None`` or the ontology package can't be
    imported — it must never sit on the keyless critical path.

    Models on ``app/intel/ontology_local.py`` (read for the real signatures
    before changing this): ``Object.props`` is a wholesale-replace blob, so
    ``kind`` for both photo and place objects is kept as the catch-all
    ``"object"`` (neither prefix is in ``ObjectKind``'s Literal) with the
    specific kind carried in ``props["kind"]`` — the same convention already
    used for situations/maps workspace nodes.
    """
    if registry is None:
        logger.info("to_ontology: no registry supplied — skipping ontology writeback (keyless run)")
        return {"written": False, "reason": "no registry supplied", "photo_ids": [], "place_id": None}

    try:
        from app.intel.ontology import Link, Object
    except Exception as exc:  # pragma: no cover - env without apps/api/app importable
        logger.info("to_ontology: ontology package unavailable (%s) — skipping writeback", exc)
        return {"written": False, "reason": f"ontology import failed: {exc}", "photo_ids": [], "place_id": None}

    ev = _as_dicts(evidence)
    cands = _as_dicts(candidates)
    if not ev:
        return {"written": False, "reason": "no evidence to writeback", "photo_ids": [], "place_id": None}

    place_id: str | None = None
    place_obj: Any | None = None
    rel = "evidence_of"
    link_confidence = 0.0

    if cands:
        top = max(cands, key=lambda c: _num(c.get("score")))
        lat, lon = _num(top.get("lat")), _num(top.get("lon"))
        place_id = f"place:aoi:{lat:.4f}_{lon:.4f}"
        place_obj = Object(
            id=place_id,
            kind="object",
            props={
                "kind": "place",
                "label": f"AOI ({lat:.4f}, {lon:.4f})",
                "lat": lat,
                "lon": lon,
                "radius_m": top.get("radius_m"),
                "source": "geolocate:stageE",
            },
        )
        rel = "located_at"
        link_confidence = _clip01(_num(top.get("score")))
    # NOTE: a region-only fallback place (rel="evidence_of") would need the
    # geo_prior list, which this function's spec'd signature does not
    # receive — callers with a canopy/no-AOI run and a geo_prior available
    # should mint that place themselves and call registry.link directly, or
    # this function can be extended with an optional geo_prior kwarg later.
    if place_obj is None:
        logger.info("to_ontology: no candidate AOI to link — skipping writeback (no place to mint)")
        return {"written": False, "reason": "no candidate AOI available to mint a place", "photo_ids": [], "place_id": None}

    photo_ids: list[str] = []
    try:
        await registry.upsert(place_obj, source="geolocate:stageE")
        for e in ev:
            phash = e.get("phash")
            if not phash:
                continue
            photo_id = f"photo:{phash}"
            photo_obj = Object(
                id=photo_id,
                kind="object",
                props={
                    "kind": "photo",
                    "filename": e.get("photo"),
                    "phash": phash,
                    "scene_type": e.get("scene_type"),
                    "caption": e.get("caption"),
                },
            )
            await registry.upsert(photo_obj, source="geolocate:stageE")
            await registry.link(
                Link(
                    src=photo_id,
                    dst=place_id,
                    rel=rel,
                    props={"stage": "E"},
                    source="geolocate:stageE",
                    confidence=link_confidence,
                )
            )
            photo_ids.append(photo_id)
    except Exception as exc:  # never break the keyless path on a DB error
        logger.warning("to_ontology: writeback failed (%s) — continuing keyless", exc)
        return {
            "written": bool(photo_ids),
            "reason": f"partial/failed write: {exc}",
            "photo_ids": photo_ids,
            "place_id": place_id,
        }

    return {"written": True, "reason": None, "photo_ids": photo_ids, "place_id": place_id}
