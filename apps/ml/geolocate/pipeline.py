"""Orchestrator + router + CLI (spec §1, §5).

    python -m geolocate.pipeline <img_or_dir> -o <outdir>

Runs Stage A (forensics) on every input photo, groups near-duplicates,
decides -- per photo, and with a logged reason for every decision, never a
silent skip -- which of Stages B/C/D would be attempted, and writes:

    <outdir>/evidence/{photo}.json   Stage A contract (spec §4)
    <outdir>/dedup_groups.json       phash near-dup clusters
    <outdir>/router.json             per-photo stage attempt/skip + reason
    <outdir>/geo_prior.json          Stage B output, IF that stage is present
    <outdir>/candidates.json         Stage C output, IF that stage is present
    <outdir>/result.geojson          proven-only points (EXIF GPS); Stage E
                                      supersedes this once it lands
    <outdir>/geo_assessment.md       human report (stub until Stage E lands)

Stages B-E are built by other agents in parallel (spec §6) and may not exist
yet. Each is imported LAZILY and its absence is tolerated (and reported) --
see ``_CALL_SITE_CONTRACT`` below for the exact entry points this orchestrator
expects each stage module to expose once it lands.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from . import forensics
from .contracts import Candidate, Evidence, GeoPrior, SceneType, dump_candidates, dump_geo_priors

# --------------------------------------------------------------------------- #
# Call-site contract for Stages B/C/D/E (not yet built -- do not block on them)
# --------------------------------------------------------------------------- #
# Each stage module, once it exists, is expected to expose:
#   geoprior.fuse(evidence: list[Evidence]) -> list[GeoPrior]                      (B)
#   retrieval.osm.search(evidence, priors) -> list[Candidate]                      (C2)
#   retrieval.crossview.search(evidence, priors) -> list[Candidate]                (C1)
#   retrieval.terrain.search(evidence, priors) -> list[Candidate]                  (C3)
#   pose.dsm_fallback.estimate(evidence, candidates) -> dict | None                (D2)
#   pose.splat_pose.register(...) -> RegisterResult   (already landed; different
#       call convention -- CLI/splat-specific, invoked by Stage D's own glue once
#       that glue exists, not directly from here)
#   report.write(evidence, groups, router, priors, candidates, outdir) -> Path    (E)
# This module imports each lazily and tolerates ImportError/AttributeError so the
# CLI runs standalone today and picks each stage up automatically as it lands.
# --------------------------------------------------------------------------- #


@dataclass
class RouterDecision:
    """Per-photo record of which later stages were attempted and why (spec §1:
    "No silent skips -- every skip is logged")."""

    photo: str
    scene_type: str
    gps_short_circuit: bool
    attempt_c1_crossview: bool
    attempt_c2_osm: bool
    attempt_c3_terrain: bool
    attempt_d_pose: bool
    reasons: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def route_scene(ev: Evidence) -> RouterDecision:
    """Router: scene_type -> which of Stages C/D are attempted (spec §1, §2
    Stage D). C2 (OSM structured match) needs no visual match, so it runs for
    any outdoor scene; C1/C3/D need real shared geometry with satellite
    imagery and are skipped-with-reason under canopy or indoors (spec §0.2)."""
    reasons: dict[str, str] = {}
    gps_present = ev.exif.gps is not None
    if gps_present:
        reasons["gps"] = "EXIF GPS present -> proven, Stage E can short-circuit (spec §2 Stage A)."

    visual_ok = ev.scene_type in (SceneType.OPEN, SceneType.SEMI_OPEN)
    c1 = visual_ok
    reasons["c1_crossview"] = (
        "attempted: open/semi-open scene has a visible surface for ground<->aerial embedding match."
        if c1
        else f"skipped: scene_type={ev.scene_type.value} shares ~zero visible geometry with nadir "
        "imagery under canopy/indoors -- a physics limit, not an implementation gap (spec §0.2)."
    )

    c2 = ev.scene_type != SceneType.INDOOR
    reasons["c2_osm"] = (
        "attempted: structured OSM tag co-occurrence needs no visual match, works for any outdoor scene."
        if c2
        else "skipped: indoor scene has no outdoor structured-feature correlate."
    )

    c3 = ev.scene_type == SceneType.OPEN
    reasons["c3_terrain"] = (
        "attempted: open scene is likely to show a horizon/ridgeline for DEM skyline matching."
        if c3
        else f"skipped: scene_type={ev.scene_type.value} is unlikely to show a usable, unobstructed horizon."
    )

    d = visual_ok
    reasons["d_pose"] = (
        "eligible (pending a surviving Stage C candidate): scene_type is open/semi-open (spec §2 Stage D)."
        if d
        else f"skipped: scene_type={ev.scene_type.value} -- router only invokes D for open/semi-open scenes."
    )

    return RouterDecision(
        photo=ev.photo,
        scene_type=ev.scene_type.value,
        gps_short_circuit=gps_present,
        attempt_c1_crossview=c1,
        attempt_c2_osm=c2,
        attempt_c3_terrain=c3,
        attempt_d_pose=d,
        reasons=reasons,
    )


# --------------------------------------------------------------------------- #
# Lazy, absence-tolerant call sites for Stages B/C/D
# --------------------------------------------------------------------------- #


def _maybe_run_stage_b(evidence: list[Evidence], outdir: Path, notes: list[str]) -> list[GeoPrior] | None:
    try:
        from . import geoprior  # type: ignore[import-not-found]
    except ImportError:
        notes.append("Stage B (geo-prior fusion): skipped -- geolocate.geoprior not present in this build yet.")
        return None
    try:
        priors: list[GeoPrior] = geoprior.fuse(evidence)
    except Exception as exc:  # pragma: no cover - defensive, Stage B not built here
        notes.append(f"Stage B (geo-prior fusion): raised {exc!r}, skipped.")
        return None
    dump_geo_priors(priors, outdir / "geo_prior.json")
    notes.append(f"Stage B (geo-prior fusion): {len(priors)} region(s) -> geo_prior.json.")
    return priors


def _maybe_run_stage_c(
    evidence: list[Evidence],
    priors: list[GeoPrior] | None,
    router: dict[str, RouterDecision],
    outdir: Path,
    notes: list[str],
) -> list[Candidate]:
    candidates: list[Candidate] = []
    eligible = [ev for ev in evidence if router[ev.photo].attempt_c2_osm]
    try:
        from .retrieval import osm  # type: ignore[import-not-found]
    except ImportError:
        notes.append("Stage C2 (OSM retrieval): skipped -- geolocate.retrieval.osm not present in this build yet.")
    else:
        try:
            candidates.extend(osm.search(eligible, priors or []))
            notes.append(f"Stage C2 (OSM retrieval): ran on {len(eligible)} eligible photo(s).")
        except Exception as exc:  # pragma: no cover - defensive, Stage C not built here
            notes.append(f"Stage C2 (OSM retrieval): raised {exc!r}, skipped.")

    eligible_c1 = [ev for ev in evidence if router[ev.photo].attempt_c1_crossview]
    try:
        from .retrieval import crossview  # type: ignore[import-not-found]
    except ImportError:
        notes.append(
            "Stage C1 (cross-view embedding): skipped -- geolocate.retrieval.crossview not present in this build yet."
        )
    else:
        try:
            candidates.extend(crossview.search(eligible_c1, priors or []))
            notes.append(f"Stage C1 (cross-view embedding): ran on {len(eligible_c1)} eligible photo(s).")
        except Exception as exc:  # pragma: no cover - defensive, Stage C not built here
            notes.append(f"Stage C1 (cross-view embedding): raised {exc!r}, skipped.")

    eligible_c3 = [ev for ev in evidence if router[ev.photo].attempt_c3_terrain]
    try:
        from .retrieval import terrain  # type: ignore[import-not-found]
    except ImportError:
        notes.append(
            "Stage C3 (terrain/skyline): skipped -- geolocate.retrieval.terrain not present in this build yet."
        )
    else:
        try:
            candidates.extend(terrain.search(eligible_c3, priors or []))
            notes.append(f"Stage C3 (terrain/skyline): ran on {len(eligible_c3)} eligible photo(s).")
        except Exception as exc:  # pragma: no cover - defensive, Stage C not built here
            notes.append(f"Stage C3 (terrain/skyline): raised {exc!r}, skipped.")

    if candidates:
        dump_candidates(candidates, outdir / "candidates.json")
    return candidates


def _maybe_run_stage_d(
    evidence: list[Evidence],
    candidates: list[Candidate],
    router: dict[str, RouterDecision],
    outdir: Path,
    notes: list[str],
) -> None:
    eligible = [ev for ev in evidence if router[ev.photo].attempt_d_pose]
    if not eligible or not candidates:
        notes.append(
            "Stage D (precise pose): skipped -- "
            f"{'no open/semi-open photo' if not eligible else 'no surviving Stage C candidate'} (spec §2 Stage D)."
        )
        return
    try:
        from .pose import dsm_fallback  # type: ignore[import-not-found]
    except ImportError:
        notes.append(
            "Stage D2 (DSM fallback pose): skipped -- geolocate.pose.dsm_fallback not present in this build yet."
        )
    else:
        try:
            for ev in eligible:
                dsm_fallback.estimate(ev, candidates)
            notes.append(f"Stage D2 (DSM fallback pose): attempted on {len(eligible)} eligible photo(s).")
        except Exception as exc:  # pragma: no cover - defensive, Stage D2 not built here
            notes.append(f"Stage D2 (DSM fallback pose): raised {exc!r}, skipped.")
    notes.append(
        "Stage D1 (splat render-and-compare pose): geolocate.pose.splat_pose exists but needs a built scene "
        "splat + the fusion CUDA venv -- not invoked automatically here; see pose/splat_pose.py --self-check."
    )


def _maybe_run_stage_e(
    evidence: list[Evidence],
    groups: list[list[str]],
    router: dict[str, RouterDecision],
    geo_priors: list[GeoPrior] | None,
    candidates: list[Candidate],
    outdir: Path,
    notes: list[str],
) -> tuple[Path, Path]:
    """Stage E (report generation): calibrated confidence + verified consistency.
    Tries to call report.write() if available, falls back to stub if absent or raises."""
    try:
        from . import report  # type: ignore[import-not-found]
    except ImportError:
        notes.append("Stage E (report generation): skipped -- geolocate.report not present in this build yet.")
        geojson_path = _write_proven_geojson(evidence, outdir)
        report_path = _write_stub_report(evidence, groups, router, outdir, notes)
        return report_path, geojson_path
    try:
        report_path = report.write(evidence, groups, router, geo_priors, candidates, outdir)
        geojson_path = outdir / "result.geojson"
        notes.append(f"Stage E (report generation): {report_path.name} written with calibrated confidence per level.")
        return report_path, geojson_path
    except Exception as exc:  # pragma: no cover - defensive, Stage E may have issues
        notes.append(f"Stage E (report generation): raised {exc!r}, falling back to stub.")
        geojson_path = _write_proven_geojson(evidence, outdir)
        report_path = _write_stub_report(evidence, groups, router, outdir, notes)
        return report_path, geojson_path


# --------------------------------------------------------------------------- #
# result.geojson (proven-only until Stage E lands) + stub geo_assessment.md
# --------------------------------------------------------------------------- #


def _write_proven_geojson(evidence: list[Evidence], outdir: Path) -> Path:
    """Stage E owns the real result.geojson (fused candidates + pose). Until it
    lands, the orchestrator still surfaces what's already PROVEN: any photo
    with EXIF GPS. Photos without it get no geometry yet -- no heuristic guess
    is plotted as a point."""
    features = []
    for ev in evidence:
        if ev.exif.gps is None:
            continue
        features.append(
            {
                "type": "Feature",
                "properties": {"photo": ev.photo, "source": "exif_gps", "confidence": "proven"},
                "geometry": {
                    "type": "Point",
                    "coordinates": [ev.exif.gps.lon, ev.exif.gps.lat],
                },
            }
        )
    geojson = {"type": "FeatureCollection", "features": features}
    path = outdir / "result.geojson"
    path.write_text(json.dumps(geojson, indent=2) + "\n", encoding="utf-8")
    return path


def _write_stub_report(
    evidence: list[Evidence],
    groups: list[list[str]],
    router: dict[str, RouterDecision],
    outdir: Path,
    notes: list[str],
) -> Path:
    photo_to_group = {photo: i for i, group in enumerate(groups) for photo in group}
    lines: list[str] = []
    lines.append("# Geo-assessment (Stage A skeleton run)")
    lines.append("")
    lines.append(f"Generated: {datetime.now(UTC).isoformat(timespec='seconds')}")
    lines.append(f"Input: {len(evidence)} photo(s) -> {len(groups)} unique scene(s) after phash dedup.")
    lines.append("")
    lines.append("## Verdict")
    lines.append("")
    lines.append(
        "No geolocation claim is made by this run. Only Stage A (forensics) plus whichever of "
        "Stages B/C/D happened to be present are wired in -- see Pipeline notes below for exactly "
        "which stages ran vs. were skipped and why."
    )
    lines.append("")
    lines.append("## Photos")
    lines.append("")
    lines.append("| photo | dedup group | scene_type | EXIF GPS | phash |")
    lines.append("|---|---|---|---|---|")
    for ev in evidence:
        gps = f"{ev.exif.gps.lat:.5f},{ev.exif.gps.lon:.5f}" if ev.exif.gps else "-"
        lines.append(
            f"| {ev.photo} | #{photo_to_group[ev.photo]} | {ev.scene_type.value} | {gps} | `{ev.phash}` |"
        )
    lines.append("")
    lines.append("## Near-duplicate groups (phash)")
    lines.append("")
    for i, group in enumerate(groups):
        tag = "duplicate/near-duplicate burst" if len(group) > 1 else "unique"
        lines.append(f"- group #{i} ({tag}): {', '.join(group)}")
    lines.append("")
    lines.append("## Router decisions (why later stages were/weren't attempted)")
    lines.append("")
    for ev in evidence:
        rd = router[ev.photo]
        lines.append(f"- **{ev.photo}** (scene_type={rd.scene_type})")
        for stage, reason in rd.reasons.items():
            lines.append(f"  - {stage}: {reason}")
    lines.append("")
    lines.append("## Pipeline notes")
    lines.append("")
    for note in notes:
        lines.append(f"- {note}")
    lines.append("")
    lines.append("## Honest limits")
    lines.append("")
    lines.append(
        "- `canopy_interior` photos cannot be localised by nadir-satellite-based stages (C1/C3/D) -- "
        "this is a physics limit (no shared visible geometry between a nadir view and an under-canopy "
        "photo), not an implementation gap. See docs/photo-geolocation-pipeline.md §0.2."
    )
    lines.append(
        "- scene_type is a classical-feature heuristic (colour/brightness/edge statistics only, no "
        "model) -- treat it as `heuristic`, not `proven`, until Stage E's confidence calibration lands."
    )
    lines.append(
        "- result.geojson currently only plots photos with EXIF GPS (`proven`); heuristic scene_type "
        "does not produce a location and is intentionally not plotted as a point."
    )
    path = outdir / "geo_assessment.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #


@dataclass
class PipelineResult:
    evidence: list[Evidence]
    dedup_groups: list[list[str]]
    router: dict[str, RouterDecision]
    geo_priors: list[GeoPrior] | None
    candidates: list[Candidate]
    notes: list[str]
    report_path: Path
    geojson_path: Path


def run_pipeline(
    images: list[Path],
    outdir: Path,
    *,
    use_vlm: bool = False,
    dedup_threshold: int = forensics.DEFAULT_DEDUP_THRESHOLD,
    attributes_json: str | Path | None = None,
) -> PipelineResult:
    outdir.mkdir(parents=True, exist_ok=True)
    notes: list[str] = []

    attributes_overrides: dict[str, dict] | None = None
    if attributes_json:
        attributes_overrides = json.loads(Path(attributes_json).read_text(encoding="utf-8"))
        notes.append(
            f"Attributes overrides: loaded {len(attributes_overrides)} photo(s) from "
            f"{attributes_json} -- VLM/analyst semantic attributes; any vision model, or the "
            "forensics.caption_via_vlm hook, can produce this file (spec §2 Stage A)."
        )

    evidence, groups = forensics.run_stage_a_batch(
        images, use_vlm=use_vlm, dedup_threshold=dedup_threshold, attributes_overrides=attributes_overrides
    )

    evidence_dir = outdir / "evidence"
    for ev in evidence:
        ev.save(evidence_dir / f"{Path(ev.photo).stem}.json")
    notes.append(f"Stage A (forensics): {len(evidence)} photo(s) -> evidence/*.json.")

    (outdir / "dedup_groups.json").write_text(json.dumps(groups, indent=2) + "\n", encoding="utf-8")
    dup_groups = [g for g in groups if len(g) > 1]
    notes.append(
        f"Near-dup grouping (phash, threshold={dedup_threshold}/64 bits): "
        f"{len(groups)} unique scene(s) from {len(evidence)} photo(s) "
        f"({len(dup_groups)} duplicate/near-duplicate cluster(s))."
    )

    router = {ev.photo: route_scene(ev) for ev in evidence}
    (outdir / "router.json").write_text(
        json.dumps({photo: rd.to_dict() for photo, rd in router.items()}, indent=2) + "\n", encoding="utf-8"
    )

    geo_priors = _maybe_run_stage_b(evidence, outdir, notes)
    candidates = _maybe_run_stage_c(evidence, geo_priors, router, outdir, notes)
    _maybe_run_stage_d(evidence, candidates, router, outdir, notes)

    report_path, geojson_path = _maybe_run_stage_e(evidence, groups, router, geo_priors, candidates, outdir, notes)

    return PipelineResult(
        evidence=evidence,
        dedup_groups=groups,
        router=router,
        geo_priors=geo_priors,
        candidates=candidates,
        notes=notes,
        report_path=report_path,
        geojson_path=geojson_path,
    )


def discover_images(input_path: Path) -> list[Path]:
    """A single image file, or every image directly inside a directory
    (non-recursive -- matches how the repo's test_images/ set is laid out),
    sorted for a deterministic run order."""
    if input_path.is_file():
        return [input_path]
    if input_path.is_dir():
        return sorted(
            p for p in input_path.iterdir() if p.is_file() and p.suffix.lower() in forensics.IMAGE_EXTENSIONS
        )
    return []


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m geolocate.pipeline",
        description="Photo-geolocation pipeline orchestrator (Stage A forensics + router).",
    )
    p.add_argument("input", help="image file or directory of images")
    p.add_argument("-o", "--outdir", required=True, help="output directory")
    p.add_argument(
        "--vlm", action="store_true", help="attempt the optional VLM caption hook (no-op if unconfigured)"
    )
    p.add_argument(
        "--dedup-threshold",
        type=int,
        default=forensics.DEFAULT_DEDUP_THRESHOLD,
        help="phash Hamming-distance threshold (of 64 bits) for near-duplicate grouping",
    )
    p.add_argument(
        "--attributes-json",
        help=(
            "path to a JSON file of {photo_filename: {\"caption\": ..., \"attributes\": {...}}} "
            "(§4 Attributes shape) to inject into Stage A -- VLM/analyst semantic attributes; any "
            "vision model, or the caption_via_vlm hook, can produce it. Overrides the heuristic "
            "biome guess (and the VLM caption, if --vlm is also set) for the listed photos."
        ),
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    input_path = Path(args.input)
    images = discover_images(input_path)
    if not images:
        print(f"no images found under {input_path}", file=sys.stderr)
        return 1

    result = run_pipeline(
        images,
        Path(args.outdir),
        use_vlm=args.vlm,
        dedup_threshold=args.dedup_threshold,
        attributes_json=args.attributes_json,
    )

    print(f"Stage A: {len(result.evidence)} photo(s) -> {len(result.dedup_groups)} unique scene(s)")
    for ev in result.evidence:
        print(f"  {ev.photo}: scene_type={ev.scene_type.value} phash={ev.phash}")
    for note in result.notes:
        print(f"note: {note}")
    print(f"evidence written to {Path(args.outdir) / 'evidence'}")
    print(f"report written to {result.report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
