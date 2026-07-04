"""Entity ↔ imagery geotemporal index.

Answers "what satellite imagery overlaps WHERE and WHEN a given entity was?" by
intersecting an entity's recent track (``history.query_tracks`` — the SQLite
positions store) against the on-demand imagery catalog (``ondemand.search_aoi``
— Maxar Open Data VHR, event-gated, + Sentinel-2/1 via CDSE).

Honest scope (CLAUDE.md honesty guardrail):

- The track only reaches back as far as ``history.py`` retains
  (``history_retention_hours``, ~24-48 h). For an entity last seen OLDER than
  that window, the position store has nothing, so we CANNOT say where it was —
  we return an empty match list WITH an explicit ``note`` saying so. We never
  silently return ``[]`` as if "no imagery exists"; the caveat distinguishes
  "no track in the ~Nh window" from "track found, no overlapping imagery".
- Maxar Open Data is an event-gated ARCHIVE (~0.3-0.5 m where a disaster/conflict
  activation covers the AOI) and Sentinel is 10 m. The manifest's own honest
  per-provider notes are passed through verbatim; nothing here implies live or
  VHR-everywhere coverage.
- Degrades gracefully: history disabled / empty → empty matches + note; CDSE
  creds unset → Sentinel simply reports unavailable in the manifest (Maxar may
  still match where an event covers the AOI). Never raises on a missing source.

This module is READ-ONLY over ``history`` (it never writes) and only calls the
catalog (``search_aoi``) — it downloads no pixels (that is ``/api/imagery/chip``
and ``ondemand.stage_aoi``).
"""

from __future__ import annotations

import logging
import time
from typing import Any

from app import history
from app.config import get_settings
from app.imagery import ondemand
from app.intel.geo import BBox, haversine_km

log = logging.getLogger(__name__)

# Only these kinds have a position history we can geolocate against imagery.
_TRACKABLE_KINDS = ("aircraft", "vessel")

# Padding (km) added around the track's bounding box before the catalog query,
# so an acquisition that just clips the corridor still counts as overlapping.
_AOI_PAD_KM = 2.0
# A track that spans a tiny area (a loitering / parked contact) still wants a
# minimum AOI so the catalog has something with area to intersect.
_MIN_AOI_KM = 1.0
# Cap the catalog AOI so a globe-spanning track (a transcontinental airliner)
# doesn't ask Maxar/CDSE for a hemisphere — past this we still query, but the
# match is reported as a coarse corridor box, not a tight chip.
_MAX_AOI_SPAN_DEG = 6.0

# How many distinct ids the history scan may surface (we then pick our one id
# out of the result). A bbox/time window can hold many entities; keep this
# generous so our target isn't decimated out, but bounded so the scan is cheap.
_HISTORY_LIMIT_IDS = 4000
_HISTORY_MAX_POINTS = 2000

# Maxar ± date window (days) to search around each acquisition date. The track
# is recent (≤ retention), so a tight window keeps the (event-gated) Maxar crawl
# cheap while still catching an acquisition a few days either side.
_MAXAR_WINDOW_DAYS = 14


def _retention_hours() -> int:
    """The position store's retention window, honestly (config-driven)."""
    try:
        return int(get_settings().history_retention_hours)
    except Exception:  # noqa: BLE001 — settings unreadable → conservative default
        return 48


def parse_entity_id(eid: str) -> tuple[str, str] | None:
    """Split a canonical ``<kind>:<key>`` id. Returns (kind, key) for the kinds
    that carry a position history (aircraft/vessel), else None."""
    if ":" not in eid:
        return None
    kind, key = eid.split(":", 1)
    key = key.strip()
    if not key or kind not in _TRACKABLE_KINDS:
        return None
    return kind, key


