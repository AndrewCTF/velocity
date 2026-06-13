"""Unit tests for the extra keyless AIS sources — no network.

Covers the hand-rolled MQTT codec (length encoding, packet framing, PUBLISH
decode), the Kystdatahuset GeoJSON parse, and the shared publish_vessel path
(sentinel cleanup + coordinate validation).
"""

from __future__ import annotations

import json

import pytest

from app import ais_firehose
from app import ais_keyless as K
from app.routes import ais as ais_routes


def test_remaining_length_encoding() -> None:
    assert K._enc_remaining_length(0) == b"\x00"
    assert K._enc_remaining_length(127) == b"\x7f"
    assert K._enc_remaining_length(128) == b"\x80\x01"
    assert K._enc_remaining_length(16383) == b"\xff\x7f"


def test_connect_and_subscribe_packets() -> None:
    cp = K._connect_packet("cid")
    assert cp[0] == 0x10 and b"MQTT" in cp
    sp = K._subscribe_packet("vessels-v2/+/location")
    assert sp[0] == 0x82 and b"vessels-v2/+/location" in sp


def _publish_packet(topic: str, payload: bytes) -> bytes:
    body = len(topic).to_bytes(2, "big") + topic.encode() + payload
    return b"\x30" + K._enc_remaining_length(len(body)) + body


def test_parse_packets_handles_multiple_and_partial() -> None:
    connack = b"\x20\x02\x00\x00"  # CONNACK rc=0
    pub = _publish_packet("vessels-v2/1/location", b'{"lat":1,"lon":2}')
    pkts, rem = K._parse_packets(connack + pub)
    assert rem == b""
    assert [p[0] for p in pkts] == [2, 3]  # CONNACK, PUBLISH
    # A truncated trailing packet is held back as remainder.
    pkts2, rem2 = K._parse_packets(connack + pub[:5])
    assert [p[0] for p in pkts2] == [2]
    assert rem2 == pub[:5]


def test_decode_publish() -> None:
    pub = _publish_packet("vessels-v2/230661000/location", b'{"lat":60.4,"lon":22.0}')
    pkts, _ = K._parse_packets(pub)
    ptype, b0, body = pkts[0]
    topic, payload = K._decode_publish(b0, body)
    assert topic == "vessels-v2/230661000/location"
    assert json.loads(payload) == {"lat": 60.4, "lon": 22.0}


@pytest.mark.asyncio
async def test_handle_publish_calls_publish_vessel(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = []

    async def fake_pub(mmsi, lat, lon, **kw):  # noqa: ANN001
        seen.append((mmsi, lat, lon, kw))
        return True

    monkeypatch.setattr(ais_firehose, "publish_vessel", fake_pub)
    await K._handle_publish(
        "vessels-v2/230661000/location",
        b'{"lat":60.45,"lon":22.03,"sog":0.0,"cog":104.3,"heading":275}',
    )
    assert len(seen) == 1
    mmsi, lat, lon, kw = seen[0]
    assert mmsi == "230661000" and lat == 60.45 and lon == 22.03
    assert kw["cog"] == 104.3 and kw["source"] == "digitraffic"


@pytest.mark.asyncio
async def test_handle_publish_skips_no_fix(monkeypatch: pytest.MonkeyPatch) -> None:
    called = []
    monkeypatch.setattr(ais_firehose, "publish_vessel", lambda *a, **k: called.append(1))
    await K._handle_publish("vessels-v2/1/location", b'{"sog":0}')  # no lat/lon
    assert not called


def test_latest_fix() -> None:
    assert K._latest_fix({"type": "Point", "coordinates": [7.7, 57.9]}) == (7.7, 57.9)
    assert K._latest_fix(
        {"type": "LineString", "coordinates": [[1.0, 2.0], [3.0, 4.0]]}
    ) == (3.0, 4.0)
    assert K._latest_fix({"type": "Polygon", "coordinates": []}) is None


@pytest.mark.asyncio
async def test_publish_kystdatahuset_features(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = []

    async def fake_pub(mmsi, lat, lon, **kw):  # noqa: ANN001
        seen.append((mmsi, lat, lon, kw.get("source"), kw.get("name")))
        return True

    monkeypatch.setattr(ais_firehose, "publish_vessel", fake_pub)
    feats = [
        {
            "geometry": {"type": "LineString", "coordinates": [[5.0, 60.0], [7.77, 57.97]]},
            "properties": {"mmsi": 257, "ship_name": "MS TEST", "speed": 12.0, "cog": 90.0},
        },
        {"geometry": {"type": "Point", "coordinates": [10.0, 59.0]}, "properties": {"mmsi": 258}},
        {"geometry": {}, "properties": {"mmsi": 259}},  # no usable geometry → skipped
        {"geometry": {"type": "Point", "coordinates": [1.0, 1.0]}, "properties": {}},  # no mmsi
    ]
    n = await K._publish_kystdatahuset_features(feats)
    assert n == 2
    # LAST coord [7.77, 57.97] is the latest fix → publish_vessel(mmsi, lat, lon)
    assert seen[0] == (257, 57.97, 7.77, "kystdatahuset", "MS TEST")
    assert seen[1][0] == 258


@pytest.mark.asyncio
async def test_publish_vessel_sentinels_and_validation(monkeypatch: pytest.MonkeyPatch) -> None:
    frames = []

    async def fake_broadcast(p):  # noqa: ANN001
        frames.append(json.loads(p))

    monkeypatch.setattr(ais_routes, "_broadcast", fake_broadcast)
    monkeypatch.setattr(ais_routes.store, "add", lambda o: None)

    ok = await ais_firehose.publish_vessel(
        123, 60.0, 22.0, sog=102.3, cog=360.0, heading=511, source="digitraffic"
    )
    assert ok is True
    f = frames[-1]
    assert f["id"] == "vessel:123" and f["source"] == "digitraffic"
    assert f["sog"] is None and f["cog"] is None and f["heading"] is None

    # Out-of-range coordinates are rejected (no frame).
    before = len(frames)
    assert await ais_firehose.publish_vessel(9, 91.0, 0.0) is False
    assert len(frames) == before
