"""OFAC SDN parsing and the join onto live contacts.

The fixture rows are real SDN lines, trimmed. The shapes they cover are the ones
that broke a naive parser: an IMO carried only in free-text remarks, an MMSI
alongside it, an aircraft whose tail number IS the name field, a multi-program
cell, and the untyped `-0-` rows that are the largest group in the file.
"""

from __future__ import annotations

import pytest

from app.intel.sanctions import (
    match_aircraft,
    match_vessel,
    normalize_name,
    parse_sdn_csv,
)

SDN = (
    '4243,"EBANO","vessel","CUBA",-0- ,-0- ,"General Cargo","2595","1865","Panama",-0- ,'
    '"Vessel Registration Identification IMO 7406784; f.k.a. \'ANA I\'."\n'
    '11111,"ARTAVIL","vessel","IRAN",-0- ,"EQZC","Crude Oil Tanker",-0- ,-0- ,"Iran",'
    '"NITC","Vessel Registration Identification IMO 9187629; MMSI 572469210."\n'
    '15432,"EP-GOL","aircraft","SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,'
    '"Aircraft Model IL-76TD; Linked To: POUYA AIR."\n'
    '306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,'
    '"a.k.a. \'BNC\'."\n'
    '77777,"SOVCOMFLOT SHIP","vessel","[RUSSIA-EO14024] [UKRAINE-EO13662]",-0- ,-0- ,'
    '"Crude Oil Tanker",-0- ,-0- ,"Russia",-0- ,-0- \n'
)


@pytest.fixture()
def idx():
    return parse_sdn_csv(SDN)


def test_parses_every_row_and_types_them(idx) -> None:
    assert idx.rows == 5
    assert idx.counts() == {"vessel": 3, "aircraft": 1, "entity": 1}


def test_pulls_imo_and_mmsi_out_of_free_text_remarks(idx) -> None:
    # These identifiers are not columns. They are prose, and they are the only
    # reliable way to join the list onto AIS.
    assert set(idx.by_imo) == {7406784, 9187629}
    assert set(idx.by_mmsi) == {572469210}


def test_aircraft_tail_number_is_the_name_field(idx) -> None:
    m = match_aircraft(idx, registration="EP-GOL")
    assert m is not None
    assert m.matched_on == "registration"
    assert m.confidence == "exact"
    assert m.designation.name == "EP-GOL"


def test_splits_a_multi_program_cell(idx) -> None:
    m = match_vessel(idx, name="SOVCOMFLOT SHIP")
    assert m is not None
    assert m.designation.programs == ("RUSSIA-EO14024", "UKRAINE-EO13662")


def test_imo_beats_mmsi_beats_name(idx) -> None:
    # Strongest available identifier wins, and the answer says which one it was.
    assert match_vessel(idx, imo=9187629, name="NOT THE SAME SHIP").matched_on == "imo"
    assert match_vessel(idx, mmsi=572469210).matched_on == "mmsi"
    assert match_vessel(idx, call_sign="eqzc").matched_on == "call_sign"
    assert match_vessel(idx, name="ebano").matched_on == "name"


def test_a_name_match_is_never_reported_as_exact(idx) -> None:
    # A hull name is not an identifier. Treating a name hit as certain is how a
    # sanctions screen produces a false positive on an innocent ship.
    assert match_vessel(idx, name="EBANO").confidence == "probable"
    assert match_vessel(idx, imo=7406784).confidence == "exact"


def test_a_clean_contact_matches_nothing(idx) -> None:
    assert match_vessel(idx, imo=1234567, mmsi=123456789, name="KALA 6") is None
    assert match_aircraft(idx, registration="9V-MBI") is None


def test_name_folding_survives_ais_spelling(idx) -> None:
    assert normalize_name("  M/V  Ebano-1 ") == "MVEBANO1"
    assert match_vessel(idx, name="ebano") is not None
