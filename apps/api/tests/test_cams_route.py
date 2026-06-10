"""CCTV catalog + snapshot proxy tests with mocked upstreams."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

import app.routes.cams as cams
import app.upstream as upstream

_DIGITRAFFIC_FIXTURE = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "id": "C01502",
            "geometry": {"type": "Point", "coordinates": [24.95, 60.17]},
            "properties": {
                "id": "C01502",
                "name": "vt1_Helsinki",
                "presets": [{"id": "C0150201"}, {"id": "C0150202"}],
            },
        }
    ],
}

_CALTRANS_FIXTURE = {
    "data": [
        {
            "cctv": {
                "index": "1",
                "recordTimestamp": {"recordDate": "2026-06-10"},
                "location": {
                    "district": "4",
                    "locationName": "US-101 : North of Market",
                    "latitude": "37.775",
                    "longitude": "-122.419",
                },
                "imageData": {
                    "static": {
                        "currentImageURL": "https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv101.jpg"
                    }
                },
            }
        }
    ]
}


@pytest.fixture
def mock_upstream(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        urls.append(url)
        if "tie.digitraffic.fi" in url:
            return httpx.Response(200, content=json.dumps(_DIGITRAFFIC_FIXTURE).encode())
        if "cwwp2.dot.ca.gov" in url and url.endswith(".json"):
            return httpx.Response(200, content=json.dumps(_CALTRANS_FIXTURE).encode())
        if url.endswith(".jpg"):
            return httpx.Response(200, content=b"\xff\xd8jpegbytes")
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(upstream, "_CLIENT", client)
    upstream.cache.invalidate("cams:catalog")
    yield urls
    upstream.cache.invalidate("cams:catalog")
    monkeypatch.setattr(upstream, "_CLIENT", None)


def test_cams_geojson_merges_sources(
    client,
    mock_upstream: list[str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    yaml_file = tmp_path / "cams.yaml"
    yaml_file.write_text(
        "cams:\n"
        "  - id: test-harbor\n"
        "    name: Test Harbor\n"
        "    lat: 60.0\n"
        "    lon: 25.0\n"
        "    snapshot_url: https://example.org/harbor.jpg\n"
        "    attribution: Test City\n"
    )
    monkeypatch.setattr(cams, "_CAMS_YAML", yaml_file)
    r = client.get("/api/cams")
    assert r.status_code == 200
    fc = r.json()
    ids = {f["id"] for f in fc["features"]}
    assert any(i.startswith("cam:digitraffic:") for i in ids)
    assert any(i.startswith("cam:caltrans:") for i in ids)
    assert "cam:yaml:test-harbor" in ids
    for f in fc["features"]:
        assert f["properties"]["kind"] == "camera"
        assert f["properties"]["name"]


def test_snapshot_proxy_and_unknown_404(client, mock_upstream: list[str]) -> None:
    fc = client.get("/api/cams").json()
    cam_id = next(
        f["id"] for f in fc["features"] if f["id"].startswith("cam:digitraffic:")
    )
    short = cam_id.removeprefix("cam:")
    r = client.get(f"/api/cams/{short}/snapshot")
    assert r.status_code == 200
    assert r.content == b"\xff\xd8jpegbytes"
    assert r.headers["content-type"] == "image/jpeg"
    assert client.get("/api/cams/nope:missing/snapshot").status_code == 404
