"""Tests for the Panoramax+KartaView ground-imagery union route + proxy.

The two upstreams are stubbed: these tests prove OUR parsing/dedup/route/proxy
contract, not the live API shapes (which are best-effort and to-verify live).
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.intel import ground as gl
from app.routes import ground as gr

PHOTO_PANO = gl.GroundPhoto(
    id="abc1",
    source="panoramax",
    lat=48.86,
    lon=2.34,
    heading=90.0,
    captured_at="2024-05-01",
    thumb_url="https://pano/sd.jpg",
    photo_url="https://pano/hd.jpg",
)
PHOTO_KV = gl.GroundPhoto(
    id="seq_9",
    source="kartaview",
    lat=48.861,
    lon=2.341,
    heading=None,
    captured_at=None,
    thumb_url="https://kv/t.jpg",
    photo_url="https://kv/f.jpg",
)


class _FakeCache:
    async def get_or_fetch(self, key: str, ttl: float, loader):
        return await loader()


def _client(monkeypatch) -> TestClient:
    app = FastAPI()
    app.include_router(gr.router)
    monkeypatch.setattr(gr, "cache", _FakeCache())
    return TestClient(app)


def test_nearby_returns_featurecollection(monkeypatch):
    async def pano(lat, lon, r):
        return [PHOTO_PANO]

    async def kv(lat, lon, r):
        return [PHOTO_KV]

    monkeypatch.setattr(gl, "load_panoramax", pano)
    monkeypatch.setattr(gl, "load_kartaview", kv)
    c = _client(monkeypatch)
    r = c.get("/api/ground/nearby", params={"lat": 48.86, "lon": 2.34, "radius_km": 2})
    assert r.status_code == 200
    fc = r.json()
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 2
    # Closer photo (exact centre) sorts first.
    assert fc["features"][0]["properties"]["source"] == "panoramax"
    props = fc["features"][0]["properties"]
    assert props["kind"] == "ground_photo"
    assert props["photo_url"].endswith("?size=hd")
    assert props["thumb_url"].endswith("?size=thumb")


def test_nearby_dedup_nearby_points(monkeypatch):
    dup = gl.GroundPhoto(
        id="z",
        source="panoramax",
        lat=48.86001,  # same ~11 m grid cell as PHOTO_PANO
        lon=2.34001,
        heading=None,
        captured_at=None,
        thumb_url="t",
        photo_url="h",
    )

    async def pano(lat, lon, r):
        return [PHOTO_PANO, dup]

    async def kv(lat, lon, r):
        return []

    monkeypatch.setattr(gl, "load_panoramax", pano)
    monkeypatch.setattr(gl, "load_kartaview", kv)
    c = _client(monkeypatch)
    r = c.get("/api/ground/nearby", params={"lat": 48.86, "lon": 2.34})
    assert r.status_code == 200
    assert len(r.json()["features"]) == 1


def test_nearby_empty_sets_note(monkeypatch):
    async def pano(lat, lon, r):
        return []

    async def kv(lat, lon, r):
        return []

    monkeypatch.setattr(gl, "load_panoramax", pano)
    monkeypatch.setattr(gl, "load_kartaview", kv)
    c = _client(monkeypatch)
    r = c.get("/api/ground/nearby", params={"lat": 0.0, "lon": 0.0})
    assert r.status_code == 200
    fc = r.json()
    assert fc["features"] == []
    assert "no ground coverage" in fc["note"]


def test_nearby_requires_params(monkeypatch):
    c = _client(monkeypatch)
    # Missing lat/lon → FastAPI 422.
    assert c.get("/api/ground/nearby").status_code == 422


class _FakeResp:
    def __init__(self, body: bytes, ctype: str = "image/jpeg", status: int = 200):
        self.content = body
        self.headers = {"content-type": ctype}
        self.status_code = status


class _FakeClient:
    def __init__(self, resp: _FakeResp):
        self._resp = resp

    async def get(self, url, headers=None, **kw):
        return self._resp


def test_photo_proxy_passes_bytes(monkeypatch):
    # Populate the URL table the way nearby() does.
    gl._PHOTO_URLS[("panoramax", "abc1")] = {"thumb": "t", "hd": "https://pano/hd.jpg"}
    monkeypatch.setattr(gr, "cache", _FakeCache())
    monkeypatch.setattr(gr, "get_client", lambda: _FakeClient(_FakeResp(b"\xff\xd8jpeg")))
    app = FastAPI()
    app.include_router(gr.router)
    c = TestClient(app)
    r = c.get("/api/ground/photo/panoramax/abc1", params={"size": "hd"})
    assert r.status_code == 200
    assert r.content == b"\xff\xd8jpeg"
    assert r.headers["content-type"].startswith("image/")
    assert r.headers["cache-control"] == "public, max-age=60"


def test_photo_proxy_404_unknown(monkeypatch):
    monkeypatch.setattr(gr, "cache", _FakeCache())
    app = FastAPI()
    app.include_router(gr.router)
    c = TestClient(app)
    r = c.get("/api/ground/photo/panoramax/does-not-exist")
    assert r.status_code == 404


def test_bbox_and_proxy_url_helpers():
    min_lon, min_lat, max_lon, max_lat = gl._bbox(48.86, 2.34, 2.0)
    assert min_lon < 2.34 < max_lon
    assert min_lat < 48.86 < max_lat
    gl._PHOTO_URLS[("panoramax", "x")] = {"thumb": "t.jpg", "hd": "h.jpg"}
    assert gl.proxy_url("panoramax", "x", "hd") == "h.jpg"
    assert gl.proxy_url("panoramax", "x", "thumb") == "t.jpg"
    assert gl.proxy_url("panoramax", "missing", "hd") is None


def test_load_panoramax_parses_stubbed_json(monkeypatch):
    # Proves our defensive parse against a realistic Panoramax search payload.
    payload: Any = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "p1",
                "geometry": {"type": "Point", "coordinates": [2.34, 48.86]},
                "properties": {"camera:heading": 12, "datetime": "2024-01-01"},
                # Panoramax serves pixels from S3 via per-item STAC assets — the
                # parser reads these hrefs (there is no guessable URL template).
                "assets": {
                    "hd": {"href": "https://pano.example/main-pictures/p1.jpg"},
                    "sd": {"href": "https://pano.example/derivates/p1/sd.jpg"},
                    "thumb": {"href": "https://pano.example/derivates/p1/thumb.jpg"},
                },
            },
            {"type": "Feature", "id": "bad", "geometry": {"type": "LineString"}},  # skipped
            {  # Point but no assets → nothing to proxy → skipped
                "type": "Feature",
                "id": "noassets",
                "geometry": {"type": "Point", "coordinates": [2.35, 48.87]},
                "properties": {},
            },
        ],
    }

    class R:
        status_code = 200

        def json(self):
            return payload

    class C:
        async def get(self, url, headers=None, params=None):
            return R()

    monkeypatch.setattr(gl, "get_client", lambda: C())
    import asyncio

    out = asyncio.run(gl.load_panoramax(48.86, 2.34, 2.0))
    assert len(out) == 1  # 'bad' (LineString) + 'noassets' both skipped
    assert out[0].source == "panoramax"
    assert out[0].heading == 12
    assert out[0].photo_url == "https://pano.example/main-pictures/p1.jpg"
    assert out[0].thumb_url == "https://pano.example/derivates/p1/sd.jpg"
