"""Dataset ingest: CSV / JSON / NDJSON / GeoJSON / KML parsing, type inference, caps.

Pure stdlib (``csv``, ``json``, ``xml.etree``, ``zipfile``) — no pandas, no
geopandas. Type inference casts CSV's
all-string cells to ``int | float | bool | str`` (JSON/NDJSON already carry
typed values from ``json.loads``); the per-column ``schema`` is the union of
observed value types, matching ``docs/foundry-plan.md``.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
from typing import Any

from app.foundry.store import MAX_ROWS_PER_DATASET, MAX_UPLOAD_BYTES, FoundryError

# A canonical decimal/float: no leading zeros (except "0"/"0.x"), no leading
# '+', no underscores — forms that ``float()`` silently accepts but that carry
# information (leading-zero IDs like "007.0") we must NOT flatten. ``int`` is
# handled by an exact round-trip check instead.
_FLOAT_RE = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$")

PIN_TYPES = {"str", "int", "float", "bool"}


def _cast_scalar(raw: str) -> Any:
    """Infer a scalar type from a CSV string WITHOUT losing information.

    ``int``/``float`` are only applied when the string round-trips exactly, so
    identifier-like values that ``int()``/``float()`` would silently mangle —
    leading zeros ("007"), leading '+' ("+1"), underscores ("1_000"), padded
    refs — are preserved as ``str``. Entity resolution and ontology binding key
    on exactly these columns, so this is the difference between clean and
    silently-corrupted IDs downstream."""
    s = raw.strip()
    if s == "":
        return None
    low = s.lower()
    if low in ("true", "false"):
        return low == "true"
    try:
        i = int(s)
        if str(i) == s:  # canonical integer only — "007" != "7", stays str
            return i
    except ValueError:
        pass
    if _FLOAT_RE.match(s):
        try:
            f = float(s)
            # "1e999" parses to inf without raising — that neither round-trips
            # nor survives JSON serialization (Starlette rejects inf), so keep
            # the original string instead of silently corrupting it.
            if math.isfinite(f):
                return f
        except ValueError:
            pass
    return raw


def _coerce_to(value: Any, type_: str) -> Any:
    """Force ``value`` to a pinned type; unconvertible values become ``None``
    (str-pin never fails). Used by operator column type-pinning on upload."""
    if value is None:
        return None
    if type_ == "str":
        return value if isinstance(value, str) else _scalar_to_str(value)
    if type_ == "bool":
        if isinstance(value, bool):
            return value
        low = str(value).strip().lower()
        if low in ("true", "1", "yes", "y"):
            return True
        if low in ("false", "0", "no", "n"):
            return False
        return None
    if type_ == "int":
        try:
            if isinstance(value, str):
                # Exact integer string first (preserves big ints); else route
                # through float so scientific notation ("1e3") and decimals
                # ("1.9") coerce consistently instead of "1e3" dropping to None.
                try:
                    return int(value)
                except ValueError:
                    return int(float(value))
            return int(value)
        except (ValueError, TypeError, OverflowError):
            return None
    if type_ == "float":
        try:
            f = float(value)
            # Same non-finite guard as _cast_scalar: inf/nan break JSON
            # serialization (Starlette rejects them), so drop to None.
            return f if math.isfinite(f) else None
        except (ValueError, TypeError):
            return None
    return value


def _scalar_to_str(value: Any) -> str:
    # bool must not stringify to Python's "True"/"False" surprises silently —
    # keep JSON-ish lowercase for pinned string columns.
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def apply_type_pins(
    rows: list[dict[str, Any]],
    schema: list[dict[str, str]],
    pins: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Override the inferred type of named columns (operator type-pinning). A
    pin of ``str`` protects ID columns (MMSI/ICAO24/ZIP) that would otherwise
    infer as ``int``. Returns ``(rows, schema)`` with pinned columns coerced
    and their schema type set. Unknown pin types raise 422."""
    bad = {t for t in pins.values() if t not in PIN_TYPES}
    if bad:
        raise FoundryError(
            422, f"unknown pin type(s) {sorted(bad)}; must be one of {sorted(PIN_TYPES)}"
        )
    if not pins:
        return rows, schema
    out_rows = [
        {k: (_coerce_to(v, pins[k]) if k in pins else v) for k, v in r.items()} for r in rows
    ]
    out_schema = [
        {**col, "type": pins[col["name"]]} if col["name"] in pins else col for col in schema
    ]
    return out_rows, out_schema


