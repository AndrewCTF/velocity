"""GET /api/airspace/tfr — FAA Temporary Flight Restrictions, as GeoJSON.

List: https://tfr.faa.gov/tfrapi/exportTfrList (JSON, ~151 active TFRs;
fields notam_id/type/facility/state/description/creation_date). TtlCache
10min. There is no GeoJSON variant upstream (`exportTfrGeoJson` 404s) — we
build the polygons ourselves from each TFR's XNOTAM detail XML.

Detail: https://tfr.faa.gov/download/detail_<id_underscored>.xml (notam_id
"6/4909" -> "detail_6_4909.xml"), fetched concurrently (bounded semaphore)
and cached per id, 10min. Individual detail failures (network error, 404,
unparseable XML) are skipped — one bad TFR must never fail the whole route.

XNOTAM structure, verified against live tfr.faa.gov detail XML for several
real TFRs on 2026-07-11 (NOT the packed "DDMM.mmmmN" format some XNOTAM
references describe — this feed encodes geoLat/geoLong as plain decimal
degrees with a trailing hemisphere letter, e.g. "33.50390442N",
"086.17944444W"):

- Each `<TfrNot>` has one or more `<aseTFRArea>` blocks ("Area A", "Area B",
  ...) carrying the altitude fields (`valDistVerLower/Upper` +
  `uomDistVerLower/Upper` FT + `codeDistVerLower/Upper` HEI(AGL)/MSL/ALT) and
  an `<AseUid><codeId>` identifying that area.
- The FAA export always (observed on every live TFR checked) also emits an
  `<abdMergedArea>` sibling keyed to the same AseUid `codeId`, containing the
  FINAL merged boundary as a chain of `<Avx codeType="GRC">` vertices — this
  is true even when the underlying shape started life as one or more raw
  circles (`<aseShapes><Abd><Avx codeType="CIR">`, linked to the area via
  `<Aac>` boolean-op records: BASE/UNION/etc). We therefore prefer the
  pre-merged GRC chain when present (it's authoritative and already handles
  any boolean composition) and only fall back to tessellating a raw CIR
  ourselves when no merged boundary exists for an area.
- Circles: `<Avx codeType="CIR">` + `valRadiusArc`/`uomRadiusArc` (NM) around
  a center point -> tessellated into a 64-point closed polygon ring
  (1 NM = 1852 m).

Parsing functions (`parse_grc_chain`, `parse_cir`/`tessellate_circle`,
`parse_tfr_detail`) are pure and unit-tested against a real fixture
(tests/fixtures/tfr_detail_6_4909.xml) with no network/FastAPI involved.
"""

from __future__ import annotations

import asyncio
import math
import xml.etree.ElementTree as ET
from typing import Any

from fastapi import APIRouter, HTTPException

from app.upstream import cache, get_client

router = APIRouter(tags=["airspace"])

TFR_LIST_URL = "https://tfr.faa.gov/tfrapi/exportTfrList"
TFR_DETAIL_URL = "https://tfr.faa.gov/download/detail_{id}.xml"

# 151 active TFRs at last check; a semaphore of 8 concurrent detail fetches
# keeps the burst polite while a 10-min cache (list + per-id detail) means
# this only runs at full cost once per cache window, not per request.
DETAIL_FETCH_CONCURRENCY = 8
LIST_TTL_SEC = 600.0
DETAIL_TTL_SEC = 600.0
FEATURES_TTL_SEC = 600.0

NM_TO_M = 1852.0
CIRCLE_SEGMENTS = 64
_M_PER_DEG_LAT = 111_320.0


def _notam_id_to_filename(notam_id: str) -> str:
    return notam_id.replace("/", "_")


def _parse_geo(value: str) -> float:
    """Parse a geoLat/geoLong value like '33.50390442N' or '111.65W' into
    signed decimal degrees. See module docstring: this feed uses plain
    decimal degrees with a trailing hemisphere letter, not packed DDMM.mmmm."""
    value = value.strip()
    if not value:
        raise ValueError("empty coordinate")
    hemi = value[-1].upper()
    if hemi not in ("N", "S", "E", "W"):
        raise ValueError(f"no hemisphere letter in {value!r}")
    magnitude = float(value[:-1])
    if hemi in ("S", "W"):
        magnitude = -magnitude
    return magnitude


def _avx_point(avx: ET.Element) -> tuple[float, float] | None:
    """(lon, lat) from an Avx element's geoLat/geoLong, or None if missing/bad."""
    lat_s = avx.findtext("geoLat")
    lon_s = avx.findtext("geoLong")
    if not lat_s or not lon_s:
        return None
    try:
        lat = _parse_geo(lat_s)
        lon = _parse_geo(lon_s)
    except ValueError:
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None
    return (lon, lat)


