"""Guards for the geospatial upload readers (foundry/ingest.py).

The contract is not "we can read GeoJSON" — it is that a geospatial file lands
as rows the rest of Foundry already knows what to do with: the lat/lon sniffer
in ``foundry/geo.py`` has to find the coordinates without being told, and a
binding has to be able to mint ontology objects from the feature properties.
So the round trip, not the parse, is what is pinned here.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from app.foundry.geo import detect_geo, to_feature_collection
from app.foundry.ingest import parse_upload
from app.foundry.store import FoundryError

FC = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "Rotterdam", "teu": 13_400_000},
            "geometry": {"type": "Point", "coordinates": [4.4, 51.9]},
        },
        {
            "type": "Feature",
            "properties": {"name": "Suez"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[32.0, 30.0], [32.6, 30.0], [32.6, 31.0], [32.0, 31.0]]],
            },
        },
    ],
}

KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark>
    <name>Rotterdam</name>
    <description>Europoort</description>
    <ExtendedData><Data name="teu"><value>13400000</value></Data></ExtendedData>
    <Point><coordinates>4.4,51.9,0</coordinates></Point>
  </Placemark>
  <Placemark>
    <name>Suez</name>
    <Polygon><outerBoundaryIs><LinearRing>
      <coordinates>32.0,30.0 32.6,30.0 32.6,31.0 32.0,31.0</coordinates>
    </LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
</Document></kml>
"""


def _up(name: str, body: str | bytes):  # type: ignore[no-untyped-def]
    return parse_upload(name, body if isinstance(body, bytes) else body.encode())


# ── GeoJSON ───────────────────────────────────────────────────────────────────


def test_geojson_is_one_row_per_feature() -> None:
    rows, _ = _up("ports.geojson", json.dumps(FC))
    assert [r["name"] for r in rows] == ["Rotterdam", "Suez"]


def test_geojson_point_keeps_its_exact_coordinates() -> None:
    rows, _ = _up("ports.geojson", json.dumps(FC))
    assert (rows[0]["lat"], rows[0]["lon"]) == (51.9, 4.4)


def test_geojson_polygon_gets_its_bbox_centre() -> None:
    rows, _ = _up("ports.geojson", json.dumps(FC))
    assert (rows[1]["lat"], rows[1]["lon"]) == (30.5, 32.3)


def test_geometry_survives_as_a_string_cell() -> None:
    rows, _ = _up("ports.geojson", json.dumps(FC))
    assert json.loads(rows[1]["geometry"])["type"] == "Polygon"
    assert rows[1]["geometry_type"] == "Polygon"


def test_feature_properties_win_over_derived_coordinates() -> None:
    """A file that states its own lat/lon knows better than a bbox centre."""
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"lat": 1.0, "lon": 2.0},
                "geometry": {"type": "Point", "coordinates": [99.0, 88.0]},
            }
        ],
    }
    rows, _ = _up("x.geojson", json.dumps(fc))
    assert (rows[0]["lat"], rows[0]["lon"]) == (1.0, 2.0)


def test_a_bare_feature_and_a_bare_geometry_both_load() -> None:
    rows, _ = _up("one.geojson", json.dumps(FC["features"][0]))
    assert rows[0]["name"] == "Rotterdam"
    rows, _ = _up("g.geojson", json.dumps({"type": "Point", "coordinates": [1.0, 2.0]}))
    assert (rows[0]["lat"], rows[0]["lon"]) == (2.0, 1.0)


def test_a_feature_with_no_geometry_is_still_a_row() -> None:
    fc = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {"name": "nowhere"}, "geometry": None}],
    }
    rows, _ = _up("x.geojson", json.dumps(fc))
    assert rows == [{"name": "nowhere"}]


def test_geojson_renamed_json_is_still_read_as_geojson() -> None:
    rows, _ = _up("ports.json", json.dumps(FC))
    assert rows[0]["lat"] == 51.9


def test_a_plain_json_array_is_unaffected() -> None:
    rows, _ = _up("rows.json", json.dumps([{"a": 1}, {"a": 2}]))
    assert rows == [{"a": 1}, {"a": 2}]