def _track_bbox(points: list[list[float]]) -> BBox | None:
    """Bounding box of a track's ``[lon, lat, t, track]`` points, padded so a
    grazing acquisition still overlaps. None when there are no usable points."""
    lons: list[float] = []
    lats: list[float] = []
    for p in points:
        if len(p) < 2:
            continue
        try:
            lons.append(float(p[0]))
            lats.append(float(p[1]))
        except (TypeError, ValueError):
            continue
    if not lons or not lats:
        return None
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)

    # Pad by _AOI_PAD_KM, with a floor of _MIN_AOI_KM total span, in degrees.
    # Latitude: 1° ≈ 111.32 km. Longitude shrinks with latitude.
    import math

    mid_lat = (min_lat + max_lat) / 2.0
    lat_pad = max(_AOI_PAD_KM, _MIN_AOI_KM / 2.0) / 111.32
    lon_km_per_deg = 111.32 * max(math.cos(math.radians(mid_lat)), 0.01)
    lon_pad = max(_AOI_PAD_KM, _MIN_AOI_KM / 2.0) / lon_km_per_deg

    bb = BBox(
        max(-180.0, min_lon - lon_pad),
        max(-90.0, min_lat - lat_pad),
        min(180.0, max_lon + lon_pad),
        min(90.0, max_lat + lat_pad),
    )
    # Clamp a runaway span so a transcontinental track doesn't request a
    # hemisphere from the catalog (kept honest: reported as a corridor box).
    if (bb.max_lon - bb.min_lon) > _MAX_AOI_SPAN_DEG or (
        bb.max_lat - bb.min_lat
    ) > _MAX_AOI_SPAN_DEG:
        clon, clat = bb.center
        half = _MAX_AOI_SPAN_DEG / 2.0
        bb = BBox(
            max(-180.0, clon - half),
            max(-90.0, clat - half),
            min(180.0, clon + half),
            min(90.0, clat + half),
        )
    return bb


def _select_track(tracks: list[dict[str, Any]], entity_id: str) -> dict[str, Any] | None:
    """Pick our entity's track out of ``query_tracks`` output (it returns every
    id whose fixes fall in the scan window — there is no id filter)."""
    for t in tracks:
        if t.get("id") == entity_id:
            return t
    return None


def _iso_day(epoch: float) -> str:
    import datetime as dt

    return dt.datetime.fromtimestamp(epoch, dt.UTC).strftime("%Y-%m-%d")


def _scene_overlaps_track(
    scene_bbox: list[float] | None, points: list[list[float]]
) -> bool:
    """True if any track point lies inside the scene's bbox. The catalog already
    filtered scenes to the (padded) track AOI; this tightens it so a scene whose
    box only touches the AOI corner but never the actual path is dropped."""
    if not scene_bbox or len(scene_bbox) < 4:
        return True  # no scene bbox → trust the catalog's AOI filter
    w, s, e, n = scene_bbox[0], scene_bbox[1], scene_bbox[2], scene_bbox[3]
    lo_lon, hi_lon = min(w, e), max(w, e)
    lo_lat, hi_lat = min(s, n), max(s, n)
    for p in points:
        if len(p) < 2:
            continue
        try:
            lon, lat = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            continue
        if lo_lon <= lon <= hi_lon and lo_lat <= lat <= hi_lat:
            return True
    return False


def _nearest_point_time(scene_bbox: list[float] | None, points: list[list[float]]) -> float | None:
    """Timestamp of the track fix that falls inside the scene bbox (the moment
    the entity was where this scene looks). Falls back to the track's own time
    span midpoint when no point is strictly inside."""
    if scene_bbox and len(scene_bbox) >= 4:
        w, s, e, n = scene_bbox[0], scene_bbox[1], scene_bbox[2], scene_bbox[3]
        lo_lon, hi_lon = min(w, e), max(w, e)
        lo_lat, hi_lat = min(s, n), max(s, n)
        for p in points:
            if len(p) < 3:
                continue
            try:
                lon, lat, t = float(p[0]), float(p[1]), float(p[2])
            except (TypeError, ValueError):
                continue
            if lo_lon <= lon <= hi_lon and lo_lat <= lat <= hi_lat:
                return t
    # fallback: first point time if any
    for p in points:
        if len(p) >= 3:
            try:
                return float(p[2])
            except (TypeError, ValueError):
                continue
    return None


