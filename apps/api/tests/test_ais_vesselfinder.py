"""Guards for the VesselFinder tier of the AIS pipeline.

The wire layouts are ported from the site's own map script, so these tests pin
the port. The three properties that are bugs if they regress:

  1. AGE OF THE DATA. A row's ``t`` is ``now`` minus the UPPER bound of the age
     bucket the map shows; a row with no age is dropped, never stamped "now".
  2. A throttled answer (HTTP 200, 4 bytes) is counted, never read as empty sea.
  3. Satellite positions stay unidentified and undated: no MMSI, no ``t``.
"""

from __future__ import annotations

import struct
import time

import pytest

import app.ais_pipeline as pipeline
from app.ais_pipeline import vesselfinder as vf
from app.ais_pipeline.providers import Fix
from app.ais_pipeline.store import VesselStore

NOW = 1_800_000_000.0


def _header(flags: int = 0x47, total: int = 310_018) -> bytes:
    # 0x43, 2-byte payload length (12), 0x50, then flags / site total / selected MMSI.
    return b"\x43" + (12).to_bytes(2, "big") + b"\x50" + struct.pack(">iii", flags, total, 0)


def _row(
    mmsi: int, lat: float, lon: float, *, td: int, name: str = "", flags: int = 0, tail: bytes = b""
) -> bytes:
    raw = name.encode("latin-1")
    return (
        struct.pack(
            ">hiiibb", flags, mmsi, int(lat * vf.SCALE), int(lon * vf.SCALE), td, len(raw)
        )
        + raw
        + tail
    )


def _flags(*, cls: int = 0, icon: int = 63, sar: bool = False) -> int:
    return (icon << 8) | (cls << 4) | (2 if sar else 0)


def test_row_decodes_position_name_class_heading_and_age():
    buf = _header() + _row(
        563087130, 1.25, 103.9, td=4, name="STL T6", flags=_flags(cls=4, icon=8)
    )
    (f,) = vf.parse_mp2(buf, zoom=11, now=NOW)
    assert f.mmsi == 563087130 and f.source == "vesselfinder" and f.name == "STL T6"
    assert f.lat == pytest.approx(1.25) and f.lon == pytest.approx(103.9)
    assert f.ship_type == 70  # "Cargo ship"
    assert f.heading == 90.0  # icon step 8 of 32
    # "4 minutes ago" is anywhere in [4, 5) minutes: the upper bound is used.
    assert f.t == NOW - 300.0


def test_hours_are_carried_in_a_negative_age_byte():
    # The map script: a negative value is `td & 127` whole hours.
    td = -128 + 3
    (f,) = vf.parse_mp2(_header() + _row(563087130, 1.0, 103.0, td=td), zoom=11, now=NOW)
    assert f.t == NOW - 4 * 3600.0


def test_a_row_with_no_age_is_dropped_not_stamped_now():
    buf = _header() + _row(563087130, 1.0, 103.0, td=-1) + _row(563087131, 1.0, 103.0, td=0)
    got = vf.parse_mp2(buf, zoom=11, now=NOW)
    assert [f.mmsi for f in got] == [563087131]
    assert got[0].t == NOW - 60.0  # "just now" still is not later than a minute ago


def test_unclassed_and_ambiguous_types_are_not_guessed():
    buf = _header() + b"".join(
        _row(563087130 + i, 1.0, 103.0, td=1, flags=_flags(cls=c)) for i, c in enumerate((0, 1, 7))
    )
    assert [f.ship_type for f in vf.parse_mp2(buf, zoom=11, now=NOW)] == [None, None, None]


def test_hull_block_above_zoom_13_is_consumed_and_carries_heading():
    hull = struct.pack(">hhhhh", 100, 20, 10, 10, 123)
    buf = _header() + _row(563087130, 1.0, 103.0, td=1, tail=hull) + _row(
        563087131, 2.0, 104.0, td=1, flags=_flags(), tail=struct.pack(">hhhhh", 0, 0, 0, 0, 511)
    )
    a, b = vf.parse_mp2(buf, zoom=14, now=NOW)
    assert a.heading == 123.0
    # Misreading the block would shift every later row; the second one is intact.
    assert b.mmsi == 563087131 and b.lat == pytest.approx(2.0) and b.heading is None


