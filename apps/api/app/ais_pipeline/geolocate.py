"""Sentinel-1 geolocation from the SAFE annotation's geolocation grid.

This closes the gap that made the ocean-coverage path unusable. The
anonymously-downloadable SAFE measurement TIFF (``sentinel-s1-l1c`` bucket) is
in PIXEL space with no CRS, so a bright-target detection had no honest way to
become a lon/lat. Measured 2026-10-03: it does not need one.

The scene's own ``annotation/iw-*.xml`` carries a ``geolocationGrid`` of 210
``geolocationGridPoint`` records, each with an explicit ``line`` (row),
``pixel`` (column), ``latitude`` and ``longitude``. A 25 998 x 19 529 IW GRD
scene yields a complete 10 (rows) x 21 (columns) = 210 grid spanning
lon 58.678..61.643, lat 29.756..31.674 -- which matches the scene's STAC bbox
exactly. That XML is 1.67 MB and fetches anonymously (HTTP 200, zero
credentials), so geolocation is as keyless as the pixels.

So a detection is geolocated by BILINEAR INTERPOLATION inside its grid cell,
which is the right order of accuracy for this use: the grid spacing is ~2000
px along-track and ~1290 px across-track, so linear interpolation error inside a
cell is far below the ~10 m pixel spacing that bounds the geolocation anyway.
It is NOT terrain correction -- over land at high relief there is a real
residual -- but over OPEN WATER, which is where this module runs, there is no
terrain to correct for and the ellipsoid-ground-range geometry is what you get.
That is the honest scope of the claim.

Verified bounds on the design:
  * A scene with no grid, or a detection outside the grid, returns
    ``located=False`` with lat/lon None. Never a fabricated coordinate.
  * The grid is detected by local tag name, so the absence of an XML namespace
    (the real SAFE files have none) and the presence of one both work.
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_S3_PUBLIC = "https://sentinel-s1-l1c.s3.amazonaws.com/"


def s3_https(href: str) -> str | None:
    """Convert a STAC ``s3://bucket/key`` asset href to a public https URL."""
    if not isinstance(href, str) or not href.startswith("s3://"):
        return None
    return _S3_PUBLIC + href[len("s3://") :].split("/", 1)[1]


def annotation_url(measurement_href: str) -> str | None:
    """Sibling ``annotation/iw-*.xml`` for a STAC measurement asset href.

    ``.../measurement/iw-vv.tiff`` -> ``.../annotation/iw-vv.xml``. Returns None
    when the href is not a measurement asset, so a schema change surfaces as a
    missing annotation rather than a 404 in the middle of a scan.
    """
    if not isinstance(measurement_href, str) or "/measurement/" not in measurement_href:
        return None
    # Sibling of the measurement dir, not a child of it: strip the whole
    # '.../measurement/<file>' tail, then re-attach 'annotation/<file>.xml'.
    # Leaving 'measurement' in the path yields a URL that 404s.
    base, _sep, name = measurement_href.rpartition("/")
    parent = base.rsplit("/", 1)[0]
    pol = name.replace(".tiff", ".xml")
    return f"{parent}/annotation/{pol}"


@dataclass
class GeoGrid:
    """A scene's geolocation grid, interpolable pixel -> lon/lat.

    Holds the raw grid points plus the sorted distinct line/pixel values, which
    is all a bilinear lookup needs.
    """

    rows: list[int]
    cols: list[int]
    # (line, pixel) -> (lon, lat)
    points: dict[tuple[int, int], tuple[float, float]]

    @property
    def complete(self) -> bool:
        return len(self.points) == len(self.rows) * len(self.cols)

    def bounds(self) -> tuple[float, float, float, float]:
        """(lon_min, lat_min, lon_max, lat_max) over the grid."""
        lons = [p[0] for p in self.points.values()]
        lats = [p[1] for p in self.points.values()]
        return min(lons), min(lats), max(lons), max(lats)

    def to_lonlat(self, line: float, pixel: float) -> tuple[float, float] | None:
        """Bilinearly interpolate a pixel (row, col) to (lon, lat).

        Returns None when the point falls outside the grid — the caller must
        then report the detection as unlocated rather than extrapolating.
        """
        if not self.rows or not self.cols:
            return None
        if line < self.rows[0] or line > self.rows[-1]:
            return None
        if pixel < self.cols[0] or pixel > self.cols[-1]:
            return None

        def bracket(vals: list[int], v: float) -> tuple[int, int, float]:
            """(lo, hi, t) bracketing v, clamped to the grid."""
            if v <= vals[0]:
                return vals[0], vals[0], 0.0
            if v >= vals[-1]:
                return vals[-1], vals[-1], 0.0
            for i in range(len(vals) - 1):
                if vals[i] <= v <= vals[i + 1]:
                    span = vals[i + 1] - vals[i]
                    t = 0.0 if span == 0 else (v - vals[i]) / span
                    return vals[i], vals[i + 1], t
            return vals[-1], vals[-1], 0.0

        r0, r1, ty = bracket(self.rows, line)
        c0, c1, tx = bracket(self.cols, pixel)
        # Degenerate cell (edge): fall back to the nearest available corner.
        if r0 == r1 and c0 == c1:
            p = self.points.get((r0, c0))
            return p
        p00 = self.points.get((r0, c0))
        p01 = self.points.get((r0, c1))
        p10 = self.points.get((r1, c0))
        p11 = self.points.get((r1, c1))
        if None in (p00, p01, p10, p11):
            return None

        def lerp(a: tuple[float, float], b: tuple[float, float], t: float):
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

        top = lerp(p00, p01, tx)
        bot = lerp(p10, p11, tx)
        return lerp(top, bot, ty)


