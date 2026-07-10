#!/usr/bin/env python3
"""Stage C2 — OSM/Overpass structured feature retrieval
(docs/photo-geolocation-pipeline.md §2 Stage C, "C2 OSM/Overpass structured match").

Translates Stage A's discrete scene attributes (forest? pasture/husbandry?
a timber outbuilding? a farmyard?) into a live, keyless Overpass QL query
scoped to Stage B's prior bbox, then scores ~1 km AOIs by how many
INDEPENDENT feature classes co-occur within that cell (a forest edge next to
a meadow next to a timber building next to a farmyard is a much stronger
match than any one of those alone).

Keyless, live, robust: mirrors the 3-mirror + backoff pattern in
apps/api/app/intel/lod1.py (`_overpass_query`) — copied and adapted rather
than imported, so apps/ml never depends on apps/api. Any Overpass failure
(timeout, 429, DNS) degrades to an EMPTY candidate list with a logged reason
rather than raising — Stage C2 must never crash the pipeline.

CLI:
  apps/api/.venv/bin/python -m geolocate.retrieval.osm \
      --bbox 8.0 54.5 15.2 57.8 --evidence evidence/photo1.json -o candidates.json
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:  # geolocate.contracts is another builder's module (spec §4/§5)
    from geolocate.contracts import Candidate, dump_candidates
except ImportError:  # pragma: no cover - contracts.py not yet present
    Candidate = None  # type: ignore[assignment,misc]
    dump_candidates = None  # type: ignore[assignment]

log = logging.getLogger("geolocate.retrieval.osm")

# Public Overpass mirrors, tried in order — same list as
# apps/api/app/intel/lod1.py._OVERPASS_ENDPOINTS. GEOLOC_OVERPASS_URL
# overrides with a single self-hosted instance (keeps this module self-
# contained: no app.config import from apps/ml).
_OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
_MIRROR_TIMEOUT_S = 40
_MIRROR_BACKOFF_S = 1.5
_MAX_ELEMENTS = 400  # Overpass `out ... N;` cap — keeps responses light + AOI clustering fast

# Stage B's prior bbox is often country-scale (e.g. Denmark ~7deg x 3.3deg).
# Overpass's per-request output cap (`out ... N;`) bounds what comes BACK but
# not the server-side cost of finding matches for common tags (forest/
# meadow/farmland) across a whole country — a naive country-scale query on
# common tags reliably times out every public mirror (measured live: a
# Denmark-sized bbox timed out at 40s x 3 mirrors; a 0.6deg-square bbox
# around the same area returned in ~13s). So, same idea as
# apps/api/app/intel/lod1.py's MAX_BBOX_SPAN: an over-wide query bbox is
# shrunk toward its centre before querying, honestly recorded in `meta` so
# nothing is silently narrowed.
_MAX_QUERY_SPAN_DEG = 0.5


def _clip_bbox_to_max_span(
    bbox: tuple[float, float, float, float], max_span: float = _MAX_QUERY_SPAN_DEG
) -> tuple[tuple[float, float, float, float], bool]:
    """Shrink an over-wide (west,south,east,north) bbox toward its centre so
    a query never spans more than `max_span` degrees per axis. Returns
    (clipped_bbox, was_clipped).
    """
    w, s, e, n = bbox
    clon, clat = (w + e) / 2, (s + n) / 2
    clipped = False
    if e - w > max_span:
        w, e = clon - max_span / 2, clon + max_span / 2
        clipped = True
    if n - s > max_span:
        s, n = clat - max_span / 2, clat + max_span / 2
        clipped = True
    return (w, s, e, n), clipped

# Evidence attribute-derived feature classes we can translate into Overpass
# tag filters. Each entry is (class_name, [(key, value), ...]); the SAME
# table both builds the query filters and re-classifies returned elements
# from their tags (single source of truth, no drift between the two).
#
# Tag choices are deliberately broad (multiple plausible OSM taggings per
# class) since real-world tagging is inconsistent — better to over-match a
# class than silently miss common real tagging variants.
FEATURE_CLASSES: list[tuple[str, list[tuple[str, str]]]] = [
    ("forest", [("landuse", "forest"), ("natural", "wood")]),
    (
        "meadow_pasture",
        [
            ("landuse", "meadow"),
            ("landuse", "farmland"),
            ("landuse", "grass"),
            ("natural", "grassland"),
        ],
    ),
    (
        "timber_structure",
        [
            ("building", "cabin"),
            ("building", "hut"),
            ("building", "shed"),
            ("building", "farm_auxiliary"),
            ("building:material", "wood"),
        ],
    ),
    ("farmyard", [("landuse", "farmyard"), ("building", "farm"), ("building", "barn")]),
    (
        "tourism_leisure_timber",
        [
            ("tourism", "wilderness_hut"),
            ("tourism", "alpine_hut"),
            ("tourism", "camp_site"),
            ("leisure", "nature_reserve"),
        ],
    ),
]

# evidence-attribute keyword -> feature class(es) it implies are worth
# querying. Kept small/explicit (unlike geoprior's YAML KB, this is a code-
# adjacent Overpass-tag mapping, not a geographic prior — nothing here names
# a country or region).
_CLASS_TRIGGERS: dict[str, list[str]] = {
    "forest": ["forest", "wood", "beech", "birch", "conifer", "taiga", "canopy"],
    "meadow_pasture": ["pasture", "meadow", "grazing", "cattle", "herd", "livestock", "paddock", "field"],
    "timber_structure": ["timber", "cabin", "shed", "hut", "outbuilding", "log cabin", "wooden structure"],
    "farmyard": ["farm", "smallholding", "farmyard", "poultry", "chicken", "barn"],
    "tourism_leisure_timber": ["tourism", "leisure", "campsite", "wilderness hut", "nature reserve"],
}


def _flatten_text(obj: Any) -> str:
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

    walk(obj)
    return " | ".join(parts).lower()


def expected_classes(evidence_attrs: dict[str, Any] | Any) -> list[str]:
    """Which feature classes does this evidence's text plausibly imply?

    Accepts a `contracts.Attributes`/`Evidence`-shaped dict OR the raw
    evidence dict (either works — everything is just flattened to text).
    """
    if hasattr(evidence_attrs, "to_dict"):
        evidence_attrs = evidence_attrs.to_dict()
    text = _flatten_text(evidence_attrs)
    hits = []
    for cls, keywords in _CLASS_TRIGGERS.items():
        if any(kw in text for kw in keywords):
            hits.append(cls)
    return hits


def _bbox_to_overpass(bbox: tuple[float, float, float, float]) -> str:
    """(west, south, east, north) -> Overpass QL bbox string 'south,west,north,east'."""
    w, s, e, n = bbox
    return f"{s},{w},{n},{e}"


def build_overpass_query(
    evidence_attrs: dict[str, Any] | Any,
    bbox: tuple[float, float, float, float],
    *,
    classes: list[str] | None = None,
    timeout_s: int = 25,
) -> tuple[str, list[str]]:
    """Build an Overpass QL query from evidence attributes within `bbox`.

    Returns (query_text, classes_queried). If no evidence attribute maps to
    any queryable class, query_text is "" and classes_queried is [] — the
    caller should skip the network call entirely (see retrieve_candidates).
    """
    classes = classes if classes is not None else expected_classes(evidence_attrs)
    bbox_str = _bbox_to_overpass(bbox)
    clauses: list[str] = []
    for cls_name, tag_pairs in FEATURE_CLASSES:
        if cls_name not in classes:
            continue
        for key, value in tag_pairs:
            clauses.append(f'nwr["{key}"="{value}"]({bbox_str});')
    if not clauses:
        return "", []
    query = f"[out:json][timeout:{timeout_s}];(" + "".join(clauses) + f");out center tags {_MAX_ELEMENTS};"
    return query, classes


def _overpass_query(q: str) -> dict[str, Any]:
    """POST an Overpass QL query, retrying across public mirrors.

    Copied/adapted from apps/api/app/intel/lod1.py._overpass_query (same
    mirror list + backoff idea) — kept self-contained here (stdlib urllib
    only, no app.config import) per the apps/ml <-> apps/api boundary.
    Raises only if every mirror fails; callers must catch and degrade.
    """
    override = os.environ.get("GEOLOC_OVERPASS_URL", "").strip()
    endpoints = [override] if override else _OVERPASS_ENDPOINTS

    data = urllib.parse.urlencode({"data": q}).encode()
    last_err: Exception | None = None
    for i, endpoint in enumerate(endpoints):
        req = urllib.request.Request(
            endpoint, data=data, headers={"User-Agent": "osint-geolocate-research/1.0"}
        )
        try:
            with urllib.request.urlopen(req, timeout=_MIRROR_TIMEOUT_S) as resp:
                return json.loads(resp.read())
        except Exception as e:  # 429, timeout, transient DNS, bad JSON — try the next mirror
            last_err = e
            log.warning("Overpass mirror %s failed (%d/%d): %s", endpoint, i + 1, len(endpoints), e)
            if i < len(endpoints) - 1:
                time.sleep(_MIRROR_BACKOFF_S)
    raise RuntimeError(f"all Overpass mirrors failed: {last_err}")


def fetch_osm_features(query: str) -> tuple[list[dict[str, Any]], str | None]:
    """Run `query` against Overpass. Returns (elements, error) — error is None
    on success; on ANY failure, elements is [] and error carries the reason.
    Never raises: Stage C2 must degrade gracefully, never crash the pipeline.
    """
    if not query:
        return [], None
    try:
        data = _overpass_query(query)
    except Exception as e:  # noqa: BLE001 - intentionally broad: any failure degrades gracefully
        return [], str(e)
    return data.get("elements", []), None


def _classify_tags(tags: dict[str, str]) -> str | None:
    for cls_name, tag_pairs in FEATURE_CLASSES:
        for key, value in tag_pairs:
            if tags.get(key) == value:
                return cls_name
    return None


def _element_lonlat(el: dict[str, Any]) -> tuple[float, float] | None:
    if "lat" in el and "lon" in el:
        return float(el["lon"]), float(el["lat"])
    center = el.get("center")
    if center and "lat" in center and "lon" in center:
        return float(center["lon"]), float(center["lat"])
    return None


def cluster_and_score(
    elements: list[dict[str, Any]],
    *,
    cell_km: float = 1.0,
    max_candidates: int = 20,
) -> list[dict[str, Any]]:
    """Bucket elements into ~cell_km grid cells and score each cell by how
    many INDEPENDENT feature classes co-occur in it (spec: "Score candidates
    by how many independent features co-occur within ~1 km").

    Pure function (no network) — this is what test_osm.py exercises offline
    against a recorded fixture.
    """
    cells: dict[tuple[int, int], dict[str, Any]] = {}
    for el in elements:
        ll = _element_lonlat(el)
        if ll is None:
            continue
        lon, lat = ll
        tags = el.get("tags") or {}
        cls = _classify_tags(tags)
        if cls is None:
            continue
        # Grid cell size in degrees at this latitude — lon degrees shrink
        # with cos(lat); lat degrees are ~constant (~111.32 km).
        lat_deg = cell_km / 111.32
        lon_deg = cell_km / max(1e-6, 111.32 * math.cos(math.radians(lat)))
        cell_id = (round(lat / lat_deg), round(lon / lon_deg))
        cell = cells.setdefault(
            cell_id,
            {"lats": [], "lons": [], "classes": {}, "sample_tags": {}},
        )
        cell["lats"].append(lat)
        cell["lons"].append(lon)
        cell["classes"].setdefault(cls, 0)
        cell["classes"][cls] += 1
        cell["sample_tags"].setdefault(cls, tags)

    out: list[dict[str, Any]] = []
    for cell in cells.values():
        n_classes = len(cell["classes"])
        n_features = sum(cell["classes"].values())
        # Primary signal = how many INDEPENDENT classes co-occur; small
        # density bonus (more instances of a class) as a tie-break only.
        score = float(n_classes) + 0.1 * min(n_features, 20) / 20.0
        clat = sum(cell["lats"]) / len(cell["lats"])
        clon = sum(cell["lons"]) / len(cell["lons"])
        sources = [f"C2:{cls}" for cls in sorted(cell["classes"])]
        evidence_bits = [f"{cls}x{count}" for cls, count in sorted(cell["classes"].items())]
        out.append(
            {
                "lat": round(clat, 6),
                "lon": round(clon, 6),
                "radius_m": cell_km * 1000.0 / 2.0,
                "score": round(score, 3),
                "sources": sources,
                "evidence": "OSM co-occurring features: " + ", ".join(evidence_bits),
            }
        )
    out.sort(key=lambda c: c["score"], reverse=True)
    return out[:max_candidates]


def retrieve_candidates(
    evidence_attrs: dict[str, Any] | Any,
    bbox: tuple[float, float, float, float],
    *,
    cell_km: float = 1.0,
    max_candidates: int = 20,
    timeout_s: int = 25,
) -> tuple[list[Any], dict[str, Any]]:
    """Top-level Stage C2 entrypoint: evidence + prior bbox -> ranked AOI candidates.

    Returns (candidates, meta). `candidates` is a list of
    `contracts.Candidate` (or plain dicts if contracts.py is unavailable),
    schema-matching candidates.json exactly. `meta` carries diagnostics
    (the query text, element/candidate counts, any error) for logging/CLI —
    it is intentionally NOT part of the on-disk candidates.json shape.
    """
    query_bbox, clipped = _clip_bbox_to_max_span(bbox)
    query, classes = build_overpass_query(evidence_attrs, query_bbox, timeout_s=timeout_s)
    meta: dict[str, Any] = {
        "query": query,
        "classes_queried": classes,
        "error": None,
        "requested_bbox": list(bbox),
        "query_bbox": list(query_bbox),
        "bbox_clipped": clipped,
    }
    if clipped:
        log.info(
            "Stage C2: prior bbox %s exceeds the %.2f-deg query-span cap, clipped to %s to keep "
            "Overpass responsive", bbox, _MAX_QUERY_SPAN_DEG, query_bbox,
        )

    if not query:
        meta["note"] = (
            "no evidence attribute mapped to a queryable OSM feature class "
            "(forest/pasture/timber-structure/farmyard/tourism) — skipping Overpass call"
        )
        log.info("Stage C2: %s", meta["note"])
        return [], meta

    t0 = time.monotonic()
    elements, error = fetch_osm_features(query)
    meta["elapsed_s"] = round(time.monotonic() - t0, 2)
    meta["element_count"] = len(elements)

    if error is not None:
        meta["error"] = error
        meta["note"] = f"Overpass unavailable ({error}) — returning empty candidate list, not crashing"
        log.warning("Stage C2: %s", meta["note"])
        return [], meta

    scored = cluster_and_score(elements, cell_km=cell_km, max_candidates=max_candidates)
    meta["note"] = f"{len(elements)} raw OSM elements -> {len(scored)} scored ~{cell_km}km AOI cell(s)"

    candidates: list[Any] = []
    for row in scored:
        if Candidate is not None:
            candidates.append(Candidate(**row))
        else:  # pragma: no cover - contracts.py not yet present
            candidates.append(row)
    return candidates, meta


def _score_of(c: Any) -> float:
    return float(c.get("score", 0.0)) if isinstance(c, dict) else float(getattr(c, "score", 0.0))


def search(
    evidence: list[Any],
    priors: list[Any],
    *,
    top_priors: int = 3,
    cell_km: float = 1.0,
) -> list[Any]:
    """Call-site contract entrypoint for pipeline.py's Stage C2 (spec §5/§6):
    ``retrieval.osm.search(evidence, priors) -> list[Candidate]``.

    Fans out :func:`retrieve_candidates` over every eligible evidence photo
    x the top `top_priors` geo-prior regions (bounds live Overpass calls
    when many regions/photos are in play — priors are already ranked
    descending by Stage B, so this keeps the highest-probability regions)
    and flattens the results into one score-sorted candidate list.
    """
    if not priors:
        log.info("Stage C2 search(): no geo_prior regions supplied — nothing to query, returning [].")
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
            log.info("Stage C2 search(): %s x region=%s -> %s", photo, region, meta.get("note"))
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
    candidates, meta = retrieve_candidates(evidence.get("attributes", evidence), tuple(args.bbox), cell_km=args.cell_km)

    print(json.dumps(meta, indent=2))
    if dump_candidates is not None:
        dump_candidates(candidates, args.out)
    else:  # pragma: no cover
        args.out.write_text(json.dumps(candidates, indent=2), encoding="utf-8")
    print(f"wrote {len(candidates)} candidate(s) -> {args.out}")


if __name__ == "__main__":
    main()
