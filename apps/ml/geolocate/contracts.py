"""Data contracts for the photo-geolocation pipeline (spec §4).

Every stage reads/writes only these JSON shapes, so stages parallelise across
builders with no shared-file contention:

  evidence/{photo}.json  -- per-photo Stage A output      (this module's ``Evidence``)
  geo_prior.json          -- Stage B output, a JSON array  (``GeoPrior``)
  candidates.json         -- Stage C output, a JSON array  (``Candidate``)
  result.geojson + geo_assessment.md -- Stage E output (plain FeatureCollection /
    markdown, not modeled as dataclasses -- they have no downstream JSON reader).

Dataclasses are the in-memory representation; ``to_dict``/``from_dict`` (and the
file helpers below) are the stable wire format other stages depend on. Keep
this module free of numpy/PIL/etc. -- it is imported by every stage.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class SceneType(str, Enum):
    """Router input (spec §1/§2 Stage D) -- decides which of Stages C/D fire.

    - OPEN: wide sightline, sky/horizon usually visible -- best case for
      cross-view retrieval (C1), skyline match (C3) and pose (D).
    - SEMI_OPEN: partial occlusion (hedgerow, forest edge, one building) but
      an open area is visible beyond it -- C1/D attempted, C3 unreliable.
    - CANOPY_INTERIOR: enclosed by tree canopy on most sides -- nadir
      satellite imagery shares ~zero visible geometry with the photo (spec
      §0.2, a physics limit). C1/C3/D are skipped-with-reason; only C2 (OSM
      structured features, which needs no visual match) still runs.
    - INDOOR: no outdoor geometry at all -- C1/C2/C3/D all skipped.
    """

    OPEN = "open"
    SEMI_OPEN = "semi_open"
    CANOPY_INTERIOR = "canopy_interior"
    INDOOR = "indoor"


@dataclass
class GpsCoord:
    lat: float
    lon: float
    alt_m: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"lat": self.lat, "lon": self.lon, "alt_m": self.alt_m}

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> GpsCoord | None:
        if not d:
            return None
        return cls(lat=float(d["lat"]), lon=float(d["lon"]), alt_m=d.get("alt_m"))


@dataclass
class ExifData:
    """GPS, timestamp, camera, orientation, lens focal (spec §2 Stage A)."""

    gps: GpsCoord | None = None
    ts: str | None = None
    camera: str | None = None
    orientation: int | None = None
    focal_length_mm: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "gps": self.gps.to_dict() if self.gps else None,
            "ts": self.ts,
            "camera": self.camera,
            "orientation": self.orientation,
            "focal_length_mm": self.focal_length_mm,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> ExifData:
        d = d or {}
        return cls(
            gps=GpsCoord.from_dict(d.get("gps")),
            ts=d.get("ts"),
            camera=d.get("camera"),
            orientation=d.get("orientation"),
            focal_length_mm=d.get("focal_length_mm"),
        )


@dataclass
class SunCue:
    shadow_az_deg: float | None = None
    solar_elev_deg: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"shadow_az_deg": self.shadow_az_deg, "solar_elev_deg": self.solar_elev_deg}

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> SunCue:
        d = d or {}
        return cls(shadow_az_deg=d.get("shadow_az_deg"), solar_elev_deg=d.get("solar_elev_deg"))


@dataclass
class Attributes:
    """Structured scene slots (spec §2 Stage A). Fields this build's classical
    heuristics cannot fill (OCR/sun-shadow/species/architecture require a VLM
    or a later wave) stay at their empty default rather than a guessed value --
    the contract carries the key so downstream stages don't need a schema
    migration when a later wave populates it."""

    biome: str | None = None
    architecture: dict[str, Any] = field(default_factory=dict)
    vegetation: list[str] = field(default_factory=list)
    husbandry: list[str] = field(default_factory=list)
    signage_text: list[str] = field(default_factory=list)
    language: str | None = None
    driving_side: str | None = None
    sun: SunCue = field(default_factory=SunCue)
    terrain_slope: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "biome": self.biome,
            "architecture": self.architecture,
            "vegetation": self.vegetation,
            "husbandry": self.husbandry,
            "signage_text": self.signage_text,
            "language": self.language,
            "driving_side": self.driving_side,
            "sun": self.sun.to_dict(),
            "terrain_slope": self.terrain_slope,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> Attributes:
        d = d or {}
        return cls(
            biome=d.get("biome"),
            architecture=dict(d.get("architecture") or {}),
            vegetation=list(d.get("vegetation") or []),
            husbandry=list(d.get("husbandry") or []),
            signage_text=list(d.get("signage_text") or []),
            language=d.get("language"),
            driving_side=d.get("driving_side"),
            sun=SunCue.from_dict(d.get("sun")),
            terrain_slope=d.get("terrain_slope"),
        )


@dataclass
class Evidence:
    """``evidence/{photo}.json`` -- the ONLY contract downstream stages read
    from Stage A (spec §2 Stage A, §4)."""

    photo: str
    phash: str
    exif: ExifData
    scene_type: SceneType
    caption: str | None
    attributes: Attributes
    confidence_notes: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "photo": self.photo,
            "phash": self.phash,
            "exif": self.exif.to_dict(),
            "scene_type": self.scene_type.value,
            "caption": self.caption,
            "attributes": self.attributes.to_dict(),
            "confidence_notes": self.confidence_notes,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Evidence:
        return cls(
            photo=d["photo"],
            phash=d["phash"],
            exif=ExifData.from_dict(d.get("exif")),
            scene_type=SceneType(d["scene_type"]),
            caption=d.get("caption"),
            attributes=Attributes.from_dict(d.get("attributes")),
            confidence_notes=d.get("confidence_notes", ""),
        )

    def to_json(self, *, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_json(cls, text: str) -> Evidence:
        return cls.from_dict(json.loads(text))

    def save(self, path: str | Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.to_json() + "\n", encoding="utf-8")
        return path

    @classmethod
    def load(cls, path: str | Path) -> Evidence:
        return cls.from_json(Path(path).read_text(encoding="utf-8"))


@dataclass
class GeoPrior:
    """One row of ``geo_prior.json`` (Stage B output, spec §4)."""

    region: str
    bbox: list[float]  # [west, south, east, north]
    p: float
    rationale: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"region": self.region, "bbox": list(self.bbox), "p": self.p, "rationale": self.rationale}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> GeoPrior:
        return cls(region=d["region"], bbox=list(d["bbox"]), p=float(d["p"]), rationale=d.get("rationale", ""))


@dataclass
class Candidate:
    """One row of ``candidates.json`` (Stage C output, spec §4)."""

    lat: float
    lon: float
    radius_m: float
    score: float
    sources: list[str] = field(default_factory=list)
    evidence: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "lat": self.lat,
            "lon": self.lon,
            "radius_m": self.radius_m,
            "score": self.score,
            "sources": list(self.sources),
            "evidence": self.evidence,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Candidate:
        return cls(
            lat=float(d["lat"]),
            lon=float(d["lon"]),
            radius_m=float(d["radius_m"]),
            score=float(d["score"]),
            sources=list(d.get("sources") or []),
            evidence=d.get("evidence", ""),
        )


def _dump_list(items: list[Any], path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([it.to_dict() for it in items], indent=2) + "\n", encoding="utf-8")
    return path


def dump_geo_priors(priors: list[GeoPrior], path: str | Path) -> Path:
    return _dump_list(priors, path)


def load_geo_priors(path: str | Path) -> list[GeoPrior]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return [GeoPrior.from_dict(d) for d in data]


def dump_candidates(candidates: list[Candidate], path: str | Path) -> Path:
    return _dump_list(candidates, path)


def load_candidates(path: str | Path) -> list[Candidate]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return [Candidate.from_dict(d) for d in data]
