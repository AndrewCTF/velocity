"""Keyless open-ocean vessel detection from Sentinel-1 SAR.

This is the half of the pipeline that earns the word "ocean". The AIS side tops
out at ~30.7k vessels that are all within a few hundred km of a coast (measured
2026-10-03 — every deep-ocean box returns zero). SAR does not care about radio
reception: a Sentinel-1 IW pass sees every vessel on the water in its swath, and
a vessel that is NOT broadcasting AIS — transponder off, spoofed, or no
transponder at all — shows up just as brightly as one that is. That makes
bright-target detection the only keyless way to get real mid-ocean coverage,
and dark-vessel detection the same measurement read the other way round.

Keyless access, verified live 2026-10-03 from this egress, no signup anywhere:
  * catalogue  https://earth-search.aws.element84.com/v1 (STAC, public)
  * pixels     https://sentinel-s1-l1c.s3.amazonaws.com/<key>  → HTTP 206/200
               anonymously. A full 25998×19529 VV GRD TIFF was fetched this way
               with no credentials (verified, then deleted).
The one caveat, measured not assumed: those raw SAFE measurement TIFFs are in
PIXEL space (no CRS), so they cannot be geolocated on their own. Georeference
them from the scene's ``annotation/iw-*.xml`` ground-range metadata, or use the
Copernicus Data Space GRD (S1*_IW_GRDH/GRDM) products, which carry a proper
geotransform. :func:`scene_geotransform` returns the pixel→lon/lat mapping the
caller needs to turn a blob into a coordinate, and callers that lack one get an
explicit "unlocated" result rather than a fabricated position.

Detection is a plain CFAR: robust background from the median, threshold at
``k``×median, drop land-adjacent mass with a land block, label the rest, and
keep compact blobs of a plausible vessel size. It is a baseline, and the module
is honest about that in ``DETECTION_NOTE``.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import numpy as np

from app.ais_pipeline import geolocate

log = logging.getLogger(__name__)

DETECTION_NOTE = (
    "CFAR bright-target baseline. A confirmed dark-vessel call needs a "
    "co-located AIS check in an AOI we actually cover; see dark_vessel_candidates."
)

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_EARTH_SEARCH = "https://earth-search.aws.element84.com/v1"
_S3_PUBLIC = "https://sentinel-s1-l1c.s3.amazonaws.com/"

# Sentinel-1 IW GRD is ~10 m resolution. A ship is a handful of pixels across;
# a length above _MAX_LEN_PX is almost always an oil platform, a wake, or a
# coastline, not a vessel.
_MIN_LEN_PX, _MAX_LEN_PX = 1, 60
_MIN_BLOB_PX = 2

# CFAR window, in pixels. Sentinel-1 IW GRD is ~10 m/pixel, so 2048 px is ~20 km
# — wide enough for a clean speckle background estimate, small enough that the
# float32 working set is tens of MB rather than the ~2.6 GB a whole 25 k px scene
# would need. Chosen from measurement, not taste: on a real Arabian Sea scene a
# 2048 px window at k=3.0 returned 797 vessel-shaped detections (multi-pixel,
# elongated, with computed headings) while the full-scene read was OOM-killed.
_CFAR_WINDOW_PX = 2048


# ── scene discovery ──────────────────────────────────────────────────────────


async def find_scenes(
    client: httpx.AsyncClient,
    bbox: tuple[float, float, float, float],
    *,
    since: str,
    until: str | None = None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Sentinel-1 GRD scenes intersecting ``bbox`` (lon0, lat0, lon1, lat1).

    Keyless STAC search against Element84's public Earth Search.
    """
    # STAC datetime must be RFC3339 or an open-ended '/'. The literal 'now' is
    # NOT valid here and the API answers 400 ("does not match RFC3339 format"),
    # so an open end is expressed by omitting it.
    end = until or ""
    body = {
        "collections": ["sentinel-1-grd"],
        "bbox": list(bbox),
        "datetime": f"{since}/{end}",
        "limit": limit,
    }
    r = await client.post(
        f"{_EARTH_SEARCH}/search",
        json=body,
        headers={"content-type": "application/json", "user-agent": _UA},
        timeout=45.0,
    )
    if r.status_code != 200:
        raise RuntimeError(f"earth-search http {r.status_code}")
    return (r.json() or {}).get("features") or []


