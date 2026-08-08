"""Apple Maps tiles: the manifest read, the signature shape, and the licence gate.

The live path needs Apple, so the parsing and signing are pinned against a
hand-built manifest and the route is exercised with the fetch stubbed.
"""

from __future__ import annotations

import base64
import struct
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app import apple_maps
from app.config import Settings, get_settings
from app.main import create_app


def _len_field(num: int, payload: bytes) -> bytes:
    return _varint(num << 3 | 2) + _varint(len(payload)) + payload


def _varint(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return bytes(out)


def _style(style_id: int, host: str, version: int | None) -> bytes:
    body = _len_field(1, host.encode()) + _len_field(3, struct.pack("<Q", style_id))
    if version is not None:
        body += _len_field(5, _len_field(1, struct.pack("<Q", version)))
    return _len_field(2, body)


MANIFEST = (
    _style(15, "https://gspe11-ssl.ls.apple.com/tile", 7)  # C3M, not satellite
    + _style(7, "https://gspe11-ssl.ls.apple.com/tile", 10421)
    + _len_field(30, b"tok2")
)


def test_manifest_yields_the_satellite_style_and_its_version() -> None:
    host, version, token_p2 = apple_maps.parse_manifest(MANIFEST)
    assert host == "https://gspe11-ssl.ls.apple.com/tile"
    # Not 7: style 15's version must not be mistaken for style 7's. A wrong
    # version is a 410 on every tile.
    assert version == 10421
    assert token_p2 == "tok2"


def test_manifest_without_a_satellite_style_is_an_error() -> None:
    with pytest.raises(RuntimeError):
        apple_maps.parse_manifest(_style(15, "https://x/tile", 3) + _len_field(30, b"t"))


def test_signed_tile_url_carries_the_session_and_a_decodable_key() -> None:
    s = apple_maps.Session(
        host="https://gspe11-ssl.ls.apple.com/tile",
        version=10421,
        token_p2="tok2",
        sid="1234567890",
        minted_at=0.0,
    )
    url = s.tile_url(12, 3638, 1612)
    q = parse_qs(urlparse(url).query)
    assert q["style"] == ["7"] and q["v"] == ["10421"]
    assert q["x"] == ["3638"] and q["y"] == ["1612"] and q["z"] == ["12"]
    assert q["sid"] == ["1234567890"]
    expiry, nonce, ct = q["accessKey"][0].split("_", 2)
    assert int(expiry) > 0
    assert len(nonce) == 16
    # The ciphertext is base64 and a whole number of AES blocks.
    assert len(base64.b64decode(ct)) % 16 == 0
    # Two signings of the same tile differ: the nonce is per request.
    assert s.tile_url(12, 3638, 1612) != url


def test_route_serves_the_tile_and_refuses_commercial(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    async def fake_tile(z: int, x: int, y: int) -> bytes:
        return b"\xff\xd8\xff\xe0jpeg"

    monkeypatch.setattr(apple_maps, "fetch_tile", fake_tile)
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: Settings(
        cdse_client_id="", cdse_client_secret="", tile_cache_dir=str(tmp_path)
    )
    try:
        with TestClient(app) as c:
            r = c.get("/tiles/apple/12/3638/1612.jpg")
            assert r.status_code == 200
            assert r.headers["content-type"] == "image/jpeg"
            assert r.headers["X-Sat-Source"] == "apple"
            # Apple's ToS is not a redistribution licence, so an entitled
            # (paid) request — the one that must be served commercial-legal
            # sources — is refused rather than quietly served.
            r2 = c.get("/tiles/apple/12/3638/1612.jpg", headers={"X-Velocity-Tier": "paid"})
            assert r2.status_code == 451
            assert c.get("/tiles/apple/20/1/1.jpg").status_code == 400
    finally:
        app.dependency_overrides.clear()
