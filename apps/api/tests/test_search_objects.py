"""Faceted object search (filter_objects) — the Gotham object-search backing.

Pure filter, no store/network: proves type + keyword + AOI bbox + time-window
facets compose, that per-type counts reflect the geo/time/keyword set (so the
UI dropdown shows live counts), and that antimeridian bboxes wrap.
"""

from __future__ import annotations

from app.correlate.types import Observation
from app.routes.search import filter_objects

NOW = 1_000_000.0


def _obs(id_: str, kind: str, lon: float, lat: float, t: float, **attrs) -> Observation:
    return Observation(id=id_, source="test", t=t, lon=lon, lat=lat, emits_kind=kind, attrs=attrs)


def _fixture() -> list[Observation]:
    return [
        _obs("aircraft:abc123", "aircraft", 10.0, 50.0, NOW - 5, callsign="DLH123"),
        _obs("aircraft:def456", "aircraft", 11.0, 51.0, NOW - 5000, callsign="AFR9"),  # old
        _obs("vessel:200000000", "vessel", 10.5, 50.5, NOW - 10, name="EVER GIVEN"),
        _obs("vessel:200000001", "vessel", -170.0, 5.0, NOW - 10, name="PACIFIC"),  # far east
        _obs("quake:us1", "quake", 12.0, 52.0, NOW - 20, name="M4.2"),
    ]


def test_type_and_facet_counts() -> None:
    out = filter_objects(_fixture(), type_="aircraft", q=None, bbox=None, since_s=None, now=NOW, limit=100)
    # results filtered to aircraft, but facet counts cover ALL matched types
    assert {r["kind"] for r in out["results"]} == {"aircraft"}
    assert out["by_type"] == {"aircraft": 2, "vessel": 2, "quake": 1}
    assert out["count"] == 2


def test_keyword_matches_attrs_and_id() -> None:
    out = filter_objects(_fixture(), type_="all", q="ever given", bbox=None, since_s=None, now=NOW, limit=100)
    assert [r["id"] for r in out["results"]] == ["vessel:200000000"]


def test_bbox_filters_geographically() -> None:
    # Box around central Europe only.
    bbox = (9.0, 49.0, 13.0, 53.0)
    out = filter_objects(_fixture(), type_="all", q=None, bbox=bbox, since_s=None, now=NOW, limit=100)
    ids = {r["id"] for r in out["results"]}
    assert "vessel:200000001" not in ids  # Pacific vessel excluded
    assert "aircraft:abc123" in ids and "quake:us1" in ids


def test_antimeridian_bbox_wraps() -> None:
    # min_lon 170 > max_lon -160 → wrap; should catch the -170 Pacific vessel.
    bbox = (170.0, 0.0, -160.0, 10.0)
    out = filter_objects(_fixture(), type_="all", q=None, bbox=bbox, since_s=None, now=NOW, limit=100)
    assert [r["id"] for r in out["results"]] == ["vessel:200000001"]


def test_time_window_excludes_stale() -> None:
    out = filter_objects(_fixture(), type_="aircraft", q=None, bbox=None, since_s=60.0, now=NOW, limit=100)
    ids = {r["id"] for r in out["results"]}
    assert "aircraft:abc123" in ids  # 5s old
    assert "aircraft:def456" not in ids  # 5000s old → outside 60s window


def test_newest_first_and_limit() -> None:
    out = filter_objects(_fixture(), type_="all", q=None, bbox=None, since_s=None, now=NOW, limit=2)
    assert len(out["results"]) == 2
    ts = [r["t"] for r in out["results"]]
    assert ts == sorted(ts, reverse=True)  # newest first
    assert out["count"] == 5  # count is pre-limit
