"""PSKReporter parser + Maidenhead maths, against a body captured from the wire.

Fixture is a real retrieve.pskreporter.info response (2026-08-21), trimmed to
120 reports. The 2026-08-06 mega-ledger wave shipped parsers written against
imagined shapes and had to be corrected three days later — hence the rule this
file follows: capture first, parse second.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.routes.sigint import (
    band_of,
    maidenhead_to_lonlat,
    parse_reports,
)

_FIXTURE = Path(__file__).parent / "fixtures" / "pskreporter_sample.xml"


@pytest.fixture(scope="module")
def xml() -> str:
    return _FIXTURE.read_text(encoding="utf-8")


# ── Maidenhead ───────────────────────────────────────────────────────────────
#
# Checked against known squares rather than against the implementation: a grid
# decoder that is self-consistently wrong puts every emitter in the wrong ocean
# and nothing downstream would notice.


@pytest.mark.parametrize(
    ("grid", "lon", "lat", "place"),
    [
        ("JO62", 13.0, 52.5, "Berlin"),
        ("FN31", -73.0, 41.5, "New York / Connecticut line"),
        ("PM95", 139.0, 35.5, "Tokyo"),
        ("GF15", -57.0, -34.5, "Buenos Aires"),
        ("QF56", 151.0, -33.5, "Sydney"),
    ],
)
def test_four_char_locators_land_in_the_right_place(grid, lon, lat, place) -> None:
    got = maidenhead_to_lonlat(grid)
    assert got is not None, place
    assert got == pytest.approx((lon, lat), abs=0.01), place


def test_a_six_char_locator_is_finer_than_its_four_char_parent() -> None:
    coarse = maidenhead_to_lonlat("JO62")
    fine = maidenhead_to_lonlat("JO62QN")
    assert coarse is not None and fine is not None
    # Same square, so the fine point stays within half a square of the centre.
    assert abs(fine[0] - coarse[0]) <= 1.0
    assert abs(fine[1] - coarse[1]) <= 0.5


@pytest.mark.parametrize("bad", ["", "J", "JO", "1O62", "JOAB", "ZZ99ZZ99ZZ", "!!62"])
def test_a_malformed_locator_returns_none_rather_than_a_guess(bad) -> None:
    assert maidenhead_to_lonlat(bad) is None


def test_every_locator_in_the_fixture_lands_on_earth(xml: str) -> None:
    for f in parse_reports(xml, 5000):
        lon, lat = f["geometry"]["coordinates"]
        assert -180.0 <= lon <= 180.0
        assert -90.0 <= lat <= 90.0


# ── bands ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("hz", "band"),
    [(7_105_000, "40m"), (14_074_000, "20m"), (28_074_000, "10m"),
     (50_313_000, "6m"), (144_174_000, "2m"), (99_000_000, "unknown"), (None, "unknown")],
)
def test_band_edges(hz, band) -> None:
    assert band_of(hz) == band


# ── parser ───────────────────────────────────────────────────────────────────


def test_parses_the_captured_body(xml: str) -> None:
    feats = parse_reports(xml, 5000)
    assert len(feats) >= 20
    p = feats[0]["properties"]
    for field in ("kind", "callsign", "grid", "band", "mode", "precision_km"):
        assert field in p
    assert p["kind"] == "radio_report"


def test_ids_and_kind_follow_the_feed_contract(xml: str) -> None:
    """`<kind>:<rawid>` with properties.kind matching — what /api/entity resolves."""
    for f in parse_reports(xml, 5000):
        assert f["id"].startswith("radio_report:")
        assert f["properties"]["kind"] == "radio_report"


def test_one_emitter_appears_once(xml: str) -> None:
    """A station heard by thirty receivers is one station, not a starburst."""
    feats = parse_reports(xml, 5000)
    ids = [f["id"] for f in feats]
    assert len(ids) == len(set(ids))


def test_precision_is_published_so_a_grid_is_never_read_as_a_fix(xml: str) -> None:
    for f in parse_reports(xml, 5000):
        assert f["properties"]["precision_km"] in (4.6, 111.0)


def test_limit_is_honoured(xml: str) -> None:
    assert len(parse_reports(xml, 5)) == 5


def test_reports_without_a_locator_are_dropped_not_placed_at_null_island() -> None:
    xml = (
        '<?xml version="1.0"?><receptionReports>'
        '<receptionReport receiverCallsign="A" senderCallsign="B" senderLocator="" '
        'frequency="14074000" mode="FT8" sNR="-10"/>'
        '<receptionReport receiverCallsign="A" senderCallsign="C" senderLocator="JO62" '
        'frequency="14074000" mode="FT8" sNR="-10"/>'
        "</receptionReports>"
    )
    feats = parse_reports(xml, 50)
    assert [f["properties"]["callsign"] for f in feats] == ["C"]


def test_unparseable_xml_is_a_502_not_a_500() -> None:
    with pytest.raises(HTTPException) as err:
        parse_reports("not xml at all <<<", 10)
    assert err.value.status_code == 502