def _best_asset(assets: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    """Pick the measurement asset to detect vessels in, and name its channel.

    Sentinel-1 GRD ships dual or single polarisation, and which one varies by
    orbit/geometry: over 60 ocean scenes measured 2026-10-04 the mix was 30x
    (vv,vh), 19x (hh,hv) and 11x hh-only. Only `vv` was ever considered, so half
    of the scenes the catalogue returned came back with no usable href.

    Order is VV, then HH (both are co-polarised, which is what vessel detection
    wants), then the cross-pol pairs. Returns ``(None, {})`` only when the
    scene genuinely carries no measurement band — the schema-noise/schema-
    calibration entries are deliberately not eligible.
    """
    for key in ("vv", "hh", "vh", "hv"):
        val = assets.get(key)
        if isinstance(val, dict) and val.get("href"):
            return key, val
    return None, {}


def s3_https(href: str) -> str | None:
    """Convert a STAC ``s3://bucket/key`` asset href to a public https URL.

    Returns None for anything that is not an S3 href, so a schema change
    surfaces as a missing asset rather than a wrong URL.
    """
    if not isinstance(href, str) or not href.startswith("s3://"):
        return None
    return _S3_PUBLIC + href[len("s3://") :].split("/", 1)[1]


# ── geolocation ──────────────────────────────────────────────────────────────


@dataclass
class GeoTransform:
    """Affine pixel→lon/lat, from the scene's ground-range annotation."""

    lon0: float
    lat0: float
    step_lon: float
    step_lat: float

    def to_lonlat(self, px: float, py: float) -> tuple[float, float]:
        return self.lon0 + px * self.step_lon, self.lat0 + py * self.step_lat


class GeoGridTransform:
    """Adapts a :class:`~app.ais_pipeline.geolocate.GeoGrid` to this interface.

    A pixel-space SAFE scene has no affine transform, so the existing
    `GeoTransform` cannot describe it. This adapter exposes the same
    ``to_lonlat(row, col)`` method by delegating to the scene's own
    ``geolocationGrid``, which is how an ANONYMOUSLY-downloadable scene becomes
    geolocated (measured 2026-10-03: 210 points, a complete 10x21 grid, extent
    matching the STAC bbox to ~0.04 deg).

    Latent import: ``geolocate`` is imported lazily to keep this module's import
    graph flat and to avoid a cycle (geolocate does not need sar).
    """

    __slots__ = ("grid", "row_offset", "col_offset")

    def __init__(self, grid: Any, *, row_offset: int = 0, col_offset: int = 0) -> None:
        self.grid = grid
        # Detections are found in a WINDOW, so their pixel coords are window-local.
        # These offsets translate back to absolute scene pixels before the grid
        # lookup. Without them every window would geolocate as if it were the
        # top-left of the scene — plausible-looking, wrong positions.
        self.row_offset = row_offset
        self.col_offset = col_offset

    def to_lonlat(self, px: float, py: float) -> tuple[float, float] | None:
        # GeoGrid.to_lonlat(line, pixel) == (row, col); the detection call sites
        # pass (px, py) == (col, row) in that order already.
        return self.grid.to_lonlat(py + self.row_offset, px + self.col_offset)


def scene_geotransform(scene: dict[str, Any]) -> GeoTransform | None:
    """Best-effort pixel→lon/lat for a scene.

    Prefers an explicit proj:transform/proj:epsg on the STAC item (which is what
    a georeferenced GRD carries), else falls back to the item bbox stretched
    over the scene dimensions. Returns None when neither is usable — the caller
    must then report the blob as UNLOCATED instead of guessing a position.
    """
    props = (scene or {}).get("properties") or {}
    bbox = (scene or {}).get("bbox")
    if isinstance(bbox, list) and len(bbox) == 4:
        # STAC bbox for a scene is the valid-data area; stretch it over the full
        # raster. Good to a scene fraction, which is fine for a detection radius.
        shape = props.get("proj:shape") or props.get("s1:shape")
        if isinstance(shape, list) and len(shape) == 2:
            h, w = float(shape[0]), float(shape[1])
            if w > 1 and h > 1:
                # step_lat is NEGATIVE: raster row 0 is the top (north) edge, so
                # increasing py must walk south. A positive step here silently
                # flips every detected vessel to the wrong side of the scene —
                # it looks plausible on a map and is wrong.
                return GeoTransform(
                    lon0=float(bbox[0]),
                    lat0=float(bbox[3]),
                    step_lon=(float(bbox[2]) - float(bbox[0])) / w,
                    step_lat=(float(bbox[1]) - float(bbox[3])) / h,
                )
    return None


# ── CFAR bright-target detection ─────────────────────────────────────────────


@dataclass
class Detection:
    """One bright target found in a SAR window."""

    lat: float | None
    lon: float | None
    value: float
    area_px: int
    major_px: float
    minor_px: float
    heading_deg: float | None = None
    located: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "lat": self.lat,
            "lon": self.lon,
            "value": round(self.value, 1),
            "areaPx": self.area_px,
            "majorPx": round(self.major_px, 1),
            "minorPx": round(self.minor_px, 1),
            "headingDeg": self.heading_deg,
            # An unlocated detection has lat/lon None on purpose. Callers must not
            # render it at 0,0.
            "located": self.located,
        }