def _scenes_from_manifest(
    manifest: dict[str, Any], points: list[list[float]]
) -> list[dict[str, Any]]:
    """Flatten the search_aoi manifest into a list of imagery matches that
    actually overlap the track path, newest-first.

    Each match: ``{provider, datetime, epoch, bbox, gsd_m, note, overlap_t}``
    where ``overlap_t`` is the track-fix epoch nearest where the scene looks (so
    the UI can say "the entity was here at HH:MM; this pass is from <date>")."""
    matches: list[dict[str, Any]] = []

    maxar = manifest.get("maxar") or {}
    maxar_note = maxar.get("note")
    for slot in ("before_items", "after_items"):
        for sc in maxar.get(slot) or []:
            bb = sc.get("bbox")
            if not _scene_overlaps_track(bb, points):
                continue
            matches.append(
                {
                    "provider": "maxar",
                    "id": sc.get("id"),
                    "datetime": sc.get("datetime"),
                    "epoch": sc.get("epoch"),
                    "bbox": bb,
                    "gsd_m": 0.5,
                    "note": maxar_note,
                    "collection": sc.get("collection"),
                    "overlap_t": _nearest_point_time(bb, points),
                }
            )

    # Sentinel is global/any-date (10 m) but search_aoi only reports whether the
    # layers are AVAILABLE (it does not enumerate per-date scenes). Surface it as
    # an availability entry covering the track AOI for the requested dates, so
    # the caller can fetch a /api/imagery/chip for the path — labeled honestly.
    sent = manifest.get("sentinel") or {}
    if sent.get("available"):
        matches.append(
            {
                "provider": "sentinel",
                "id": None,
                "datetime": None,
                "epoch": None,
                "bbox": manifest.get("aoi"),
                "gsd_m": 10.0,
                "note": sent.get("note"),
                "layers": sent.get("layers") or [],
                "overlap_t": None,
            }
        )

    # Newest real acquisition first; the availability-only Sentinel entry (epoch
    # None) sorts last.
    matches.sort(key=lambda m: (m.get("epoch") is not None, m.get("epoch") or 0.0), reverse=True)
    return matches