def parse_csv(text: str) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(text))
    rows: list[dict[str, Any]] = []
    for raw_row in reader:
        rows.append(
            {
                k: (_cast_scalar(v) if isinstance(v, str) else v)
                for k, v in raw_row.items()
                if k is not None
            }
        )
    return rows


def parse_json_array(text: str) -> list[dict[str, Any]]:
    data = json.loads(text)
    if not isinstance(data, list):
        raise FoundryError(422, "JSON upload must be an array of objects")
    for item in data:
        if not isinstance(item, dict):
            raise FoundryError(422, "JSON upload must be an array of objects")
    return data


def parse_ndjson(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        if not isinstance(item, dict):
            raise FoundryError(422, "NDJSON lines must each be an object")
        rows.append(item)
    return rows


# ── geospatial files ──────────────────────────────────────────────────────────
# A dataset is rows, so a geospatial file has to become rows: one row per
# feature, its own properties at the top level, plus the coordinate pair and the
# raw geometry. That is enough for foundry/geo.py's lat/lon sniffer to serve the
# file straight back out of GET /api/foundry/datasets/{id}/geo, and enough for a
# binding to mint ontology objects from it.
#
# Stdlib only: json for GeoJSON, xml.etree for KML, zipfile for KMZ. Shapefile
# and LAS/LAZ are deliberately absent — both need a real dependency and neither
# has asked for itself yet.

_GEOM_KEY = "geometry"
_GEOM_TYPE_KEY = "geometry_type"


def _flatten_coords(node: Any, out: list[tuple[float, float]]) -> None:
    """Every [lon, lat] pair anywhere in a GeoJSON coordinates array.

    Recursive because the nesting depth is the geometry type: Point is one
    pair, Polygon is rings of pairs, MultiPolygon one deeper again.
    """
    if not isinstance(node, (list, tuple)):
        return
    if (
        len(node) >= 2
        and isinstance(node[0], (int, float))
        and isinstance(node[1], (int, float))
        and not isinstance(node[0], bool)
        and not isinstance(node[1], bool)
    ):
        out.append((float(node[0]), float(node[1])))
        return
    for child in node:
        _flatten_coords(child, out)


def _representative_point(geometry: Any) -> tuple[float | None, float | None]:
    """One (lon, lat) for a feature: the point itself, or the centre of the
    bounding box for anything with extent.

    The bbox centre, not the centroid — a centroid needs the geometry's area and
    can land outside a concave shape, and this value exists to put a pin on a
    map, not to do geometry.
    """
    if not isinstance(geometry, dict):
        return None, None
    pairs: list[tuple[float, float]] = []
    if geometry.get("type") == "GeometryCollection":
        for g in geometry.get("geometries") or []:
            _flatten_coords((g or {}).get("coordinates"), pairs)
    else:
        _flatten_coords(geometry.get("coordinates"), pairs)
    if not pairs:
        return None, None
    lons = [p[0] for p in pairs]
    lats = [p[1] for p in pairs]
    return (min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2


def _geo_row(properties: Any, geometry: Any) -> dict[str, Any]:
    """One feature as a row. The feature's own properties keep their names and
    their values; ``lat``/``lon`` are only filled in when the feature did not
    already carry columns by those names, because a file that states its own
    coordinates knows better than a derived bbox centre."""
    row: dict[str, Any] = dict(properties) if isinstance(properties, dict) else {}
    lon, lat = _representative_point(geometry)
    if lat is not None and "lat" not in row:
        row["lat"] = lat
    if lon is not None and "lon" not in row:
        row["lon"] = lon
    if isinstance(geometry, dict):
        row.setdefault(_GEOM_TYPE_KEY, geometry.get("type"))
        # The geometry travels as a JSON string: a dataset cell is a scalar, and
        # keeping the original means a later transform can still read the shape.
        row.setdefault(_GEOM_KEY, json.dumps(geometry, separators=(",", ":")))
    return row


def parse_geojson(text: str) -> list[dict[str, Any]]:
    """A FeatureCollection, a bare Feature, or a bare geometry, as rows."""
    data = json.loads(text)
    if not isinstance(data, dict):
        raise FoundryError(422, "GeoJSON upload must be an object")
    kind = data.get("type")
    if kind == "FeatureCollection":
        features = data.get("features")
        if not isinstance(features, list):
            raise FoundryError(422, "FeatureCollection has no features array")
        return [
            _geo_row((f or {}).get("properties"), (f or {}).get("geometry"))
            for f in features
            if isinstance(f, dict)
        ]
    if kind == "Feature":
        return [_geo_row(data.get("properties"), data.get("geometry"))]
    if kind:
        return [_geo_row({}, data)]
    raise FoundryError(422, "GeoJSON upload has no type")


def _local(tag: str) -> str:
    """``{http://www.opengis.net/kml/2.2}Placemark`` → ``Placemark``.

    KML in the wild carries 2.2, 2.1, no namespace at all, and Google's
    extension namespace side by side, so matching on the local name is the only
    thing that reads every file the same way.
    """
    return tag.rpartition("}")[2]


def _kml_coords(placemark: Any) -> Any:
    """The placemark's geometry as a GeoJSON-ish dict, or None.

    KML writes ``lon,lat[,alt]`` tuples separated by whitespace. The type is
    read from the element that holds them, so a Polygon keeps its rings shape
    rather than collapsing to a bag of points. A MultiGeometry placemark yields
    its FIRST geometry: a dataset row holds one shape, and picking the first in
    document order is at least deterministic.
    """
    kml_to_geojson = {
        "Point": "Point",
        "LineString": "LineString",
        "LinearRing": "LineString",
        "Polygon": "Polygon",
    }
    for el in placemark.iter():
        name = _local(el.tag)
        if name != "coordinates" or not (el.text or "").strip():
            continue
        pairs: list[list[float]] = []
        for chunk in (el.text or "").split():
            parts = chunk.split(",")
            if len(parts) < 2:
                continue
            try:
                pairs.append([float(parts[0]), float(parts[1])])
            except ValueError:
                continue
        if not pairs:
            continue
        # The nearest enclosing geometry element decides the shape.
        holder = "Point"
        for anc in placemark.iter():
            if _local(anc.tag) in kml_to_geojson and el in list(anc.iter()):
                holder = _local(anc.tag)
                break
        gtype = kml_to_geojson.get(holder, "Point")
        if gtype == "Point":
            return {"type": "Point", "coordinates": pairs[0]}
        if gtype == "Polygon":
            return {"type": "Polygon", "coordinates": [pairs]}
        return {"type": "LineString", "coordinates": pairs}
    return None


def parse_kml(text: str) -> list[dict[str, Any]]:
    """Every Placemark as a row: name, description, its ExtendedData fields, and
    its geometry."""
    from xml.etree import ElementTree

    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as exc:
        raise FoundryError(422, f"could not parse KML: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for pm in root.iter():
        if _local(pm.tag) != "Placemark":
            continue
        props: dict[str, Any] = {}
        for child in pm:
            name = _local(child.tag)
            if name in ("name", "description", "styleUrl", "address") and child.text:
                props[name] = child.text.strip()
        # <ExtendedData><Data name="pop"><value>123</value></Data></ExtendedData>
        # and the SimpleData variant schemas use.
        for el in pm.iter():
            name = _local(el.tag)
            key = el.get("name")
            if not key:
                continue
            if name == "Data":
                value = next(
                    (v.text for v in el if _local(v.tag) == "value"), None
                )
            elif name == "SimpleData":
                value = el.text
            else:
                continue
            if value is not None:
                props[key] = _cast_scalar(value)
        rows.append(_geo_row(props, _kml_coords(pm)))
    return rows


def parse_kmz(content: bytes) -> list[dict[str, Any]]:
    """A KMZ is a zip whose payload is a KML, conventionally ``doc.kml``."""
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".kml")]
            if not names:
                raise FoundryError(422, "KMZ archive contains no .kml file")
            # doc.kml is the convention; otherwise take the first, in archive
            # order, so the choice is at least deterministic.
            name = next((n for n in names if n.lower().endswith("doc.kml")), names[0])
            with zf.open(name) as fh:
                payload = fh.read(MAX_UPLOAD_BYTES + 1)
    except zipfile.BadZipFile as exc:
        raise FoundryError(422, f"could not read KMZ: {exc}") from exc
    if len(payload) > MAX_UPLOAD_BYTES:
        raise FoundryError(
            413, f"KMZ payload too large: > {MAX_UPLOAD_BYTES} bytes uncompressed"
        )
    return parse_kml(payload.decode("utf-8", errors="replace"))


def _value_type(v: Any) -> str:
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    return "str"


def infer_schema(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    """``[{name, type}]`` — column order = first-seen order across rows."""
    columns: list[str] = []
    seen: set[str] = set()
    for r in rows:
        for k in r:
            if k not in seen:
                seen.add(k)
                columns.append(k)
    schema: list[dict[str, str]] = []
    for col in columns:
        types: set[str] = set()
        for r in rows:
            v = r.get(col)
            if v is None:
                continue
            types.add(_value_type(v))
        if not types:
            t = "str"
        elif types == {"int"}:
            t = "int"
        elif types <= {"int", "float"}:
            t = "float"
        elif types == {"bool"}:
            t = "bool"
        else:
            t = "str"
        schema.append({"name": col, "type": t})
    return schema


_GEOJSON_TYPES = {
    "FeatureCollection",
    "Feature",
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
}


def _declares_geojson(text: str) -> bool:
    """True when a ``.json`` body is really GeoJSON. Parse failures answer False
    so the JSON-array path keeps ownership of the error message."""
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return False
    return isinstance(data, dict) and data.get("type") in _GEOJSON_TYPES


def parse_upload(
    filename: str, content: bytes
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Parse an uploaded file into ``(rows, schema)``.

    Enforces the 25 MB size cap and the 200k row cap (413 / 422 respectively —
    the route layer maps ``FoundryError.status_code``). Format is chosen by
    extension: ``.csv`` → CSV, ``.ndjson``/``.jsonl`` → NDJSON,
    ``.geojson`` → GeoJSON features, ``.kml``/``.kmz`` → KML placemarks,
    ``.json`` → GeoJSON if it declares a GeoJSON type, else a JSON array.
    """
    if len(content) > MAX_UPLOAD_BYTES:
        raise FoundryError(
            413, f"upload too large: {len(content)} bytes > {MAX_UPLOAD_BYTES}"
        )
    name = filename.lower()
    # KMZ is a zip, so it is the one format that must not be decoded first.
    if name.endswith(".kmz"):
        rows = parse_kmz(content)
        if len(rows) > MAX_ROWS_PER_DATASET:
            raise FoundryError(
                422, f"row cap exceeded: {len(rows)} > {MAX_ROWS_PER_DATASET}"
            )
        return rows, infer_schema(rows)
    text = content.decode("utf-8", errors="replace")
    try:
        if name.endswith(".csv"):
            rows = parse_csv(text)
        elif name.endswith(".ndjson") or name.endswith(".jsonl"):
            rows = parse_ndjson(text)
        elif name.endswith(".geojson"):
            rows = parse_geojson(text)
        elif name.endswith(".kml"):
            rows = parse_kml(text)
        elif name.endswith(".json"):
            # A .geojson renamed .json is common enough that the extension is
            # not worth trusting over the file's own declared type.
            rows = (
                parse_geojson(text) if _declares_geojson(text) else parse_json_array(text)
            )
        else:
            # Fall back to sniffing: valid JSON array first, else CSV.
            stripped = text.lstrip()
            if stripped.startswith("["):
                rows = parse_json_array(text)
            else:
                rows = parse_csv(text)
    except FoundryError:
        raise
    except (json.JSONDecodeError, csv.Error, ValueError) as exc:
        # Malformed user content is a 422, not an uncaught 500.
        raise FoundryError(422, f"could not parse upload: {exc}") from exc
    if len(rows) > MAX_ROWS_PER_DATASET:
        raise FoundryError(
            422, f"row cap exceeded: {len(rows)} > {MAX_ROWS_PER_DATASET}"
        )
    schema = infer_schema(rows)
    return rows, schema