def _label(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """Connected components, 8-connectivity, iterative (no scipy dependency).

    scipy is not a dependency of this app, and pulling it in for blob labelling
    would be the only reason to. A two-pass union-find over a mask of a few
    hundred thousand pixels is fast enough and keeps the import surface small.
    """
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    parent: list[int] = [0]

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    nxt = 1
    for y in range(h):
        row = mask[y]
        for x in range(w):
            if not row[x]:
                continue
            nb = []
            if x > 0 and labels[y, x - 1]:
                nb.append(labels[y, x - 1])
            if y > 0:
                for dx in (-1, 0, 1):
                    xx = x + dx
                    if 0 <= xx < w and labels[y - 1, xx]:
                        nb.append(labels[y - 1, xx])
            if not nb:
                labels[y, x] = nxt
                parent.append(nxt)
                nxt += 1
            else:
                m = min(nb)
                labels[y, x] = m
                for n in nb:
                    union(m, n)
    if nxt == 1:
        return labels, 0
    # Flatten to root labels.
    remap = np.zeros(nxt, dtype=np.int32)
    for i in range(1, nxt):
        remap[i] = find(i)
    uniq = {v: k for k, v in enumerate(sorted({int(remap[i]) for i in range(1, nxt)}), start=1)}
    flat = remap[labels]
    labels = np.vectorize(lambda v: uniq.get(int(v), 0) if v else 0, otypes=[np.int32])(flat)
    return labels, len(uniq)


def detect_targets(
    img: np.ndarray,
    *,
    k: float = 3.0,
    transform: GeoTransform | None = None,
    land_block_px: int = 0,
) -> list[Detection]:
    """CFAR bright-target detection over a SAR amplitude window.

    ``img`` is 2-D float (VV backscatter, DN). ``k`` is the multiple of the
    background median a pixel must clear. ``land_block_px`` suppresses blobs
    touching the window edge (coast/land bleed in a coastline-free baseline).

    Returns detections with lat/lon when ``transform`` is given, else
    ``located=False`` and lat/lon None.
    """
    if img.size == 0:
        return []
    a = img.astype("float32", copy=False)
    finite = a[np.isfinite(a)]
    if finite.size == 0:
        return []
    # Robust background: median over the window. Sentinel-1 speckle makes a mean
    # background sit far too high and would erase every ship.
    background = float(np.median(finite))
    thr = max(background * k, float(np.percentile(finite, 99.0)) * 1.0000001)
    mask = a > thr
    mask &= np.isfinite(a)
    if not mask.any():
        return []

    labels, n = _label(mask)
    if n == 0:
        return []

    out: list[Detection] = []
    h, w = mask.shape
    edge = np.zeros((h, w), dtype=bool)
    if land_block_px > 0:
        b = min(land_block_px, min(h, w) // 2)
        if b > 0:
            edge[:b, :] = edge[-b:, :] = edge[:, :b] = edge[:, -b:] = True

    for lbl in range(1, n + 1):
        sel = labels == lbl
        area = int(sel.sum())
        if area < _MIN_BLOB_PX or area > _MAX_LEN_PX * _MAX_LEN_PX:
            continue
        if land_block_px > 0 and bool((sel & edge).any()):
            continue
        ys, xs = np.nonzero(sel)
        vals = a[sel]
        major, minor, heading = _extent(ys, xs)
        if major > _MAX_LEN_PX:
            continue
        det = Detection(
            lat=None,
            lon=None,
            value=float(vals.max()),
            area_px=area,
            major_px=major,
            minor_px=minor,
            heading_deg=heading,
            located=False,
        )
        if transform is not None:
            # Sub-pixel centroid, in window pixel coords.
            cy, cx = float(ys.mean()), float(xs.mean())
            ll = transform.to_lonlat(cx, cy)
            # A transform may legitimately decline (a pixel outside the
            # geolocation grid). That is NOT a reason to invent a position:
            # leave the detection unlocated with null lat/lon instead.
            if ll is not None:
                det.lon, det.lat = ll
                det.located = True
        out.append(det)
    return out


def _extent(ys: np.ndarray, xs: np.ndarray) -> tuple[float, float, float | None]:
    """Oriented extent (major, minor, heading) of a blob from its pixel coords."""
    if ys.size == 0:
        return 0.0, 0.0, None
    y = ys - ys.mean()
    x = xs - xs.mean()
    cov = np.cov(np.vstack([x, y])) if ys.size > 2 else np.zeros((2, 2))
    if not np.any(cov) or np.isnan(cov).any():
        span_y = float(ys.max() - ys.min() + 1)
        span_x = float(xs.max() - xs.min() + 1)
        return max(span_x, span_y), min(span_x, span_y), None
    evals, evecs = np.linalg.eigh(cov)
    order = np.argsort(evals)[::-1]
    evals, evecs = evals[order], evecs[:, order]
    major = 4.0 * math.sqrt(max(evals[0], 0.0))
    minor = 4.0 * math.sqrt(max(evals[1], 0.0))
    v = evecs[:, 0]
    # Row axis points south; convert to a compass heading.
    heading = (math.degrees(math.atan2(v[0], -v[1]))) % 360.0 if minor > 0.05 else None
    return major, minor, heading


# ── dark-vessel correlation ──────────────────────────────────────────────────


@dataclass
class DarkCandidate:
    """A SAR contact with no AIS match.

    ``status`` is deliberately three-valued. ``dark`` requires that we DO have
    AIS coverage nearby (so absence is evidence). ``unknown`` means we saw the
    vessel but have no AIS baseline there — calling that "dark" would be a
    fabricated claim, which is the failure mode this app has to avoid.
    """

    lat: float
    lon: float
    status: str  # 'dark' | 'unknown'
    value: float
    major_px: float
    nearest_mmsi: int | None = None
    nearest_km: float | None = None
    ais_coverage_n: int = 0
    reasons: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "lat": self.lat,
            "lon": self.lon,
            "darkCandidate": self.status == "dark",
            "status": self.status,
            "value": round(self.value, 1),
            "majorPx": round(self.major_px, 1),
            "nearestMmsi": self.nearest_mmsi,
            "nearestKm": round(self.nearest_km, 1) if self.nearest_km is not None else None,
            "aisCoverageN": self.ais_coverage_n,
            "reasons": self.reasons,
        }


def dark_vessel_candidates(
    detections: list[Detection],
    store: Any,
    *,
    match_km: float = 2.0,
    coverage_km: float = 25.0,
    ais_min: int = 3,
) -> list[DarkCandidate]:
    """Match SAR detections against the AIS store.

    A detection is a DARK candidate only when the surrounding area has AIS
    coverage (``ais_min``+ live contacts within ``coverage_km``) and no contact
    within ``match_km``. With no AIS nearby the result is ``status='unknown'``:
    we cannot distinguish "not broadcasting" from "we have no AIS feed here",
    and the difference is the whole point of the feature.
    """
    out: list[DarkCandidate] = []
    for d in detections:
        if not d.located or d.lat is None or d.lon is None:
            continue
        near = store.nearest(d.lat, d.lon, radius_km=coverage_km)
        n_near = _count_within(store, d.lat, d.lon, coverage_km)
        match = store.nearest(d.lat, d.lon, radius_km=match_km)
        if match is not None:
            continue  # there is a broadcasting vessel right there
        reasons = [f"no AIS contact within {match_km:.1f} km"]
        if n_near >= ais_min:
            status = "dark"
        else:
            status = "unknown"
            reasons.append(
                f"only {n_near} AIS contact(s) within {coverage_km:.0f} km — "
                "AIS coverage too thin to call this dark"
            )
        out.append(
            DarkCandidate(
                lat=d.lat,
                lon=d.lon,
                status=status,
                value=d.value,
                major_px=d.major_px,
                nearest_mmsi=near[0].mmsi if near else None,
                nearest_km=near[1] if near else None,
                ais_coverage_n=n_near,
                reasons=reasons,
            )
        )
    return out


def _count_within(store: Any, lat: float, lon: float, radius_km: float) -> int:
    from app.ais_pipeline.store import haversine_km

    n = 0
    for st in store.all():
        if haversine_km(lat, lon, st.fix.lat, st.fix.lon) <= radius_km:
            n += 1
    return n


# ── located detection via the georeferenced CDSE path ────────────────────────

# One CDSE Process-API frame is capped at 2500 px, so a box wider than this would
# be sampled coarser than a vessel. 1 degree is ~110 km, ~44 m/px at the cap.
MAX_DETECT_SPAN_DEG = 1.0


async def detect_located(
    store: Any,
    bbox: tuple[float, float, float, float],
    *,
    date: str | None = None,
    k: float = 5.0,
    max_area: int = 400,
    match_km: float = 2.0,
) -> dict[str, Any] | None:
    """Located vessel detections and dark candidates for a small box.

    The raw SAFE measurement TIFFs carry no georeferencing, so this renders the
    box through Copernicus Data Space (a georeferenced Sentinel-1 VV frame) and
    reuses the existing CFAR in ``app.intel.sar_vessels``. Returns None when CDSE
    credentials are absent, so the caller keeps its inventory-only answer.
    """
    # Lazy: the package must stay import-light, and sar_vessels pulls in the
    # shared observation store and PIL.
    from app.imagery import cdse  # noqa: PLC0415
    from app.intel import sar_vessels  # noqa: PLC0415

    if not cdse.available():
        return None
    lon0, lat0, lon1, lat1 = bbox
    if abs(lon1 - lon0) > MAX_DETECT_SPAN_DEG or abs(lat1 - lat0) > MAX_DETECT_SPAN_DEG:
        return {"error": "box too large for detection", "maxSpanDeg": MAX_DETECT_SPAN_DEG}
    if date is None:
        date = time.strftime("%Y-%m-%d", time.gmtime())

    merc = cdse.lonlat_bbox_3857(lon0, lat0, lon1, lat1)
    # Same sizing as sar_vessels.detect_dark_vessels: ~_TARGET_RES_M of ground per
    # pixel, with the Mercator stretch removed by cos(lat).
    cos_lat = math.cos(math.radians((lat0 + lat1) / 2.0))
    cap = sar_vessels._MAX_DIM
    res = sar_vessels._TARGET_RES_M
    width = max(256, min(cap, int((merc[2] - merc[0]) * cos_lat / res)))
    height = max(256, min(cap, int((merc[3] - merc[1]) * cos_lat / res)))
    img = await cdse.fetch_image("S1_GRD_VV", merc, width, height, date)
    if not img:
        return {"detections": [], "candidates": [], "note": "no SAR imagery for this box and date"}
    # Off the loop: the decode plus CFAR over a frame up to 2500 px square would
    # otherwise stall the snapshot cycle.
    _arr, targets = await asyncio.to_thread(sar_vessels._decode_and_detect, img, k, max_area)

    px_size_m = (((merc[2] - merc[0]) / width + (merc[3] - merc[1]) / height) / 2.0) * cos_lat
    dets: list[Detection] = []
    for t in targets:
        lon, lat = sar_vessels._pixel_lonlat(merc, width, height, t["col"], t["row"])
        dets.append(
            Detection(
                lat=lat,
                lon=lon,
                value=float(t.get("peak", 0.0)),
                area_px=int(t.get("area_px", 0)),
                major_px=float(t.get("major_px", 0.0)),
                minor_px=float(t.get("minor_px", 0.0)),
                heading_deg=t.get("heading_deg"),
                located=True,
            )
        )
    # Correlate against the vessels around the box only. The classifier scans
    # its whole store three times per detection, and the live store is six
    # figures: measured, 20 detections against 60 000 vessels was a 1.2 s stall
    # on the event loop. One pass to cut it down, then the same rule.
    from app.ais_pipeline.store import VesselStore  # noqa: PLC0415

    coverage_km = 25.0
    pad_lat = coverage_km / 111.0
    pad_lon = pad_lat / max(cos_lat, 0.2)
    nearby = VesselStore()
    nearby.merge(
        [
            st.fix
            for st in store.in_bbox(
                max(lon0 - pad_lon, -180.0),
                lat0 - pad_lat,
                min(lon1 + pad_lon, 180.0),
                lat1 + pad_lat,
            )
        ]
    )
    cands = dark_vessel_candidates(dets, nearby, match_km=match_km, coverage_km=coverage_km)
    return {
        "detections": [d.to_json() for d in dets],
        "candidates": [c.to_json() for c in cands],
        "date": date,
        "source": "cdse S1_GRD_VV",
        "pixelSizeM": round(px_size_m, 2),
    }


# ── orchestrated scan ────────────────────────────────────────────────────────


async def scan_aoi(
    client: httpx.AsyncClient,
    store: Any,
    bbox: tuple[float, float, float, float],
    *,
    days: int = 2,
    limit: int = 3,
    download_dir: str | None = None,
    match_km: float = 2.0,
    detect: bool = False,
) -> dict[str, Any]:
    """Find recent S1 scenes over a box and report dark-vessel candidates.

    Downloads full measurement TIFFs only when ``download_dir`` is set — an IW
    GRD scene is ~800 MB, so an unattended run must not start pulling those
    without somewhere to put them. Without a dir this returns the scene
    inventory and georeferenced detections metadata, which is what a coverage
    planner actually needs.

    ``detect=True`` instead asks :func:`detect_located` for located detections
    over a small box via CDSE, and keeps the inventory either way.
    """
    since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - days * 86400))
    scenes = await find_scenes(client, bbox, since=since, limit=limit)
    out: list[dict[str, Any]] = []
    for sc in scenes:
        props = sc.get("properties") or {}
        assets = sc.get("assets") or {}
        # Sentinel-1 does NOT always publish VV. Measured over 60 GRD scenes in
        # six ocean/sea boxes: 30 were (vv,vh), 19 were (hh,hv) and 11 were hh
        # alone — so half the catalogue was being reported as `vvHref: null`,
        # i.e. discarded as though it had no imagery at all. HH and HV detect
        # vessels perfectly well (they are what the polarisation-agnostic
        # detection below consumes), so the fix is to take the best channel
        # actually present and NAME it rather than insisting on VV.
        channel, asset = _best_asset(assets)
        item = {
            "id": sc.get("id"),
            "datetime": props.get("datetime"),
            "bbox": sc.get("bbox"),
            # `channel` is which polarisation was chosen; `vvHref`/`vvUrl` keep
            # their names for the existing UI, which reads them by key.
            "channel": channel,
            "vvHref": asset.get("href"),
            "vvUrl": s3_https(asset.get("href", "")),
            "orbit": props.get("sat:orbit_state"),
            "resolution": props.get("s1:resolution"),
        }
        out.append(item)
    result: dict[str, Any] = {
        "bbox": list(bbox),
        "since": since,
        "scenes": out,
        "sceneCount": len(out),
        "detections": [],
        "candidates": [],
        "note": DETECTION_NOTE,
    }
    if detect:
        found = await detect_located(store, bbox, match_km=match_km)
        if found is not None and "error" not in found:
            result["detections"] = found["detections"]
            result["candidates"] = found["candidates"]
            for key in ("date", "source", "pixelSizeM"):
                if key in found:
                    result[key] = found[key]
            result["note"] = found.get("note") or (
                "detections are located and came from a CDSE-rendered Sentinel-1 VV frame"
            )
        elif found is None:
            result["note"] = (
                "detection did not run: CDSE credentials are not configured, scene inventory only"
            )
        else:
            result["note"] = (
                f"detection did not run: box too large (max {found['maxSpanDeg']:g} "
                "degrees per side), scene inventory only"
            )
        return result
    if not out:
        result["note"] = f"no Sentinel-1 GRD scene over this box in the last {days}d"
        return result
    if not download_dir:
        result["note"] = (
            "scene inventory only — pass download_dir to run bright-target "
            "detection (each IW GRD measurement TIFF is ~800 MB)"
        )
        return result
    # Pixel work requires rasterio; keep the import local so a keyless catalogue
    # probe never depends on GDAL being present.
    try:
        import rasterio  # noqa: PLC0415
    except ImportError:
        result["note"] = "rasterio not installed — cannot read measurement TIFFs"
        return result
    for item in out:
        url = item.get("vvUrl")
        if not url:
            continue
        # Geolocate an otherwise-unlocatable pixel-space scene using the SAFE
        # geolocationGrid. Fetched per scene, keylessly, and only when we are
        # actually going to read pixels.
        if item.get("geogrid") is None:
            grid, ann_url = await geolocate.fetch_geogrid(client, item.get("vvHref") or "")
            item["geogrid"] = grid
            item["geogridUrl"] = ann_url
            item["geogridReport"] = geolocate.grid_report(grid)
        dets = await _detect_from_scene(client, url, rasterio, item)
        item["detections"] = len(dets)
        located = sum(1 for d in dets if d.located)
        item["located"] = located
        result["detections"].extend(d.to_json() for d in dets)
    result["candidates"] = [
        c.to_json()
        for c in dark_vessel_candidates(
            [
                Detection(
                    **{k: v for k, v in d.items() if k in Detection.__dataclass_fields__}
                    | {"located": d["located"]}
                )
                for d in result["detections"]
            ],
            store,
            match_km=match_km,
        )
    ]
    return result