async def entity_imagery(
    entity_id: str,
    *,
    lookback_hours: float | None = None,
    commercial: bool = False,
) -> dict[str, Any]:
    """Imagery overlapping where + when *entity_id* was, over its recent track.

    Pipeline: ``history.query_tracks`` (bbox+time over the retention window) →
    track bbox → ``ondemand.search_aoi`` catalog → keep scenes that overlap the
    path. Read-only; downloads no pixels.

    Always returns a dict (never raises on a missing source). Key fields::

        {
          "id": "aircraft:abc123",
          "kind": "aircraft",
          "retention_hours": 48,          # the history window this is scoped to
          "window": {"t_from": ..., "t_to": ...},
          "track": {"points": int, "bbox": {...}, "t_first": ..., "t_last": ...},
          "matches": [ {provider, datetime, bbox, gsd_m, note, overlap_t}, ... ],
          "best_source": "maxar"|"sentinel"|"none",
          "note": "<honest scope caveat>",
          "available": bool,              # could we even look (history on)?
        }
    """
    parsed = parse_entity_id(entity_id)
    retention_h = _retention_hours()
    base: dict[str, Any] = {
        "id": entity_id,
        "kind": parsed[0] if parsed else None,
        "retention_hours": retention_h,
        "matches": [],
        "best_source": "none",
        "track": None,
        "available": True,
    }

    if parsed is None:
        base["available"] = False
        base["note"] = (
            "imagery index is only available for aircraft:<icao24> or "
            "vessel:<mmsi> ids (the kinds with a position history)"
        )
        return base
    kind, _key = parsed

    if not get_settings().history_enabled:
        base["available"] = False
        base["note"] = "position history is disabled — cannot locate this entity"
        return base

    lb_h = float(lookback_hours) if lookback_hours is not None else float(retention_h)
    # Never claim to reach further than the store actually retains.
    lb_h = min(lb_h, float(retention_h))
    now = time.time()
    t_from = now - lb_h * 3600.0
    base["window"] = {"t_from": t_from, "t_to": now}

    # Read the track (read-only). query_tracks has no id filter, so scan the
    # kind over the window and pick our id out of the result.
    try:
        res = await history.query_tracks(
            kind=kind,
            bbox=None,
            t_from=t_from,
            t_to=now,
            limit_ids=_HISTORY_LIMIT_IDS,
            max_points_per_id=_HISTORY_MAX_POINTS,
        )
    except Exception:  # noqa: BLE001 — history read failure must not 500 the panel
        log.exception("imagery_index: history.query_tracks failed for %s", entity_id)
        base["available"] = False
        base["note"] = "position history unavailable"
        return base

    track = _select_track(res.get("tracks") or [], entity_id)
    points: list[list[float]] = (track or {}).get("points") or []
    if not points:
        # No track in the retention window — be explicit that this is a
        # retention limit, NOT "no imagery exists". (B3 honesty caveat.)
        base["note"] = (
            f"no track for {entity_id} in the last ~{int(lb_h)}h "
            f"(position history retains ~{retention_h}h); imagery cannot be "
            "geolocated for an entity last seen before the window"
        )
        return base

    aoi = _track_bbox(points)
    if aoi is None:
        base["note"] = "track has no usable coordinates"
        return base

    # Track time span → catalog before/after dates. The track is recent, so
    # "before" = earliest fix day, "after" = latest fix day. Maxar searches
    # ±_MAXAR_WINDOW_DAYS around each.
    point_times = [float(p[2]) for p in points if len(p) >= 3]
    t_first = min(point_times) if point_times else t_from
    t_last = max(point_times) if point_times else now
    before_date = _iso_day(t_first)
    after_date = _iso_day(t_last)

    base["track"] = {
        "points": len(points),
        "bbox": aoi.as_dict(),
        "t_first": t_first,
        "t_last": t_last,
    }

    try:
        manifest = await ondemand.search_aoi(
            aoi,
            before_date,
            after_date,
            window_days=_MAXAR_WINDOW_DAYS,
            commercial=commercial,
        )
    except Exception:  # noqa: BLE001 — catalog crawl failure → no matches, not a 500
        log.exception("imagery_index: search_aoi failed for %s", entity_id)
        base["note"] = (
            f"track found ({len(points)} fixes) but the imagery catalog was "
            "unreachable; no overlapping imagery could be listed"
        )
        return base

    matches = _scenes_from_manifest(manifest, points)
    base["matches"] = matches
    base["catalog"] = {
        "maxar_timed_out": (manifest.get("maxar") or {}).get("timed_out", False),
        "maxar_index_truncated": (manifest.get("maxar") or {}).get(
            "index_truncated", False
        ),
        "before": before_date,
        "after": after_date,
    }

    has_maxar = any(m["provider"] == "maxar" for m in matches)
    has_sent = any(m["provider"] == "sentinel" for m in matches)
    base["best_source"] = "maxar" if has_maxar else ("sentinel" if has_sent else "none")

    span_km = round(
        haversine_km(aoi.min_lon, aoi.min_lat, aoi.max_lon, aoi.max_lat), 1
    )
    if matches:
        base["note"] = (
            f"imagery overlapping the {len(points)}-fix track of {entity_id} "
            f"over the last ~{int(lb_h)}h (AOI diag ~{span_km} km). Maxar VHR is "
            "event-gated archive; Sentinel is 10 m — dates labeled per scene, "
            "never live."
        )
    else:
        base["note"] = (
            f"track found ({len(points)} fixes, AOI diag ~{span_km} km) but no "
            "Maxar Open Data event covers it and Sentinel is unavailable "
            "(CDSE creds unset); no imagery to list for this path"
        )
    return base
