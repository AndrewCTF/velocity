"""Shared types for the fusion engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass
class Observation:
    id: str
    source: str
    t: float  # epoch seconds
    lon: float
    lat: float
    emits_kind: Literal[
        "vessel", "aircraft", "satellite", "emitter",
        "event", "outage", "detection", "quake", "fire",
    ]
    attrs: dict[str, Any] = field(default_factory=dict)


@dataclass
class Alert:
    id: str
    rule_id: str
    severity: Literal["info", "low", "medium", "high", "critical"]
    t: float
    lon: float
    lat: float
    confidence: float
    message: str
    contributing: list[str] = field(default_factory=list)
    # The user whose private watch rule fired this alert; None = system-wide
    # (correlation rules, feeds). Server-side only: never serialized, used by
    # /api/alerts and /ws/alerts to keep one user's geofence hits from another
    # in multi-user mode (ASVS V8.2.2).
    owner: str | None = None

    def visible_to(self, user_id: str | None) -> bool:
        return self.owner is None or self.owner == user_id

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "ruleId": self.rule_id,
            "severity": self.severity,
            "t": int(self.t * 1000),
            "geom": {"type": "Point", "coordinates": [self.lon, self.lat]},
            "confidence": self.confidence,
            "message": self.message,
            "contributingObservations": self.contributing,
        }
