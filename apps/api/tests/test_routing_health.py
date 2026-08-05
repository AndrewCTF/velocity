"""National routing health: the baseline, and what it refuses to say."""

from __future__ import annotations

from app.routes.routing import WATCHLIST, _assess


def series(*vals: float) -> list[tuple[str, float, float]]:
    return [(f"2026-08-{i + 1:02d}", v, 100.0) for i, v in enumerate(vals)]


def test_a_flat_country_reports_no_drop() -> None:
    a = _assess(series(1000, 1002, 998, 1001, 999, 1000, 1000))
    assert a["severity"] == "none"
    assert a["drop_pct"] == 0.0
    assert a["baseline_v4"] == 1000


def test_a_national_shutdown_reads_as_major() -> None:
    # Prefixes collapse on the last day. This is the shape a state-ordered
    # shutdown makes in the RIS table.
    a = _assess(series(8400, 8410, 8395, 8402, 8398, 8405, 900))
    assert a["severity"] == "major"
    assert a["drop_pct"] > 85


def test_a_partial_outage_is_not_a_shutdown() -> None:
    a = _assess(series(1000, 1000, 1000, 1000, 1000, 1000, 850))
    assert a["severity"] == "partial"
    assert 14 < a["drop_pct"] < 16


def test_collector_churn_is_not_a_finding() -> None:
    # RIS counts wobble a percent or two on their own. A threshold that fired on
    # that would cry wolf every day and be ignored within a week.
    a = _assess(series(1000, 1000, 1000, 1000, 1000, 1000, 970))
    assert a["severity"] == "none"


def test_a_country_growing_is_never_reported_as_a_drop() -> None:
    a = _assess(series(500, 520, 540, 560, 580, 600, 700))
    assert a["drop_pct"] == 0.0


def test_too_little_history_yields_no_percentage_rather_than_a_made_up_one() -> None:
    a = _assess(series(1000, 200))
    assert a["baseline_v4"] is None
    assert a["drop_pct"] is None
    assert a["severity"] == "unknown"
    # The reading itself still comes through; only the comparison is withheld.
    assert a["prefixes_v4"] == 200


def test_the_watchlist_is_well_formed() -> None:
    seen = set()
    for iso2, name, lat, lon in WATCHLIST:
        assert len(iso2) == 2 and iso2.isupper(), iso2
        assert iso2 not in seen, f"{iso2} listed twice"
        seen.add(iso2)
        assert name
        assert -90 <= lat <= 90 and -180 <= lon <= 180, name
