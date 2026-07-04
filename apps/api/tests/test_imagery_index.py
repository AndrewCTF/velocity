"""Unit tests for the entity↔imagery geotemporal index (intel/imagery_index.py)
and its route (GET /api/entity/{id}/imagery).

Hermetic: history.query_tracks + ondemand.search_aoi are mocked — NO network, NO
live Supabase, NO CDSE creds (conftest sets them ""). Covers: id parsing, track
bbox padding/clamp math, scene↔track overlap + nearest-time, manifest flattening
+ ordering, the full pipeline (not-trackable / history-off / no-track-in-window
retention caveat / Maxar match / Sentinel availability / catalog unreachable),
and the route (precedence over the catch-all, 400 on a bare id, the honest
retention note surfaced over HTTP).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from app.intel import imagery_index as II
from app.intel.geo import BBox

# ── parse_entity_id ──────────────────────────────────────────────────────────


def test_parse_entity_id_trackable_kinds() -> None:
    assert II.parse_entity_id("aircraft:4ca7b3") == ("aircraft", "4ca7b3")
    assert II.parse_entity_id("vessel:636092000") == ("vessel", "636092000")


def test_parse_entity_id_rejects_non_trackable_and_malformed() -> None:
    # quake/incident/sim have no position-history table to geolocate against
    assert II.parse_entity_id("quake:us6000abcd") is None
    assert II.parse_entity_id("incident:8f1c-uuid") is None
    assert II.parse_entity_id("sim:uav-12") is None
    # malformed
    assert II.parse_entity_id("noprefix") is None
    assert II.parse_entity_id("aircraft:") is None
    assert II.parse_entity_id("aircraft:   ") is None


# ── _track_bbox (padding, floor, runaway clamp) ──────────────────────────────


def test_track_bbox_pads_around_points() -> None:
    # Two close fixes near the equator; the bbox must CONTAIN both and be padded
    # outward (never clip the path).
    pts = [[10.0, 5.0, 1000.0, 0.0], [10.02, 5.02, 1010.0, 0.0]]
    bb = II._track_bbox(pts)
    assert bb is not None
    assert bb.min_lon < 10.0 and bb.min_lat < 5.0
    assert bb.max_lon > 10.02 and bb.max_lat > 5.02


def test_track_bbox_single_point_gets_minimum_area() -> None:
    bb = II._track_bbox([[0.0, 0.0, 1000.0, 0.0]])
    assert bb is not None
    # A single fix still yields a non-degenerate box (padding/floor applied).
    assert bb.max_lon > bb.min_lon
    assert bb.max_lat > bb.min_lat


def test_track_bbox_clamps_runaway_span() -> None:
    # A transcontinental track must not ask the catalog for a hemisphere — the
    # span is clamped to _MAX_AOI_SPAN_DEG and re-centred on the track centroid.
    pts = [[-120.0, 35.0, 1000.0, 0.0], [10.0, 50.0, 2000.0, 0.0]]
    bb = II._track_bbox(pts)
    assert bb is not None
    assert (bb.max_lon - bb.min_lon) <= II._MAX_AOI_SPAN_DEG + 1e-6
    assert (bb.max_lat - bb.min_lat) <= II._MAX_AOI_SPAN_DEG + 1e-6


def test_track_bbox_none_when_no_usable_points() -> None:
    assert II._track_bbox([]) is None
    assert II._track_bbox([[None, None]]) is None  # type: ignore[list-item]
    assert II._track_bbox([["x"]]) is None  # type: ignore[list-item]


# ── _scene_overlaps_track / _nearest_point_time ──────────────────────────────


def test_scene_overlaps_track_true_and_false() -> None:
    pts = [[10.0, 5.0, 100.0, 0.0], [10.1, 5.1, 200.0, 0.0]]
    # scene bbox covering the path
    assert II._scene_overlaps_track([9.5, 4.5, 10.5, 5.5], pts) is True
    # scene bbox far away (corner-only / disjoint) → dropped
    assert II._scene_overlaps_track([100.0, 60.0, 101.0, 61.0], pts) is False
    # no scene bbox → trust the catalog AOI filter (overlap assumed)
    assert II._scene_overlaps_track(None, pts) is True
    assert II._scene_overlaps_track([1.0, 2.0], pts) is True  # too-short bbox


def test_nearest_point_time_inside_scene() -> None:
    pts = [[10.0, 5.0, 100.0, 0.0], [10.1, 5.1, 200.0, 0.0]]
    # the scene only covers the 2nd fix's cell → returns t=200
    t = II._nearest_point_time([10.05, 5.05, 10.2, 5.2], pts)
    assert t == 200.0


def test_nearest_point_time_falls_back_to_first_fix() -> None:
    pts = [[10.0, 5.0, 100.0, 0.0]]
    # no point strictly inside this disjoint scene → fall back to first fix time
    t = II._nearest_point_time([80.0, 80.0, 81.0, 81.0], pts)
    assert t == 100.0


# ── _scenes_from_manifest (flatten + overlap filter + ordering) ──────────────


def _maxar_scene(sid: str, epoch: float, bbox: list[float]) -> dict[str, Any]:
    return {
        "id": sid,
        "datetime": II._iso_day(epoch) + "T00:00:00Z",
        "epoch": epoch,
        "bbox": bbox,
        "collection": f"https://x/{sid}.json",
    }


def test_scenes_from_manifest_orders_newest_first_sentinel_last() -> None:
    pts = [[10.0, 5.0, 1500.0, 0.0]]
    manifest = {
        "aoi": {"min_lon": 9.0, "min_lat": 4.0, "max_lon": 11.0, "max_lat": 6.0},
        "maxar": {
            "note": "VHR ~0.3-0.5 m; event-gated",
            "before_items": [_maxar_scene("old", 1000.0, [9.5, 4.5, 10.5, 5.5])],
            "after_items": [_maxar_scene("new", 2000.0, [9.5, 4.5, 10.5, 5.5])],
        },
        "sentinel": {"note": "10 m, global", "available": True, "layers": ["S2_L2A_TRUECOLOR"]},
    }
    matches = II._scenes_from_manifest(manifest, pts)
    # newest Maxar first, then older Maxar, then the availability-only Sentinel
    assert [m["id"] for m in matches[:2]] == ["new", "old"]
    assert matches[0]["provider"] == "maxar" and matches[0]["gsd_m"] == 0.5
    assert matches[-1]["provider"] == "sentinel" and matches[-1]["gsd_m"] == 10.0
    # the Maxar match carries the track-fix time where the scene looks
    assert matches[0]["overlap_t"] == 1500.0


def test_scenes_from_manifest_drops_non_overlapping_maxar() -> None:
    pts = [[10.0, 5.0, 1500.0, 0.0]]
    manifest = {
        "aoi": {"min_lon": 9.0, "min_lat": 4.0, "max_lon": 11.0, "max_lat": 6.0},
        "maxar": {
            "note": "n",
            # this scene's bbox is far from the single track fix → dropped
            "before_items": [_maxar_scene("disjoint", 1000.0, [80.0, 80.0, 81.0, 81.0])],
            "after_items": [],
        },
        "sentinel": {"available": False, "layers": []},
    }
    matches = II._scenes_from_manifest(manifest, pts)
    assert matches == []


def test_scenes_from_manifest_sentinel_only_when_available() -> None:
    pts = [[10.0, 5.0, 1500.0, 0.0]]
    manifest = {
        "aoi": {"min_lon": 9.0, "min_lat": 4.0, "max_lon": 11.0, "max_lat": 6.0},
        "maxar": {"note": "n", "before_items": [], "after_items": []},
        "sentinel": {"note": "10 m", "available": True, "layers": ["S2_L2A_TRUECOLOR"]},
    }
    matches = II._scenes_from_manifest(manifest, pts)
    assert len(matches) == 1
    assert matches[0]["provider"] == "sentinel"
    assert matches[0]["bbox"] == manifest["aoi"]
    assert matches[0]["epoch"] is None


# ── entity_imagery pipeline (async, mocked history + catalog) ────────────────


def _track(eid: str, points: list[list[float]], kind: str = "aircraft") -> dict[str, Any]:
    return {"tracks": [{"id": eid, "kind": kind, "points": points}]}


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


def test_entity_imagery_rejects_non_trackable_kind() -> None:
    out = _run(II.entity_imagery("quake:us6000abcd"))
    assert out["available"] is False
    assert out["matches"] == []
    assert out["best_source"] == "none"
    assert "aircraft" in out["note"] and "vessel" in out["note"]


def test_entity_imagery_history_disabled(monkeypatch) -> None:
    monkeypatch.setattr(II, "get_settings", lambda: _Settings(history_enabled=False))
    out = _run(II.entity_imagery("aircraft:abc123"))
    assert out["available"] is False
    assert "disabled" in out["note"].lower()


def test_entity_imagery_no_track_in_window_is_honest(monkeypatch) -> None:
    """An entity with NO fixes in the retention window must NOT silently return
    [] as if 'no imagery exists' — it must say the limit is retention."""
    monkeypatch.setattr(II, "get_settings", lambda: _Settings())

    async def empty_tracks(**kw: Any) -> dict[str, Any]:
        return {"tracks": []}

    monkeypatch.setattr(II.history, "query_tracks", empty_tracks)
    # search_aoi must NOT be called when there is no track — make it explode if so
    monkeypatch.setattr(II.ondemand, "search_aoi", _boom)

    out = _run(II.entity_imagery("aircraft:abc123"))
    assert out["available"] is True  # we COULD look — history is on
    assert out["matches"] == []
    assert out["track"] is None
    note = out["note"].lower()
    assert "no track" in note
    assert "retain" in note or "retention" in note  # the retention caveat


def test_entity_imagery_matches_maxar(monkeypatch) -> None:
    monkeypatch.setattr(II, "get_settings", lambda: _Settings())
    now = time.time()
    pts = [[10.0, 5.0, now - 3600, 0.0], [10.05, 5.05, now - 60, 0.0]]

    async def tracks(**kw: Any) -> dict[str, Any]:
        # query_tracks returns many ids; ours must be picked out
        return {
            "tracks": [
                {"id": "aircraft:other", "kind": "aircraft", "points": [[0, 0, now, 0]]},
                {"id": "aircraft:abc123", "kind": "aircraft", "points": pts},
            ]
        }

    async def manifest(aoi, before, after, window_days=14, commercial=False) -> dict[str, Any]:
        # aoi must be the (padded) track bbox, dates the track's day span
        assert isinstance(aoi, BBox)
        return {
            "aoi": aoi.as_dict(),
            "maxar": {
                "note": "VHR ~0.3-0.5 m; event-gated",
                "before_items": [_maxar_scene("m1", now - 7200, [9.9, 4.9, 10.2, 5.2])],
                "after_items": [],
            },
            "sentinel": {"available": False, "layers": []},
        }

    monkeypatch.setattr(II.history, "query_tracks", tracks)
    monkeypatch.setattr(II.ondemand, "search_aoi", manifest)

    out = _run(II.entity_imagery("aircraft:abc123"))
    assert out["available"] is True
    assert out["kind"] == "aircraft"
    assert out["track"]["points"] == 2
    assert out["best_source"] == "maxar"
    assert len(out["matches"]) == 1
    assert out["matches"][0]["provider"] == "maxar"
    assert out["matches"][0]["gsd_m"] == 0.5
    # honest note about Maxar being event-gated archive, never live
    assert "event-gated" in out["note"] and "never live" in out["note"]


def test_entity_imagery_sentinel_availability(monkeypatch) -> None:
    monkeypatch.setattr(II, "get_settings", lambda: _Settings())
    now = time.time()
    pts = [[2.35, 48.85, now - 100, 0.0]]

    async def tracks(**kw: Any) -> dict[str, Any]:
        return _track("vessel:636092000", pts, kind="vessel")

    async def manifest(aoi, before, after, window_days=14, commercial=False) -> dict[str, Any]:
        return {
            "aoi": aoi.as_dict(),
            "maxar": {"note": "n", "before_items": [], "after_items": []},
            "sentinel": {"note": "10 m, global", "available": True,
                         "layers": ["S2_L2A_TRUECOLOR"]},
        }

    monkeypatch.setattr(II.history, "query_tracks", tracks)
    monkeypatch.setattr(II.ondemand, "search_aoi", manifest)

    out = _run(II.entity_imagery("vessel:636092000"))
    assert out["kind"] == "vessel"
    assert out["best_source"] == "sentinel"
    assert out["matches"][0]["provider"] == "sentinel"
    assert out["matches"][0]["gsd_m"] == 10.0


def test_entity_imagery_no_coverage_note(monkeypatch) -> None:
    """Track found but NO Maxar event covers it and CDSE creds are unset → an
    honest 'no imagery to list' note (not implying coverage)."""
    monkeypatch.setattr(II, "get_settings", lambda: _Settings())
    now = time.time()

    async def tracks(**kw: Any) -> dict[str, Any]:
        return _track("aircraft:abc123", [[10.0, 5.0, now - 50, 0.0]])

    async def manifest(aoi, before, after, window_days=14, commercial=False) -> dict[str, Any]:
        return {
            "aoi": aoi.as_dict(),
            "maxar": {"note": "n", "before_items": [], "after_items": []},
            "sentinel": {"available": False, "layers": []},  # no CDSE creds
        }

    monkeypatch.setattr(II.history, "query_tracks", tracks)
    monkeypatch.setattr(II.ondemand, "search_aoi", manifest)

    out = _run(II.entity_imagery("aircraft:abc123"))
    assert out["matches"] == []
    assert out["best_source"] == "none"
    assert out["track"] is not None  # we DID find a track
    assert "no" in out["note"].lower()
    assert "CDSE" in out["note"] or "Sentinel" in out["note"]


def test_entity_imagery_catalog_unreachable_degrades(monkeypatch) -> None:
    monkeypatch.setattr(II, "get_settings", lambda: _Settings())
    now = time.time()

    async def tracks(**kw: Any) -> dict[str, Any]:
        return _track("aircraft:abc123", [[10.0, 5.0, now - 50, 0.0]])

    async def boom(*a: Any, **k: Any) -> dict[str, Any]:
        raise RuntimeError("Maxar S3 down")

    monkeypatch.setattr(II.history, "query_tracks", tracks)
    monkeypatch.setattr(II.ondemand, "search_aoi", boom)

    # must NOT raise — degrades to an empty match list with a caveat
    out = _run(II.entity_imagery("aircraft:abc123"))
    assert out["matches"] == []
    assert out["track"] is not None
    assert "unreachable" in out["note"].lower()


def test_entity_imagery_history_read_failure_degrades(monkeypatch) -> None:
    monkeypatch.setattr(II, "get_settings", lambda: _Settings())

    async def boom(**kw: Any) -> dict[str, Any]:
        raise RuntimeError("sqlite locked")

    monkeypatch.setattr(II.history, "query_tracks", boom)
    out = _run(II.entity_imagery("aircraft:abc123"))
    assert out["available"] is False
    assert out["matches"] == []


def test_entity_imagery_lookback_clamped_to_retention(monkeypatch) -> None:
    """A caller asking for 720 h cannot reach past the store's retention — the
    window is clamped, and query_tracks is called with the clamped t_from."""
    monkeypatch.setattr(II, "get_settings", lambda: _Settings(history_retention_hours=24))
    captured: dict[str, Any] = {}
    now = time.time()

    async def tracks(**kw: Any) -> dict[str, Any]:
        captured.update(kw)
        return {"tracks": []}

    monkeypatch.setattr(II.history, "query_tracks", tracks)
    out = _run(II.entity_imagery("aircraft:abc123", lookback_hours=720.0))
    assert out["retention_hours"] == 24
    # t_from must be ~24 h ago (clamped), NOT 720 h ago
    assert captured["t_from"] >= now - 24 * 3600 - 60
    # and the note reflects the clamped window
    assert "~24h" in out["note"]


# ── route: GET /api/entity/{id}/imagery ──────────────────────────────────────


def test_route_imagery_precedence_over_catch_all(client, monkeypatch) -> None:
    """The /imagery suffix route must win over the greedy `{eid:path}` catch-all
    — i.e. it reaches imagery_index.entity_imagery, NOT the enrichment handler."""

    async def fake(eid: str, *, lookback_hours=None, commercial=False) -> dict[str, Any]:
        return {"id": eid, "kind": "aircraft", "matches": [], "best_source": "none",
                "available": True, "note": "stub", "_marker": "imagery-route"}

    monkeypatch.setattr(II, "entity_imagery", fake)
    r = client.get("/api/entity/aircraft:4ca7b3/imagery")
    assert r.status_code == 200
    body = r.json()
    assert body["_marker"] == "imagery-route"  # not the enrichment path
    assert body["id"] == "aircraft:4ca7b3"  # the trailing /imagery was NOT absorbed


def test_route_imagery_bad_id_400(client) -> None:
    # a bare id with no ':' is rejected before we touch the index
    r = client.get("/api/entity/nocolon/imagery")
    assert r.status_code == 400


def test_route_imagery_honest_retention_note_over_http(client, monkeypatch) -> None:
    """End-to-end through the route: an entity with no track in the window
    surfaces the retention caveat (no network — mock history empty)."""

    async def empty_tracks(**kw: Any) -> dict[str, Any]:
        return {"tracks": []}

    monkeypatch.setattr(II.history, "query_tracks", empty_tracks)
    monkeypatch.setattr(II.ondemand, "search_aoi", _boom)

    r = client.get("/api/entity/aircraft:4ca7b3/imagery")
    assert r.status_code == 200
    body = r.json()
    assert body["matches"] == []
    assert "no track" in body["note"].lower()


def test_route_imagery_non_trackable_returns_unavailable(client) -> None:
    # quake is a valid <kind>:<id> shape but has no track → graceful unavailable
    r = client.get("/api/entity/quake:us6000abcd/imagery")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert body["matches"] == []


# ── test doubles ─────────────────────────────────────────────────────────────


class _Settings:
    """Minimal stand-in for app.config.Settings — only the fields imagery_index
    reads (history_enabled / history_retention_hours)."""

    def __init__(self, *, history_enabled: bool = True, history_retention_hours: int = 48):
        self.history_enabled = history_enabled
        self.history_retention_hours = history_retention_hours


async def _boom(*a: Any, **k: Any) -> dict[str, Any]:
    raise AssertionError("search_aoi must not be called on this path")