def test_a_sar_aircraft_is_skipped_and_its_altitude_word_consumed():
    buf = _header() + _row(
        111232512, 1.0, 103.0, td=1, flags=_flags(sar=True), tail=struct.pack(">h", 1500)
    ) + _row(563087131, 2.0, 104.0, td=1, name="NEXT")
    (f,) = vf.parse_mp2(buf, zoom=11, now=NOW)
    assert f.mmsi == 563087131 and f.name == "NEXT"


def test_an_empty_tile_is_zero_rows_but_a_throttled_one_raises():
    assert vf.parse_mp2(_header(), zoom=11, now=NOW) == []
    with pytest.raises(vf.Throttled):
        vf.parse_mp2(b"\x43\x00\x00\x50", zoom=11, now=NOW)


def test_header_carries_the_site_total_only_when_flagged():
    assert vf.total_ships(_header(flags=0x47, total=310_018)) == 310_018
    assert vf.total_ships(_header(flags=0x07, total=310_018)) is None


def test_bbox_is_sent_in_ais_units_not_degrees_times_a_million():
    assert vf.bbox_param((103.0, 0.5, 105.0, 2.0)) == "61800000,300000,63000000,1200000"


def test_satellite_rows_stay_unidentified_and_undated():
    row = struct.pack(">iibbb", int(-8.73 * vf.SCALE), int(60.07 * vf.SCALE), -128 + 5, 28, 5)
    blank = struct.pack(">iibbb", int(34.6 * vf.SCALE), int(160.0 * vf.SCALE), 3, 63, 1)
    a, b = vf.parse_sfl(b"\x43\x45\x43\x56" + row + blank)
    assert a["old"] is True and a["heading"] == 315.0 and a["shipType"] == 30
    assert b["old"] is False and b["heading"] is None and b["shipType"] is None
    for r in (a, b):
        assert "mmsi" not in r and "t" not in r and "name" not in r


@pytest.fixture
def no_wait(monkeypatch):
    async def _no_wait(_s):
        return None

    monkeypatch.setattr(vf.asyncio, "sleep", _no_wait)


async def test_sweep_counts_a_throttled_tile_instead_of_reading_it_as_empty(monkeypatch, no_wait):
    boxes = [(0.0, 0.0, 4.0, 4.0), (4.0, 0.0, 8.0, 4.0), (8.0, 0.0, 12.0, 4.0)]

    async def fake(_client, _kind, box, _zoom):
        return b"\x43\x00\x00\x50" if box == boxes[1] else _header()

    monkeypatch.setattr(vf, "fetch_tile", fake)
    bodies, tel = await vf.sweep(None, "mp2", boxes, 11)
    assert len(bodies) == 2
    assert tel["tilesThrottled"] == 1 and tel["complete"] is False and tel["aborted"] is False


async def test_sweep_stops_knocking_once_the_site_refuses(monkeypatch, no_wait):
    """Measured 2026-10-04: a sustained sweep got every connection refused. A
    sweep that keeps going after that only extends the block."""
    calls: list = []

    async def refused(_client, _kind, box, _zoom):
        calls.append(box)
        raise ConnectionError("connect timeout")

    monkeypatch.setattr(vf, "fetch_tile", refused)
    boxes = [(float(i), 0.0, float(i) + 4.0, 4.0) for i in range(0, 80, 4)]
    bodies, tel = await vf.sweep(None, "mp2", boxes, 11)
    assert bodies == [] and tel["aborted"] is True
    assert len(calls) == 3  # three strikes, then the other seventeen are never asked
    assert tel["tilesSkipped"] == 17 and tel["complete"] is False


