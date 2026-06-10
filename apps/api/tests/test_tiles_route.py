"""Tile proxy routes — cache-wrapped, mocked upstreams."""

from __future__ import annotations

from collections.abc import Iterator
from io import BytesIO

import httpx
import pytest

import app.upstream as upstream


def _terrarium_png(elev_m: float) -> bytes:
    """Encode a flat 2x2 terrarium tile at the given elevation."""
    from PIL import Image

    v = elev_m + 32768.0
    r = int(v // 256)
    g = int(v % 256)
    b = int(round((v - int(v)) * 256)) % 256
    img = Image.new("RGB", (2, 2), (r, g, b))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def mock_upstream(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """Install an httpx MockTransport; yields the list of upstream URLs hit."""
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        host = request.url.host
        if "cartocdn" in host:
            return httpx.Response(200, content=b"\x89PNG-carto")
        if "eox.at" in host:
            return httpx.Response(200, content=b"\xff\xd8-eox")
        if "arcgisonline" in host:
            return httpx.Response(200, content=b"\xff\xd8-esri")
        if "s3.amazonaws.com" in host:
            return httpx.Response(200, content=_terrarium_png(1234.0))
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(upstream, "_CLIENT", client)
    yield urls
    monkeypatch.setattr(upstream, "_CLIENT", None)


def test_basemap_second_call_is_disk_hit(client, mock_upstream: list[str]) -> None:
    r1 = client.get("/tiles/basemap/7/41/53.png")
    assert r1.status_code == 200
    assert r1.content == b"\x89PNG-carto"
    n = len(mock_upstream)
    assert n >= 1
    r2 = client.get("/tiles/basemap/7/41/53.png")
    assert r2.status_code == 200
    assert len(mock_upstream) == n  # served from disk — no new upstream call


def test_sat_z_split_eox_low_esri_high(client, mock_upstream: list[str]) -> None:
    r_low = client.get("/tiles/sat/5/10/12.jpg")
    assert r_low.status_code == 200
    assert r_low.headers["x-sat-source"] == "eox"
    assert r_low.content == b"\xff\xd8-eox"
    r_high = client.get("/tiles/sat/15/100/200.jpg")
    assert r_high.status_code == 200
    assert r_high.headers["x-sat-source"] == "esri"
    assert r_high.content == b"\xff\xd8-esri"


def test_terrain_transcodes_terrarium_to_mapbox_rgb(
    client, mock_upstream: list[str]
) -> None:
    from PIL import Image

    assert client.get("/tiles/terrain/16/0/0.png").status_code == 400
    r = client.get("/tiles/terrain/10/163/357.png")
    assert r.status_code == 200
    assert any("elevation-tiles-prod" in u for u in mock_upstream)
    # Decode the response with the Mapbox terrain-RGB formula — must round-
    # trip the 1234 m elevation the terrarium fixture encoded.
    img = Image.open(BytesIO(r.content)).convert("RGB")
    pr, pg, pb = img.getpixel((0, 0))
    elev = (pr * 65536 + pg * 256 + pb) / 10.0 - 10000.0
    assert abs(elev - 1234.0) < 0.2