def test_a_json_object_that_is_not_geojson_still_reports_the_array_error() -> None:
    with pytest.raises(FoundryError) as exc:
        _up("x.json", json.dumps({"not": "geojson"}))
    assert "array of objects" in str(exc.value.detail)


def test_geojson_without_a_type_is_a_422() -> None:
    with pytest.raises(FoundryError) as exc:
        _up("x.geojson", json.dumps({"features": []}))
    assert exc.value.status_code == 422


# ── KML / KMZ ─────────────────────────────────────────────────────────────────


def test_kml_placemarks_become_rows() -> None:
    rows, _ = _up("ports.kml", KML)
    assert [r["name"] for r in rows] == ["Rotterdam", "Suez"]
    assert rows[0]["description"] == "Europoort"


def test_kml_point_coordinates_are_lon_lat_alt() -> None:
    """KML orders a coordinate lon,lat — reading it as lat,lon puts every pin in
    the wrong hemisphere, which is the classic way to get this wrong."""
    rows, _ = _up("ports.kml", KML)
    assert (rows[0]["lat"], rows[0]["lon"]) == (51.9, 4.4)


def test_kml_polygon_keeps_its_ring() -> None:
    rows, _ = _up("ports.kml", KML)
    geom = json.loads(rows[1]["geometry"])
    assert geom["type"] == "Polygon"
    assert len(geom["coordinates"][0]) == 4


def test_kml_extended_data_becomes_a_typed_column() -> None:
    rows, schema = _up("ports.kml", KML)
    assert rows[0]["teu"] == 13_400_000
    assert {c["name"]: c["type"] for c in schema}["teu"] == "int"


def test_kml_without_a_namespace_reads_the_same() -> None:
    bare = KML.replace(' xmlns="http://www.opengis.net/kml/2.2"', "")
    assert [r["name"] for r in _up("x.kml", bare)[0]] == ["Rotterdam", "Suez"]


def test_kml_2_1_namespace_reads_the_same() -> None:
    old = KML.replace("kml/2.2", "kml/2.1")
    assert [r["name"] for r in _up("x.kml", old)[0]] == ["Rotterdam", "Suez"]


def test_malformed_kml_is_a_422_not_a_500() -> None:
    with pytest.raises(FoundryError) as exc:
        _up("x.kml", "<kml><Placemark>")
    assert exc.value.status_code == 422


def test_kmz_reads_its_inner_kml() -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("images/logo.png", b"not kml")
        zf.writestr("doc.kml", KML)
    rows, _ = _up("ports.kmz", buf.getvalue())
    assert [r["name"] for r in rows] == ["Rotterdam", "Suez"]


def test_kmz_without_a_kml_is_a_422() -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", b"nope")
    with pytest.raises(FoundryError) as exc:
        _up("x.kmz", buf.getvalue())
    assert exc.value.status_code == 422


def test_a_kmz_that_is_not_a_zip_is_a_422() -> None:
    with pytest.raises(FoundryError) as exc:
        _up("x.kmz", b"definitely not a zip")
    assert exc.value.status_code == 422


# ── the round trip that is the actual point ───────────────────────────────────


@pytest.mark.parametrize("name,body", [("p.geojson", json.dumps(FC)), ("p.kml", KML)])
def test_an_uploaded_map_file_comes_back_out_of_the_geo_route(name: str, body: str) -> None:
    """detect_geo has to find the coordinates unaided, because nothing in the
    upload path tells it which columns they are."""
    rows, schema = _up(name, body)
    cols = detect_geo(schema, rows)
    assert cols == {"lat_col": "lat", "lon_col": "lon"}
    fc = to_feature_collection(rows, **{"lat_col": cols["lat_col"], "lon_col": cols["lon_col"]})
    assert [f["geometry"]["coordinates"] for f in fc["features"]] == [
        [4.4, 51.9],
        [32.3, 30.5],
    ]
    assert fc["features"][0]["properties"]["name"] == "Rotterdam"
