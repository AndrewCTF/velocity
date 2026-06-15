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
from app import maritime_keyless as MK
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


# ── consolidated keyless maritime feed (app.maritime_keyless) ─────────────────


def test_merge_vessel_features_dedup_freshest_wins() -> None:
    # Same MMSI from two sources → the fix with the larger `t` wins.
    digi = [
        {
            "id": "vessel:1",
            "geometry": {"type": "Point", "coordinates": [5.0, 60.0]},
            "properties": {"mmsi": 1, "t": 100.0, "source": "digitraffic"},
        }
    ]
    kyst = [
        {
            "id": "vessel:1",
            "geometry": {"type": "Point", "coordinates": [6.0, 61.0]},
            "properties": {"mmsi": 1, "t": 200.0, "source": "kystdatahuset"},
        },
        {
            "id": "vessel:2",
            "geometry": {"type": "Point", "coordinates": [7.0, 62.0]},
            "properties": {"mmsi": 2, "t": None, "source": "kystdatahuset"},
        },
    ]
    merged = MK.merge_vessel_features(digi, kyst)
    assert [f["id"] for f in merged] == ["vessel:1", "vessel:2"]
    one = next(f for f in merged if f["id"] == "vessel:1")
    assert one["properties"]["t"] == 200.0  # fresher Kystdatahuset fix wins
    assert one["properties"]["source"] == "kystdatahuset"


def test_merge_vessel_features_known_t_beats_none() -> None:
    a = [{"id": "vessel:1", "properties": {"mmsi": 1, "t": None}}]
    b = [{"id": "vessel:1", "properties": {"mmsi": 1, "t": 50.0}}]
    # Whichever order, the feature with a known timestamp is preferred.
    assert MK.merge_vessel_features(a, b)[0]["properties"]["t"] == 50.0
    assert MK.merge_vessel_features(b, a)[0]["properties"]["t"] == 50.0


def test_merge_vessel_features_drops_mmsi_less() -> None:
    feats = [
        {"id": "x", "properties": {}},  # no mmsi, non-vessel id → dropped
        {"id": "vessel:7", "properties": {"mmsi": 7}},
    ]
    out = MK.merge_vessel_features(feats)
    assert [f["id"] for f in out] == ["vessel:7"]


def test_merge_resolves_mmsi_from_id_when_props_missing() -> None:
    # MMSI on the `vessel:<mmsi>` id alone is enough to dedup.
    a = [{"id": "vessel:42", "properties": {"t": 1.0}}]
    b = [{"id": "vessel:42", "properties": {"t": 2.0}}]
    out = MK.merge_vessel_features(a, b)
    assert len(out) == 1 and out[0]["properties"]["t"] == 2.0


def test_parse_kystdatahuset_normalizes_and_filters() -> None:
    fc = {
        "features": [
            {
                "geometry": {"type": "LineString", "coordinates": [[5.0, 60.0], [7.7, 57.9]]},
                "properties": {
                    "mmsi": 257,
                    "ship_name": "MS TEST",
                    "speed": 12.0,
                    "cog": 90.0,
                    "true_heading": 88,
                    "ship_type": 70,
                },
            },
            # null-island placeholder → dropped
            {"geometry": {"type": "Point", "coordinates": [0.0, 0.0]}, "properties": {"mmsi": 9}},
            # no mmsi → dropped
            {"geometry": {"type": "Point", "coordinates": [10.0, 59.0]}, "properties": {}},
            # unusable geometry → dropped
            {"geometry": {"type": "Polygon", "coordinates": []}, "properties": {"mmsi": 5}},
        ]
    }
    out = MK.parse_kystdatahuset(fc)
    assert len(out) == 1
    f = out[0]
    assert f["id"] == "vessel:257"
    # LAST coord of the LineString is the latest fix.
    assert f["geometry"]["coordinates"] == [7.7, 57.9]
    p = f["properties"]
    assert p["mmsi"] == 257 and p["name"] == "MS TEST"
    assert p["sog"] == 12.0 and p["cog"] == 90.0 and p["heading"] == 88
    assert p["shipType"] == 70 and p["source"] == "kystdatahuset"
    assert p["t"] is not None  # realtime feed stamped with ingest time


# ── NIT N4 (fair freshest-wins) + N5 (knots) ──────────────────────────────────