async def test_a_single_bad_tile_does_not_abort_the_sweep(monkeypatch, no_wait):
    boxes = [(float(i), 0.0, float(i) + 4.0, 4.0) for i in range(0, 24, 4)]

    async def flaky(_client, _kind, box, _zoom):
        if box in (boxes[1], boxes[3]):
            raise ConnectionError("blip")
        return _header()

    monkeypatch.setattr(vf, "fetch_tile", flaky)
    bodies, tel = await vf.sweep(None, "mp2", boxes, 11)
    # Strikes are CONSECUTIVE: a success in between resets them.
    assert len(bodies) == 4 and tel["aborted"] is False and tel["tilesFailed"] == 2


def test_the_detail_pass_is_opt_in():
    from app.config import Settings

    # Sustaining it is what got this address refused; the default tier is the
    # scout pass plus the satellite positions.
    assert Settings.model_fields["ais_vesselfinder_detail_tiles"].default == 0
    assert Settings.model_fields["ais_vesselfinder_interval_s"].default >= 1800.0


def test_detail_pass_asks_only_for_boxes_that_hold_a_known_vessel(monkeypatch):
    store = VesselStore()
    now = time.time()
    store.merge(
        [Fix(mmsi=563000000 + i, lat=1.3, lon=103.8, t=now, source="t") for i in range(3)]
        + [Fix(mmsi=227000001, lat=43.2, lon=5.3, t=now, source="t")]
    )
    monkeypatch.setattr(pipeline, "vessels", store)
    boxes = pipeline.vesselfinder_boxes(10)
    assert boxes[0] == (100.0, 0.0, 104.0, 4.0)  # busiest first
    assert (4.0, 40.0, 8.0, 44.0) in boxes and len(boxes) == 2
    assert pipeline.vesselfinder_boxes(1) == [(100.0, 0.0, 104.0, 4.0)]


def test_the_detail_box_stays_inside_what_the_endpoint_answers_in_full():
    """Measured 2026-10-04: zoom 11 answers 4x4 degrees in full and 5x5 with a
    nine-row sample and no error. Widening this is a silent data loss."""
    assert (pipeline._VF_DETAIL_ZOOM, pipeline._VF_DETAIL_DEG) == (11, 4.0)


def test_satellite_route_serves_positions_without_identity_or_age(client, monkeypatch):
    from app.config import get_settings

    s = get_settings()
    monkeypatch.setattr(s, "allow_unauthenticated", True, raising=False)
    monkeypatch.setattr(
        pipeline,
        "satellite",
        {
            "positions": [
                {"lat": -8.73, "lon": 60.07, "old": True, "heading": 315.0, "classIndex": 5, "shipType": 30},
                {"lat": 34.6, "lon": 160.0, "old": False, "heading": None, "classIndex": 4, "shipType": 70},
            ],
            "fetched_at": 1234.0,
            "complete": True,
        },
    )
    d = client.get("/api/maritime/satellite").json()
    assert d["count"] == 2 and d["complete"] is True
    p = d["features"][0]["properties"]
    assert p["kind"] == "vessel" and p["identified"] is False and p["typeClass"] == "Fishing vessel"
    assert "t" not in p and "mmsi" not in p
    assert "—" not in p["name"]
    boxed = client.get("/api/maritime/satellite?bbox=150,20,170,50").json()
    assert boxed["count"] == 1 and boxed["features"][0]["properties"]["shipType"] == 70
    assert client.get("/api/maritime/satellite?bbox=nope").status_code == 400


def test_dark_route_passes_the_detect_flag_through(client, monkeypatch):
    from app.config import get_settings
    from app.routes import ais_pipeline as routes

    monkeypatch.setattr(get_settings(), "allow_unauthenticated", True, raising=False)
    seen: dict = {}

    async def fake(bbox, *, days, limit, detect):
        seen.update(bbox=bbox, detect=detect)
        return {"sceneCount": 0, "detections": [], "candidates": []}

    monkeypatch.setattr(routes, "sar_scan", fake)
    assert client.get("/api/maritime/dark?bbox=56.3,26.5,56.8,26.8&detect=true").status_code == 200
    assert seen == {"bbox": (56.3, 26.5, 56.8, 26.8), "detect": True}
    client.get("/api/maritime/dark?bbox=56.3,26.5,56.8,26.8")
    assert seen["detect"] is False