def tessellate_circle(
    center_lon: float, center_lat: float, radius_nm: float, segments: int = CIRCLE_SEGMENTS
) -> list[list[float]]:
    """Pure function: center + radius (nautical miles) -> a closed [lon, lat]
    polygon ring of `segments` points (equirectangular approximation — fine
    at TFR scale, typically well under 50 NM radius)."""
    radius_m = radius_nm * NM_TO_M
    lat_rad = math.radians(center_lat)
    m_per_deg_lon = _M_PER_DEG_LAT * math.cos(lat_rad)
    if abs(m_per_deg_lon) < 1e-9:
        m_per_deg_lon = 1e-9
    ring: list[list[float]] = []
    for i in range(segments):
        theta = 2.0 * math.pi * i / segments
        dlat = (radius_m * math.cos(theta)) / _M_PER_DEG_LAT
        dlon = (radius_m * math.sin(theta)) / m_per_deg_lon
        ring.append([center_lon + dlon, center_lat + dlat])
    ring.append(list(ring[0]))  # close the ring
    return ring


def parse_grc_chain(avx_elements: list[ET.Element]) -> list[list[float]]:
    """Pure function: ordered GRC-type Avx elements -> a closed [lon, lat] ring."""
    ring: list[list[float]] = []
    for avx in avx_elements:
        pt = _avx_point(avx)
        if pt is None:
            continue
        ring.append([pt[0], pt[1]])
    if len(ring) >= 2 and ring[0] != ring[-1]:
        ring.append(list(ring[0]))
    return ring


def parse_cir(avx: ET.Element, segments: int = CIRCLE_SEGMENTS) -> list[list[float]] | None:
    """Pure function: a single CIR-type Avx element -> a tessellated ring, or
    None if the element lacks a center/radius or uses a non-NM unit we don't
    trust ourselves to rescale silently."""
    pt = _avx_point(avx)
    if pt is None:
        return None
    radius_s = avx.findtext("valRadiusArc")
    uom = (avx.findtext("uomRadiusArc") or "NM").strip().upper()
    if not radius_s or uom != "NM":
        return None
    try:
        radius = float(radius_s)
    except ValueError:
        return None
    if radius <= 0:
        return None
    lon, lat = pt
    return tessellate_circle(lon, lat, radius, segments)


def _altitude(area: ET.Element) -> dict[str, Any]:
    def val(tag: str) -> float | None:
        s = area.findtext(tag)
        if s is None or s == "":
            return None
        try:
            return float(s)
        except ValueError:
            return None

    return {
        "alt_low": val("valDistVerLower"),
        "alt_low_uom": area.findtext("uomDistVerLower") or None,
        "alt_low_code": area.findtext("codeDistVerLower") or None,
        "alt_high": val("valDistVerUpper"),
        "alt_high_uom": area.findtext("uomDistVerUpper") or None,
        "alt_high_code": area.findtext("codeDistVerUpper") or None,
    }


