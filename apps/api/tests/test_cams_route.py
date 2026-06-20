"""CCTV catalog + snapshot proxy tests with mocked upstreams."""

from __future__ import annotations

import asyncio
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


def test_caltrans_districts_fetched_concurrently(
    mock_upstream: list[str],
) -> None:
    # Each district JSON is fetched on its own — both configured districts must
    # appear, and (post-refactor) they go out concurrently rather than serially.
    asyncio.run(cams._load_caltrans())
    fetched = [u for u in mock_upstream if "cwwp2.dot.ca.gov" in u and u.endswith(".json")]
    for n in cams._CALTRANS_DISTRICTS:
        assert any(f"/d{n}/" in u or f"D{n:02d}" in u for u in fetched), (
            f"district {n} not fetched: {fetched}"
        )


def test_catalog_sources_loaded_concurrently(monkeypatch: pytest.MonkeyPatch) -> None:
    # Instrument each loader so we can prove they overlap in time (concurrent
    # gather) instead of running back-to-back (the old ~18s serial fan-out).
    upstream.cache.invalidate("cams:catalog")
    events: list[tuple[str, str]] = []

    def instrument(name: str, delay: float):
        async def loader() -> list:
            events.append((name, "enter"))
            await asyncio.sleep(delay)
            events.append((name, "exit"))
            return []

        return loader

    monkeypatch.setattr(cams, "_load_digitraffic", instrument("digitraffic", 0.05))
    monkeypatch.setattr(cams, "_load_caltrans", instrument("caltrans", 0.05))
    monkeypatch.setattr(cams, "_load_yaml", lambda: [])

    catalog = asyncio.run(cams._get_catalog())
    upstream.cache.invalidate("cams:catalog")

    assert catalog == {}
    # Both async loaders must have entered before either exited — impossible if
    # they were awaited serially.
    first_exit = next(i for i, e in enumerate(events) if e[1] == "exit")
    entered_before_first_exit = {e[0] for e in events[:first_exit] if e[1] == "enter"}
    assert entered_before_first_exit == {"digitraffic", "caltrans"}


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