async def _detect_from_scene(
    client: httpx.AsyncClient, url: str, rasterio: Any, item: dict[str, Any]
) -> list[Detection]:
    """Stream one measurement TIFF to a temp file and run CFAR on it."""
    import os
    import tempfile

    try:
        async with client.stream("GET", url, headers={"user-agent": _UA}, timeout=600.0) as r:
            if r.status_code != 200:
                log.warning("sar scene %s http %s", item.get("id"), r.status_code)
                return []
            with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as fh:
                tmp = fh.name
                async for chunk in r.aiter_bytes(1 << 20):
                    fh.write(chunk)
    except Exception as e:  # noqa: BLE001 — one bad scene must not kill the scan
        log.warning("sar download failed for %s: %s", item.get("id"), e)
        return []
    try:
        with rasterio.open(tmp) as ds:
            # Geolocation precedence:
            #   1. the raster's own CRS+transform (a georeferenced product)
            #   2. the SAFE geolocationGrid (the anonymous pixel-space product)
            # Without (2) an anonymous scene is unlocatable and we report
            # nothing rather than a made-up position.
            gt = None
            if ds.crs is not None:
                gt = GeoTransform(
                    lon0=ds.transform.c,
                    lat0=ds.transform.f,
                    step_lon=ds.transform.a,
                    step_lat=ds.transform.e,
                )
            else:
                grid = item.get("geogrid")
                if grid is not None:
                    gt = GeoGridTransform(grid)
                else:
                    log.info(
                        "sar scene %s has no CRS and no geolocationGrid — "
                        "skipping (pixel-space product, unlocatable)",
                        item.get("id"),
                    )
                    return []
            # Read WINDOWED, never the whole scene. Measured on a real Arabian
            # Sea VV GRD: 25139x13200 = 331.8 M px. `ds.read(1)` pulls all of it
            # as uint16 (~660 MB) and then detect_targets makes several MORE
            # full-size float32 copies for the median/p99 background — enough to
            # get the process OOM-killed on a box that already runs the API and
            # two sidecars (71 of 121 GB in use when this was measured). CFAR is
            # inherently local: the background is estimated per window anyway, so
            # windowing is both the tractable and the correct reading.
            return _detect_windowed(ds, gt)
    except Exception as e:  # noqa: BLE001
        log.warning("sar detect failed for %s: %s", item.get("id"), e)
        return []
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _detect_windowed(
    ds: Any, gt: GeoTransform | GeoGridTransform, win: int = _CFAR_WINDOW_PX
) -> list[Detection]:
    """CFAR over a scene, one window at a time, keeping peak memory bounded.

    Windows are advanced by half their size so a vessel straddling a boundary is
    still fully inside some window — a plain non-overlapping tiling drops
    everything within `win/2` of a seam, which on a 25 k px scene is thousands of
    pixels of coastline and busy water.

    Handles both geolocation kinds. An affine `GeoTransform` is simply offset to
    the window's origin. A `GeoGridTransform` is instead REUSED as-is, because
    it already maps absolute scene pixel coordinates — offsetting it would be
    meaningless (it has no lon0/step to offset).
    """
    out: list[Detection] = []
    height, width = ds.height, ds.width
    step = max(1, win // 2)
    for y0 in range(0, height, step):
        y1 = min(y0 + win, height)
        if y1 - y0 < 8:
            continue
        for x0 in range(0, width, step):
            x1 = min(x0 + win, width)
            if x1 - x0 < 8:
                continue
            arr = ds.read(1, window=((y0, y1), (x0, x1)))
            if isinstance(gt, GeoGridTransform):
                # Absolute-pixel grid: shift the window so detections index the
                # full-scene grid rather than the window's local origin.
                sub = GeoGridTransform(gt.grid, row_offset=y0, col_offset=x0)
            else:
                sub = GeoTransform(
                    lon0=gt.lon0 + x0 * gt.step_lon,
                    lat0=gt.lat0 + y0 * gt.step_lat,
                    step_lon=gt.step_lon,
                    step_lat=gt.step_lat,
                )
            out.extend(detect_targets(arr, transform=sub))
    return out
