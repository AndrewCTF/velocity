"""OFAC SDN parsing and the join onto live contacts.

The fixture rows are real SDN lines, trimmed. The shapes they cover are the ones
that broke a naive parser: an IMO carried only in free-text remarks, an MMSI
alongside it, an aircraft whose tail number IS the name field, a multi-program
cell, and the untyped `-0-` rows that are the largest group in the file.
"""

from __future__ import annotations

import pytest

from app.intel.sanctions import (
    SanctionsIndex,
    match_aircraft,
    match_vessel,
    normalize_name,
    parse_sdn_csv,
    parse_uk_csv,
    parse_un_xml,
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


# ── UK OFSI ────────────────────────────────────────────────────────────────
# Two header rows, and the ship identifiers are labelled spans inside the free
# text rather than columns. Both are why this needs its own parser.
UK = (
    "Last Updated,03/06/2026\n"
    "Name 6,Name 1,Group Type,Other Information,Regime,Group ID\n"
    "SAM JONG 2,,Ship,"
    '"Listed as asset of Korea Samjong Shipping (IMO number):7408873 '
    '(Current owners):Korea Samjong Shipping (Flag of ship):North Korea '
    '(Type of ship):Oil tanker",'
    "Democratic People's Republic of Korea,13651\n"
    "SOME BANK,,Entity,A bank,Russia,99001\n"
)

UN = (
    '<?xml version="1.0" encoding="UTF-8"?><CONSOLIDATED_LIST>'
    "<INDIVIDUALS><INDIVIDUAL><DATAID>6908347</DATAID>"
    "<FIRST_NAME>Some</FIRST_NAME><SECOND_NAME>Person</SECOND_NAME>"
    "<UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE><COMMENTS1>A note.</COMMENTS1>"
    "</INDIVIDUAL></INDIVIDUALS>"
    "<ENTITIES><ENTITY><DATAID>6908348</DATAID><FIRST_NAME>SOME ORG</FIRST_NAME>"
    "<UN_LIST_TYPE>DPRK</UN_LIST_TYPE></ENTITY></ENTITIES>"
    "</CONSOLIDATED_LIST>"
)


def test_uk_pulls_the_imo_out_of_a_labelled_span() -> None:
    idx = parse_uk_csv(UK)
    assert idx.counts() == {"vessel": 1, "entity": 1}
    m = match_vessel(idx, imo=7408873)
    assert m is not None
    assert m.designation.name == "SAM JONG 2"
    assert m.designation.vessel_flag == "North Korea"
    assert m.designation.vessel_type == "Oil tanker"
    assert m.designation.list_name == "UK OFSI"


def test_un_parses_individuals_and_entities() -> None:
    idx = parse_un_xml(UN)
    assert idx.counts() == {"individual": 1, "entity": 1}
    assert idx.lists == ["UN Security Council"]


def test_a_hull_on_two_lists_reports_both() -> None:
    # The reason the index maps a key to a LIST of designations. Reporting only
    # the first list that loaded would answer a materially weaker question.
    merged = SanctionsIndex(fetched_at=0.0, rows=0)
    ofac = parse_sdn_csv(
        '4243,"SAM JONG 2","vessel","DPRK4",-0- ,-0- ,"Oil tanker",-0- ,-0- ,-0- ,-0- ,'
        '"Vessel Registration Identification IMO 7408873."\n'
    )
    merged.merge(ofac)
    merged.merge(parse_uk_csv(UK))
    m = match_vessel(merged, imo=7408873)
    assert m is not None
    assert m.lists == ("OFAC SDN", "UK OFSI")
    assert m.as_dict()["lists"] == ["OFAC SDN", "UK OFSI"]


def test_a_broken_list_yields_nothing_rather_than_raising() -> None:
    # A parse failure must not take the other lists down with it, and must not
    # look like a clean list either.
    assert parse_un_xml("<not xml").counts() == {}
    assert parse_uk_csv("no header here\n").counts() == {}