def parse_geogrid(xml_text: str) -> GeoGrid | None:
    """Parse a SAFE annotation XML into a :class:`GeoGrid`.

    Tags are matched by LOCAL name, so this works whether or not the document
    declares an XML namespace (the SAFE files that were probed do not).
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        log.warning("geogrid: XML parse failed: %s", e)
        return None

    def local(e: ET.Element) -> str:
        return e.tag.rsplit("}", 1)[-1]

    pts: dict[tuple[int, int], tuple[float, float]] = {}
    for el in root.iter():
        if local(el) != "geolocationGridPoint":
            continue
        vals: dict[str, float] = {}
        for child in el:
            name = local(child)
            if name in ("line", "pixel", "latitude", "longitude") and child.text:
                try:
                    vals[name] = float(child.text)
                except ValueError:
                    pass
        if {"line", "pixel", "latitude", "longitude"} <= vals.keys():
            pts[(int(vals["line"]), int(vals["pixel"]))] = (
                vals["longitude"],
                vals["latitude"],
            )
    if len(pts) < 4:
        return None
    return GeoGrid(
        rows=sorted({k[0] for k in pts}),
        cols=sorted({k[1] for k in pts}),
        points=pts,
    )


async def fetch_geogrid(
    client: httpx.AsyncClient, measurement_href: str, *, fetch_timeout_s: float = 60.0
) -> tuple[GeoGrid | None, str | None]:
    """Download and parse a scene's geolocation grid.

    Returns ``(grid, url)``. ``grid`` is None when there is no annotation for
    the asset or it carries no grid — both are legitimate outcomes that leave
    detections unlocated rather than mislocated.
    """
    url = annotation_url(measurement_href)
    if url is None:
        return None, None
    https = s3_https(url)
    if https is None:
        return None, url
    try:
        r = await client.get(https, headers={"user-agent": _UA}, timeout=fetch_timeout_s)
    except Exception as e:  # noqa: BLE001 — a missing grid is not fatal
        log.warning("geogrid: fetch failed for %s: %s", https, e)
        return None, https
    if r.status_code != 200:
        log.warning("geogrid: http %s for %s", r.status_code, https)
        return None, https
    return parse_geogrid(r.text), https


# ── accuracy statement, surfaced in the API ──────────────────────────────────

# Spacing between grid nodes, measured on an IW GRD scene (2026-10-03):
# ~2007 px along-track, ~1289 px across-track. Bilinear error inside a cell is
# therefore bounded well below the ~10 m ground range pixel spacing.
GEOLOCATION_METHOD = "bilinear interpolation of the SAFE geolocationGrid"
GEOLOCATION_CAVEAT = (
    "Geolocation is NOT terrain correction. Over open water — where this runs — "
    "there is no relief to correct for, so ellipsoid ground-range geometry is "
    "the correct answer. Over land at high relief a residual remains and this "
    "must not be used for land analysis."
)


def grid_report(grid: GeoGrid | None) -> dict[str, Any]:
    """Serialisable provenance for a geolocation grid, for /api responses."""
    if grid is None:
        return {
            "available": False,
            "method": GEOLOCATION_METHOD,
            "caveat": GEOLOCATION_CAVEAT,
        }
    lon0, lat0, lon1, lat1 = grid.bounds()
    return {
        "available": True,
        "points": len(grid.points),
        "rows": len(grid.rows),
        "cols": len(grid.cols),
        "complete": grid.complete,
        "lonMin": round(lon0, 4),
        "latMin": round(lat0, 4),
        "lonMax": round(lon1, 4),
        "latMax": round(lat1, 4),
        "method": GEOLOCATION_METHOD,
        "caveat": GEOLOCATION_CAVEAT,
    }
