"""Guard: dataset geo-column auto-detection (``GET
/api/foundry/datasets/{id}/geo``) — name heuristics + numeric-range
validation, capped GeoJSON FeatureCollection response."""

from __future__ import annotations

import io

from fastapi.testclient import TestClient


def _upload_csv(client: TestClient, name: str, csv_text: str) -> dict:
    files = {"file": (f"{name}.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    r = client.post(
        "/api/foundry/datasets/upload", files=files, data={"name": name, "description": ""}
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_geo_detects_lat_lon_and_returns_capped_feature_collection(client: TestClient) -> None:
    csv = "id,name,lat,lon\n1,a,10.5,20.5\n2,b,-5.0,100.0\n3,c,40.0,-70.0\n"
    ds = _upload_csv(client, "geo_ok", csv)
    r = client.get(f"/api/foundry/datasets/{ds['id']}/geo")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["lat_col"] == "lat"
    assert body["lon_col"] == "lon"
    assert body["count"] == 3
    fc = body["features"]
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 3
    feat = fc["features"][0]
    assert feat["type"] == "Feature"
    assert feat["geometry"] == {"type": "Point", "coordinates": [20.5, 10.5]}
    assert feat["properties"]["name"] == "a"
    assert "lat" not in feat["properties"]
    assert "lon" not in feat["properties"]
    assert feat["properties"]["_idx"] == 0


def test_geo_no_columns_returns_ok_false_not_404(client: TestClient) -> None:
    csv = "id,name\n1,a\n2,b\n"
    ds = _upload_csv(client, "geo_none", csv)
    r = client.get(f"/api/foundry/datasets/{ds['id']}/geo")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert "reason" in body


def test_geo_out_of_range_values_rejected(client: TestClient) -> None:
    # "lat"/"lon" named columns, but values are clearly not degrees (e.g. a
    # local grid or pixel coordinates far outside +/-90 / +/-180).
    csv = "id,lat,lon\n1,500.0,999.0\n2,600.0,888.0\n"
    ds = _upload_csv(client, "geo_bad_range", csv)
    r = client.get(f"/api/foundry/datasets/{ds['id']}/geo")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False


def test_geo_unknown_dataset_404(client: TestClient) -> None:
    r = client.get("/api/foundry/datasets/does_not_exist/geo")
    assert r.status_code == 404


def test_geo_prefers_exact_name_over_substring(client: TestClient) -> None:
    # "lat"/"lon" exact matches should win over a substring match like
    # "related" or "salon" that would otherwise also satisfy _LAT_CONTAINS.
    csv = "id,lat,lon,related,salon\n1,10.0,20.0,1,2\n2,11.0,21.0,3,4\n"
    ds = _upload_csv(client, "geo_exact_pref", csv)
    r = client.get(f"/api/foundry/datasets/{ds['id']}/geo")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["lat_col"] == "lat"
    assert body["lon_col"] == "lon"
