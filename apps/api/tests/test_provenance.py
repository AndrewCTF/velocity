"""Guards: a contact carries WHO saw it, not just where it is.

The union keeps one winning fix per aircraft and used to discard the most useful
thing it knew - whether several independent tiers agree the contact exists, or
whether exactly one does.

That distinction is the community's own test for fabricated ADS-B. The highest
engagement story in this whole category (549 points, docs/research-last30days-
2026-07-29.md §4) is someone drawing a meme on a live tracking map by uploading
fake telemetry, and the top replies are practitioners explaining the tell:

    "ADSB sites aren't any sort of official thing. You can send whatever data
     you want to them. Just because it's there doesn't mean it ever went over
     the air."               - u/HNisCIS

    "it was not found if you looked on other platforms"   - u/pear01

So corroboration count is the signal, and these tests pin it.
"""

from __future__ import annotations

from app.routes.adsb import (
    _FRESH_POS_S,
    CONFIDENCE_RULE,
    _confidence,
    _merge_raw_into,
    _stamp_sources,
)


def _raw(hex_: str, lat: float = 40.0, lon: float = -75.0, **extra: object) -> dict:
    return {"hex": hex_, "lat": lat, "lon": lon, "flight": "TEST123", **extra}


# ── which tiers saw it ────────────────────────────────────────────────────────


def test_every_reporting_tier_is_recorded() -> None:
    by_id: dict = {}
    seen: dict = {}
    _merge_raw_into(by_id, [_raw("abc123")], seen, "feeds")
    _merge_raw_into(by_id, [_raw("abc123")], seen, "grid")
    _stamp_sources(by_id, seen)

    props = by_id["aircraft:abc123"]["properties"]
    assert props["sources"] == ["feeds", "grid"]
    assert props["source_count"] == 2


def test_a_tier_that_lost_the_freshness_race_still_counts_as_an_observer() -> None:
    """Corroboration asks how many observers saw the contact, not whose fix won.
    A tier one second behind still saw the aircraft."""
    by_id: dict = {}
    seen: dict = {}
    _merge_raw_into(by_id, [_raw("abc123", seen=1.0)], seen, "feeds")
    _merge_raw_into(by_id, [_raw("abc123", seen=900.0)], seen, "firehose")
    _stamp_sources(by_id, seen)

    assert by_id["aircraft:abc123"]["properties"]["source_count"] == 2


def test_a_filtered_record_is_not_an_observation() -> None:
    """Ground infrastructure is dropped by the filter chain before the id is
    formed; counting it would inflate corroboration with records we refuse to
    render."""
    by_id: dict = {}
    seen: dict = {}
    _merge_raw_into(by_id, [_raw("abc123")], seen, "feeds")
    _merge_raw_into(by_id, [_raw("abc123", category="C1")], seen, "grid")
    _stamp_sources(by_id, seen)

    assert by_id["aircraft:abc123"]["properties"]["sources"] == ["feeds"]


def test_sources_are_sorted_so_the_payload_does_not_churn() -> None:
    """Set iteration order is not stable; an unsorted list would rewrite the
    payload (and the ETag) every cycle for no change in meaning."""
    a: dict = {}
    seen_a: dict = {}
    _merge_raw_into(a, [_raw("abc123")], seen_a, "grid")
    _merge_raw_into(a, [_raw("abc123")], seen_a, "feeds")
    _stamp_sources(a, seen_a)

    b: dict = {}
    seen_b: dict = {}
    _merge_raw_into(b, [_raw("abc123")], seen_b, "feeds")
    _merge_raw_into(b, [_raw("abc123")], seen_b, "grid")
    _stamp_sources(b, seen_b)

    assert a["aircraft:abc123"]["properties"]["sources"] == (
        b["aircraft:abc123"]["properties"]["sources"]
    )


def test_tracking_is_optional_so_existing_callers_are_unaffected() -> None:
    by_id: dict = {}
    _merge_raw_into(by_id, [_raw("abc123")])
    assert "aircraft:abc123" in by_id
    assert "sources" not in by_id["aircraft:abc123"]["properties"]


# ── confidence ────────────────────────────────────────────────────────────────


def test_confidence_needs_both_corroboration_and_freshness() -> None:
    assert _confidence(2, 5.0) == "high"
    assert _confidence(3, 5.0) == "high"
    # Either one alone is medium: agreement about an old fix, or a fresh fix
    # nobody else confirms.
    assert _confidence(2, _FRESH_POS_S + 1) == "medium"
    assert _confidence(1, 5.0) == "medium"
    # Neither.
    assert _confidence(1, _FRESH_POS_S + 1) == "low"


def test_unknown_age_lowers_confidence_rather_than_raising_it() -> None:
    """Not knowing when a fix was taken is a reason for less trust, never more."""
    assert _confidence(1, None) == "low"
    assert _confidence(1, "recently") == "low"
    assert _confidence(2, None) == "medium"


def test_the_rule_is_published_alongside_the_verdict() -> None:
    """An unexplained verdict is treated as no verdict by this audience; the
    panel must be able to render the actual rule, not a paraphrase."""
    assert "two or more independent sources" in CONFIDENCE_RULE
    assert "2 minutes" in CONFIDENCE_RULE
    # Copy rule: no em dashes in operator-visible text (CLAUDE.md).
    assert "—" not in CONFIDENCE_RULE


def test_the_rule_string_is_identical_on_both_sides() -> None:
    """The rule is duplicated into the frontend so the panel can render it
    without a round trip. Duplicated strings drift, so pin them together: if this
    fails, the operator is being shown a rule the backend no longer applies."""
    from pathlib import Path

    ts = Path(__file__).resolve().parents[2] / "web/src/globe/adapters/freshness.ts"
    assert ts.exists(), f"expected the frontend mirror at {ts}"
    src = ts.read_text(encoding="utf-8")
    # The TS literal is split across concatenated lines for width; compare on the
    # sentences rather than the source formatting.
    for sentence in CONFIDENCE_RULE.split(". "):
        s = sentence.strip().rstrip(".")
        if s:
            assert s in src, f"frontend CONFIDENCE_RULE is missing: {s!r}"