def test_parse_iso_utc_handles_naive_z_and_fractional() -> None:
    # Naive ISO is interpreted as UTC (what date_time_utc promises).
    assert MK._parse_iso_utc("2026-06-15T11:44:00") == 1781523840.0
    # Explicit Z and fractional seconds both parse to the same/adjacent epoch.
    assert MK._parse_iso_utc("2026-06-15T11:44:00Z") == 1781523840.0
    assert MK._parse_iso_utc("2026-06-15T11:44:00.500") == 1781523840.5
    # Garbage / empty / non-string → None (caller falls back to now()).
    assert MK._parse_iso_utc("not-a-date") is None
    assert MK._parse_iso_utc("") is None
    assert MK._parse_iso_utc(None) is None
    assert MK._parse_iso_utc(123) is None


def test_clean_sog_kn_masks_na_sentinel_keeps_real_knots() -> None:
    # 102.3 kn (raw 1023) is the AIS "speed not available" sentinel → None.
    assert MK._clean_sog_kn(102.3) is None
    assert MK._clean_sog_kn(150.0) is None
    # Real speeds (already knots) pass through unchanged.
    assert MK._clean_sog_kn(0.0) == 0.0
    assert MK._clean_sog_kn(11.8) == 11.8
    assert MK._clean_sog_kn(None) is None


def test_parse_kystdatahuset_uses_per_fix_timestamp() -> None:
    fc = {
        "features": [
            {
                "geometry": {"type": "Point", "coordinates": [5.3, 62.1]},
                "properties": {
                    "mmsi": 259236000,
                    "ship_name": "LYNGHOLM",
                    "speed": 0.0,
                    "date_time_utc": "2026-06-15T11:44:00",
                },
            },
            # No date_time_utc → falls back to ingest time (a fresh, large t).
            {
                "geometry": {"type": "Point", "coordinates": [6.0, 60.0]},
                "properties": {"mmsi": 111, "speed": 5.0},
            },
        ]
    }
    out = MK.parse_kystdatahuset(fc)
    by_id = {f["id"]: f for f in out}
    # The dated fix carries the parsed epoch, NOT now().
    assert by_id["vessel:259236000"]["properties"]["t"] == 1781523840.0
    # The undated fix falls back to now() — recent, much larger than the dated one.
    assert by_id["vessel:111"]["properties"]["t"] > 1781523840.0


def test_parse_kystdatahuset_masks_speed_sentinel() -> None:
    fc = {
        "features": [
            {
                "geometry": {"type": "Point", "coordinates": [5.0, 60.0]},
                "properties": {"mmsi": 222, "speed": 102.3},  # AIS NA sentinel
            }
        ]
    }
    out = MK.parse_kystdatahuset(fc)
    assert out[0]["properties"]["sog"] is None


def test_merge_kystdatahuset_no_longer_always_wins() -> None:
    # NIT N4 regression guard: a Digitraffic fix with a FRESHER real timestamp
    # must beat a Kystdatahuset fix whose t is its (older) date_time_utc, even
    # though Kystdatahuset's row appears later in the union order.
    digi = [
        {
            "id": "vessel:259236000",
            "geometry": {"type": "Point", "coordinates": [5.0, 62.0]},
            "properties": {"mmsi": 259236000, "t": 1781523900.0, "source": "digitraffic"},
        }
    ]
    kyst = MK.parse_kystdatahuset(
        {
            "features": [
                {
                    "geometry": {"type": "Point", "coordinates": [5.3, 62.1]},
                    "properties": {"mmsi": 259236000, "date_time_utc": "2026-06-15T11:44:00"},
                }
            ]
        }
    )
    assert kyst[0]["properties"]["t"] == 1781523840.0  # older than the digi fix
    merged = MK.merge_vessel_features(digi, kyst)
    assert len(merged) == 1
    # Freshest (Digitraffic) wins — Kystdatahuset no longer unfairly clobbers it.
    assert merged[0]["properties"]["source"] == "digitraffic"


@pytest.mark.asyncio
async def test_fetch_kystdatahuset_degrades_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Boom:
        async def get(self, *a, **k):  # noqa: ANN002, ANN003
            raise RuntimeError("network down")

    monkeypatch.setattr(MK, "get_client", lambda: _Boom())
    assert await MK.fetch_kystdatahuset() == []  # never raises, empty on failure


@pytest.mark.asyncio
async def test_fetch_kystdatahuset_rejects_non_json(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Resp:
        status_code = 200
        headers = {"content-type": "text/plain"}

        def json(self):  # noqa: ANN201
            raise AssertionError("must not parse a non-json body")

    class _Client:
        async def get(self, *a, **k):  # noqa: ANN002, ANN003
            return _Resp()

    monkeypatch.setattr(MK, "get_client", lambda: _Client())
    assert await MK.fetch_kystdatahuset() == []
