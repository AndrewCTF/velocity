"""Unit tests for the keyless AIS firehose — no network.

Uses canonical AIVDM test vectors (decoded by pyais offline) to prove TAG-block
stripping, multipart reassembly, position emission, static-name enrichment, and
AIS "not available" sentinel cleanup.
"""

from __future__ import annotations

import json

from app import ais_firehose as F
from app.routes import ais as ais_routes

# Canonical gpsd/pyais vectors.
T1 = r"!AIVDM,1,1,,A,15M67FC000G?ufbE`FepT@3n00Sa,0*5D"  # type 1, mmsi 366053209
T5_P1 = "!AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0*1C"
T5_P2 = "!AIVDM,2,2,1,A,88888888880,2*25"  # together: EVER DIADEM, cargo (70)


def test_strip_tag_removes_kystverket_block() -> None:
    tagged = r"\s:2573238,c:1781359392*0E\!BSVDM,1,1,,A,B3mc,0*1F"
    assert F._strip_tag(tagged).startswith("!BSVDM")
    # Plain sentence is untouched.
    assert F._strip_tag(T1) == T1


def test_single_part_position_decodes() -> None:
    d = F._handle_sentence(T1, {})
    assert d is not None
    assert d["mmsi"] == 366053209
    assert round(d["lat"], 3) == 37.802
    assert round(d["lon"], 3) == -122.342


def test_multipart_reassembly() -> None:
    frag: dict = {}
    assert F._handle_sentence(T5_P1, frag) is None  # waits for part 2
    d = F._handle_sentence(T5_P2, frag)
    assert d is not None
    assert d["msg_type"] == 5
    assert d["shipname"].strip() == "EVER DIADEM"
    assert not frag  # group cleared after completion


def test_emit_position_frame_and_store(monkeypatch) -> None:
    added = []
    monkeypatch.setattr(ais_routes.store, "add", lambda obs: added.append(obs))
    frame = F._emit(F._handle_sentence(T1, {}))
    assert frame is not None
    out = json.loads(frame)
    assert out["id"] == "vessel:366053209"
    assert out["source"] == "kystverket"
    assert out["lat"] and out["lon"]
    assert out["kind"] == "vessel"
    assert len(added) == 1  # fed the fusion store


def test_static_name_and_type_enrich_later_position(monkeypatch) -> None:
    monkeypatch.setattr(ais_routes.store, "add", lambda obs: None)
    mmsi = 351759000
    # Static first → caches name + ship type.
    F._emit(F._handle_sentence(T5_P1, {}) or {})  # part 1 alone yields nothing
    frag: dict = {}
    F._handle_sentence(T5_P1, frag)
    F._emit(F._handle_sentence(T5_P2, frag))
    assert F._name_by_mmsi.get(mmsi) == "EVER DIADEM"
    assert ais_routes._ship_type_by_mmsi.get(mmsi) == 70  # plain int, not IntEnum


def test_sentinel_values_nulled() -> None:
    d = {"msg_type": 1, "mmsi": 12345, "lat": 10.0, "lon": 20.0,
         "speed": F._SOG_NA, "course": F._COG_NA, "heading": F._HEADING_NA}
    out = json.loads(F._emit(d))
    assert out["sog"] is None
    assert out["cog"] is None
    assert out["heading"] is None


def test_no_fix_returns_none() -> None:
    # Static-only message (no lat/lon) must not emit a frame.
    assert F._emit({"msg_type": 5, "mmsi": 999, "shipname": "X", "ship_type": 70}) is None


def test_stats_shape() -> None:
    s = F.stats()
    assert {"connected", "messages", "positions", "enabled", "host"} <= set(s)