def parse_tfr_detail(xml_bytes: bytes) -> list[dict[str, Any]]:
    """Pure function: one TFR's XNOTAM detail XML -> a list of shape dicts.

    Each dict: {"ring": [[lon,lat], ...] (closed), "alt_low", "alt_low_uom",
    "alt_low_code", "alt_high", "alt_high_uom", "alt_high_code", "effective",
    "expire"}. A TFR can define MULTIPLE physical areas ("Area A", "Area B",
    ...) -> one dict per area, each becoming its own GeoJSON feature at the
    call site. Areas with no resolvable boundary are skipped, never
    fabricated. Never raises — malformed/empty XML yields an empty list.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return []

    shapes: list[dict[str, Any]] = []
    for not_el in root.iter("Not"):
        effective = not_el.findtext("dateEffective")
        expire = not_el.findtext("dateExpire")
        for area_group in not_el.iter("TFRAreaGroup"):
            # Pre-merged boundaries, keyed by AseUid codeId.
            merged_by_id: dict[str, list[ET.Element]] = {}
            for merged in area_group.findall("abdMergedArea"):
                aid = merged.findtext("AbdUid/AseUid/codeId")
                if aid is None:
                    continue
                merged_by_id[aid] = merged.findall("Avx")
            # Fallback: raw CIR shapes, keyed by their own AseUid codeId —
            # only consulted when an area has no merged boundary at all.
            cir_by_id: dict[str, ET.Element] = {}
            for shp in area_group.findall("aseShapes"):
                aid = shp.findtext("AseUid/codeId")
                if aid is None:
                    continue
                for avx in shp.iter("Avx"):
                    if (avx.findtext("codeType") or "").upper() == "CIR":
                        cir_by_id[aid] = avx
                        break

            for area in area_group.findall("aseTFRArea"):
                aid = area.findtext("AseUid/codeId")
                ring: list[list[float]] | None = None
                if aid is not None and aid in merged_by_id:
                    avxs = merged_by_id[aid]
                    grc_avxs = [
                        a for a in avxs if (a.findtext("codeType") or "").upper() == "GRC"
                    ]
                    if len(grc_avxs) >= 3:
                        ring = parse_grc_chain(grc_avxs)
                    elif len(avxs) == 1 and (avxs[0].findtext("codeType") or "").upper() == "CIR":
                        ring = parse_cir(avxs[0])
                if not ring and aid is not None and aid in cir_by_id:
                    ring = parse_cir(cir_by_id[aid])
                if not ring or len(ring) < 4:
                    continue  # no usable boundary — skip this area, don't fabricate one

                shape: dict[str, Any] = {"ring": ring, "effective": effective, "expire": expire}
                shape.update(_altitude(area))
                shapes.append(shape)
    return shapes


async def list_tfrs() -> list[dict[str, Any]]:
    async def load() -> list[dict[str, Any]]:
        r = await get_client().get(TFR_LIST_URL)
        if r.status_code != 200:
            raise HTTPException(502, f"tfr list upstream {r.status_code}")
        data = r.json()
        return data if isinstance(data, list) else []

    return await cache.get_or_fetch("airspace:tfr:list", LIST_TTL_SEC, load)


async def _fetch_detail_bytes(notam_id: str) -> bytes | None:
    async def load() -> bytes | None:
        filename = _notam_id_to_filename(notam_id)
        url = TFR_DETAIL_URL.format(id=filename)
        try:
            r = await get_client().get(url)
        except Exception:  # noqa: BLE001 — one bad TFR detail must not fail the route
            return None
        if r.status_code != 200:
            return None
        return r.content

    return await cache.get_or_fetch(f"airspace:tfr:detail:{notam_id}", DETAIL_TTL_SEC, load)


async def _tfr_features(entry: dict[str, Any], sem: asyncio.Semaphore) -> list[dict[str, Any]]:
    notam_id = entry.get("notam_id")
    if not notam_id:
        return []
    async with sem:
        xml_bytes = await _fetch_detail_bytes(notam_id)
    if not xml_bytes:
        return []
    try:
        shapes = parse_tfr_detail(xml_bytes)
    except Exception:  # noqa: BLE001 — malformed detail XML must not fail the route
        return []

    feats: list[dict[str, Any]] = []
    for i, shape in enumerate(shapes):
        feats.append(
            {
                "type": "Feature",
                "id": f"tfr:{notam_id}:{i}",
                "geometry": {"type": "Polygon", "coordinates": [shape["ring"]]},
                "properties": {
                    "notam_id": notam_id,
                    "type": entry.get("type"),
                    "facility": entry.get("facility"),
                    "state": entry.get("state"),
                    "description": entry.get("description"),
                    "alt_low": shape.get("alt_low"),
                    "alt_low_uom": shape.get("alt_low_uom"),
                    "alt_low_code": shape.get("alt_low_code"),
                    "alt_high": shape.get("alt_high"),
                    "alt_high_uom": shape.get("alt_high_uom"),
                    "alt_high_code": shape.get("alt_high_code"),
                    "effective": shape.get("effective"),
                    "expire": shape.get("expire"),
                    "kind": "tfr",
                    "source": "faa-tfr",
                },
            }
        )
    return feats


async def _build_feature_collection() -> dict[str, Any]:
    entries = await list_tfrs()
    sem = asyncio.Semaphore(DETAIL_FETCH_CONCURRENCY)
    results = await asyncio.gather(
        *(_tfr_features(e, sem) for e in entries), return_exceptions=True
    )
    feats: list[dict[str, Any]] = []
    for r in results:
        if isinstance(r, BaseException):
            continue  # one bad TFR detail must not fail the whole route
        feats.extend(r)
    return {"type": "FeatureCollection", "features": feats}


@router.get("/api/airspace/tfr")
async def airspace_tfr() -> dict[str, Any]:
    return await cache.get_or_fetch(
        "airspace:tfr:features", FEATURES_TTL_SEC, _build_feature_collection
    )
