"""Stage B — geo-prior fusion (docs/photo-geolocation-pipeline.md §2 Stage B).

Consumes Stage A's ``evidence/{photo}.json`` (``contracts.Evidence``) and
produces a ranked ``geo_prior.json`` (``list[contracts.GeoPrior]``): a
probability distribution over candidate regions, each carrying a search bbox
for Stage C and a human-readable rationale. Two fusers are combined:

  (a) a RULE fuser driven by a generic, data-only cue -> region-weight
      knowledge base (``knowledge/cues.yaml``). No country/region name
      appears anywhere in THIS module's code — every region name lives in
      the YAML (cues.yaml weights + region_bboxes.yaml bboxes), so the KB is
      extensible worldwide without touching Python.
  (b) an optional VLM top-k ``{region: prob}`` estimate, injected by the
      orchestrator (pipeline.py) as ``vlm_estimate=``. If absent, rule-only.

Fusion is a weighted LOG-OPINION POOL (product-of-experts in probability
space == a weighted sum in log space, renormalized), not a linear mixture:
a region near-zero under either opinion stays near-zero after pooling, so
one fuser can veto a region the other likes — which is the point of pooling
independent opinions instead of averaging them.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import yaml

try:  # geolocate.contracts is another builder's module (spec §4/§5)
    from geolocate.contracts import Evidence, GeoPrior
except ImportError:  # pragma: no cover - contracts.py not yet present
    Evidence = None  # type: ignore[assignment,misc]
    GeoPrior = None  # type: ignore[assignment,misc]

_HERE = Path(__file__).resolve().parent
_KB_PATH = _HERE / "knowledge" / "cues.yaml"
_BBOX_PATH = _HERE / "knowledge" / "region_bboxes.yaml"

# A region with no bundled bbox (e.g. a region name only ever supplied by a
# VLM estimate, never by our own KB) still needs SOME search box for Stage C
# rather than crashing — fall back to the whole world, flagged in rationale.
_WORLD_BBOX = [-180.0, -90.0, 180.0, 90.0]

EvidenceLike = Any  # Evidence | dict — see _as_dict()


# ── knowledge base loading ───────────────────────────────────────────────


def load_kb(path: str | Path | None = None) -> list[dict[str, Any]]:
    """Load the cue -> region-weight rules from ``knowledge/cues.yaml``."""
    p = Path(path) if path else _KB_PATH
    doc = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    cues = doc.get("cues") or []
    if not isinstance(cues, list):
        raise ValueError(f"{p}: 'cues' must be a list")
    return cues


def load_region_bboxes(path: str | Path | None = None) -> dict[str, list[float]]:
    """Load the bundled region -> [west, south, east, north] lookup."""
    p = Path(path) if path else _BBOX_PATH
    doc = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    regions = doc.get("regions") or {}
    return {k: list(v) for k, v in regions.items()}


# ── evidence flattening + cue matching (fully generic — no region names) ──


def _as_dict(evidence: EvidenceLike) -> dict[str, Any]:
    """Accept a contracts.Evidence, a plain dict, or a list of either
    (callers pass whichever is convenient); this always returns one dict.
    """
    if hasattr(evidence, "to_dict"):
        return evidence.to_dict()
    if isinstance(evidence, dict):
        return evidence
    raise TypeError(f"expected Evidence or dict, got {type(evidence)!r}")


def _flatten_text(evidence: dict[str, Any]) -> str:
    """Flatten every string leaf in the evidence dict into one lowercase blob
    (caption, confidence_notes, and every nested attribute string/list-item —
    including whatever keys Stage A puts inside the free-form `architecture`
    dict). This is what makes most cues schema-drift tolerant: they search
    this blob rather than a specific sub-path.
    """
    parts: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, str):
            parts.append(node)
        elif isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, (list, tuple)):
            for v in node:
                walk(v)
        # numbers / bools / None carry no search text

    walk(evidence)
    return " | ".join(parts).lower()


def _get_path(evidence: dict[str, Any], path: str) -> Any:
    node: Any = evidence
    for part in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node


def _cue_fires(
    evidence: dict[str, Any], full_text: str, cue: dict[str, Any]
) -> tuple[dict[str, float], str] | None:
    """Return (weights, matched_on) if `cue` fires against this evidence, else None."""
    kind = cue.get("match", "any")
    path = cue.get("path", "text")

    if kind == "any":
        if path == "text":
            haystack = full_text
        else:
            val = _get_path(evidence, path)
            if val is None:
                return None
            haystack = str(val).lower() if not isinstance(val, list) else " | ".join(str(v) for v in val).lower()
        for kw in cue.get("keywords", []):
            if kw.lower() in haystack:
                return cue.get("weights", {}), kw
        return None

    if kind in ("equals", "table"):
        value = _get_path(evidence, path)
        if value is None:
            return None
        candidates = value if isinstance(value, list) else [value]
        for v in candidates:
            if v is None:
                continue
            key = str(v).strip()
            if not key:
                continue
            if kind == "equals":
                if key.lower() == str(cue.get("value", "")).lower():
                    return cue.get("weights", {}), key
            else:  # table
                table = cue.get("table", {})
                if key in table:
                    return table[key], key
                for tk, tw in table.items():
                    if tk.lower() == key.lower():
                        return tw, key
        return None

    return None


def score_cues(
    evidence: EvidenceLike, kb: list[dict[str, Any]]
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    """Sum every firing cue's weights per region. Returns (scores, fired_cues)
    where fired_cues records what matched, for building rationale text.
    """
    ev = _as_dict(evidence)
    full_text = _flatten_text(ev)
    scores: dict[str, float] = {}
    fired: list[dict[str, Any]] = []
    for cue in kb:
        result = _cue_fires(ev, full_text, cue)
        if result is None:
            continue
        weights, matched_on = result
        fired.append(
            {
                "id": cue.get("id", "?"),
                "matched_on": matched_on,
                "weights": dict(weights),
                "rationale": (cue.get("rationale") or "").strip(),
            }
        )
        for region, w in weights.items():
            scores[region] = scores.get(region, 0.0) + float(w)
    return scores, fired


# ── probability math ─────────────────────────────────────────────────────


def _softmax(scores: dict[str, float], temperature: float = 1.5) -> dict[str, float]:
    """Turn raw additive cue weights into a probability distribution.

    A higher temperature flattens the distribution (less overconfident); 1.5
    is chosen so a scene with several strongly-aligned cues (like the demo
    scene) still leaves visible mass on the 2nd/3rd region rather than
    collapsing to ~100% on the top pick.
    """
    if not scores:
        return {}
    t = max(temperature, 1e-6)
    m = max(scores.values())
    exps = {k: math.exp((v - m) / t) for k, v in scores.items()}
    total = sum(exps.values())
    return {k: v / total for k, v in exps.items()}


def _normalize_probs(d: dict[str, float]) -> dict[str, float]:
    total = sum(max(v, 0.0) for v in d.values())
    if total <= 0:
        return {}
    return {k: max(v, 0.0) / total for k, v in d.items()}


def log_opinion_pool(
    dists: list[tuple[dict[str, float], float]], epsilon: float = 1e-3
) -> dict[str, float]:
    """Weighted product-of-experts fusion of independent {region: prob} opinions.

    Each entry is (distribution, weight). A region absent from one opinion
    gets an epsilon floor (not zero) so a silent fuser doesn't hard-zero it —
    but any opinion that actively disagrees (assigns a low, non-epsilon
    probability) still pulls the pooled result down, unlike a linear mix
    where a single confident fuser can drag a region up regardless of what
    the other says.
    """
    regions: set[str] = set()
    for dist, _ in dists:
        regions |= set(dist)
    if not regions:
        return {}
    log_scores = {r: 0.0 for r in regions}
    for dist, weight in dists:
        for r in regions:
            p = dist.get(r, epsilon)
            log_scores[r] += weight * math.log(max(p, epsilon))
    m = max(log_scores.values())
    exps = {r: math.exp(v - m) for r, v in log_scores.items()}
    total = sum(exps.values())
    return {r: v / total for r, v in exps.items()}


# ── top-level entry point ────────────────────────────────────────────────


def build_geo_prior(
    evidence: EvidenceLike | list[EvidenceLike],
    *,
    vlm_estimate: dict[str, float] | None = None,
    kb: list[dict[str, Any]] | None = None,
    region_bboxes: dict[str, list[float]] | None = None,
    kb_path: str | Path | None = None,
    bbox_path: str | Path | None = None,
    w_rule: float = 1.0,
    w_vlm: float = 1.0,
    temperature: float = 1.5,
    top_k: int = 6,
) -> list[Any]:
    """Fuse Stage A evidence (one photo or several) into ranked regions.

    Returns a list of ``contracts.GeoPrior`` (or, if contracts.py is not
    importable, an equivalent dict with the exact same keys — see
    docs/photo-geolocation-pipeline.md §4) sorted by descending probability,
    each carrying a bbox for Stage C and a rationale citing which cues fired.
    """
    kb = kb if kb is not None else load_kb(kb_path)
    bboxes = region_bboxes if region_bboxes is not None else load_region_bboxes(bbox_path)

    evidence_list = evidence if isinstance(evidence, list) else [evidence]

    combined_scores: dict[str, float] = {}
    all_fired: list[dict[str, Any]] = []
    for ev in evidence_list:
        scores, fired = score_cues(ev, kb)
        all_fired.extend(fired)
        for region, w in scores.items():
            combined_scores[region] = combined_scores.get(region, 0.0) + w

    rule_probs = _softmax(combined_scores, temperature=temperature)

    if vlm_estimate:
        vlm_probs = _normalize_probs(vlm_estimate)
        fused = log_opinion_pool([(rule_probs, w_rule), (vlm_probs, w_vlm)]) if rule_probs else vlm_probs
        fusion_note = (
            f"log-opinion pool of rule-KB ({len(all_fired)} cue(s) fired, weight {w_rule}) "
            f"+ VLM estimate (weight {w_vlm})"
        )
    else:
        fused = rule_probs
        fusion_note = f"rule-KB only ({len(all_fired)} cue(s) fired) — no VLM estimate supplied"

    if not fused:
        return []

    ranked = sorted(fused.items(), key=lambda kv: kv[1], reverse=True)[:top_k]

    out: list[Any] = []
    for region, p in ranked:
        contributing = sorted(
            (f for f in all_fired if region in f["weights"]),
            key=lambda f: f["weights"][region],
            reverse=True,
        )[:3]
        bits = [
            f'{c["id"]} (+{c["weights"][region]:.2f}, matched "{c["matched_on"]}"): {c["rationale"]}'
            for c in contributing
        ]
        if not bits:
            bits = ["contribution from VLM estimate only (no rule cue matched this region)"]
        rationale = fusion_note + ". " + " || ".join(bits)

        bbox = bboxes.get(region)
        if bbox is None:
            bbox = list(_WORLD_BBOX)
            rationale += " || NOTE: no bundled bbox for this region — falling back to a world bbox; add it to knowledge/region_bboxes.yaml."

        row = {"region": region, "bbox": list(bbox), "p": round(p, 4), "rationale": rationale}
        if GeoPrior is not None:
            out.append(GeoPrior(**row))
        else:  # pragma: no cover - contracts.py not yet present
            out.append(row)
    return out


def fuse(evidence: list[EvidenceLike], *, vlm_estimate: dict[str, float] | None = None) -> list[Any]:
    """Call-site contract entrypoint for pipeline.py (spec §5/§6):
    ``geoprior.fuse(evidence: list[Evidence]) -> list[GeoPrior]``.

    Thin wrapper over :func:`build_geo_prior` — the orchestrator today calls
    this with evidence only; ``vlm_estimate`` remains available for direct/
    CLI use once an orchestrator wires up a VLM top-k estimate (spec §2
    Stage B "VLM geo-estimator").
    """
    return build_geo_prior(evidence, vlm_estimate=vlm_estimate)


__all__ = [
    "load_kb",
    "load_region_bboxes",
    "score_cues",
    "log_opinion_pool",
    "build_geo_prior",
    "fuse",
]
