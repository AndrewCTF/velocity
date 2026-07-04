"""Classification ladder + marking + can_read predicate (Gotham-substrate ACL)."""

from __future__ import annotations

from app.intel import classification as clf


def test_marking_strings() -> None:
    assert clf.marking(clf.SECRET, ["NOFORN"]) == "SECRET//NOFORN"
    assert clf.marking(0) == "UNCLASSIFIED"
    assert clf.marking(clf.TOP_SECRET, ["fvey", "rel"]) == "TOP SECRET//FVEY/REL"
    assert clf.marking(99) == "TOP SECRET"  # clamped


def test_parse_level() -> None:
    assert clf.parse_level("secret") == clf.SECRET
    assert clf.parse_level("TS") == clf.TOP_SECRET
    assert clf.parse_level(2) == clf.CONFIDENTIAL
    assert clf.parse_level(99) == clf.TOP_SECRET
    assert clf.parse_level(-5) == clf.UNCLASSIFIED
    assert clf.parse_level("junk") == clf.UNCLASSIFIED
    assert clf.parse_level(True) == clf.UNCLASSIFIED  # bool rejected


def test_can_read() -> None:
    assert clf.can_read(2, [], 3, []) is False  # clearance too low
    assert clf.can_read(3, [], 3, []) is True
    assert clf.can_read(4, [], 3, ["NOFORN"]) is False  # missing compartment
    assert clf.can_read(4, ["NOFORN"], 3, ["noforn"]) is True  # case-insensitive
    assert clf.can_read(4, ["FVEY", "NOFORN"], 3, ["fvey"]) is True  # superset ok


def test_holds_compartments() -> None:
    assert clf.holds(["FVEY", "NOFORN"], ["fvey"]) is True  # subset, case-insensitive
    assert clf.holds([], ["FVEY"]) is False  # user holds none
    assert clf.holds(["FVEY"], []) is True  # nothing requested
    assert clf.holds(["FVEY"], ["FVEY", "NOFORN"]) is False  # missing NOFORN


def test_redact_for() -> None:
    rows = [{"classification": 3, "x": 1}, {"classification": 1, "x": 2}]
    kept = clf.redact_for(2, [], rows)
    assert kept == [{"classification": 1, "x": 2}]
