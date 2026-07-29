"""Guards: an answer is a verdict, its rule, and the age of its evidence.

This is the enforcement point for the whole "answer a question, do not render a
capability" idea (docs/research-last30days-2026-07-29.md §3). A site that
answered one question with one word took 484 points on HN; our own post
describing multi-source fusion on a Cesium globe took 2. The difference was not
capability, it was that one of them produced a decision.

The two structural rules, both tested here:

  1. every answer publishes the rule that produced it. The first question the
     technical audience asked of that 484-point site was "what's the threshold
     function?" - an unexplained verdict is treated as no verdict.
  2. every answer publishes how old its evidence is. That author led with a
     four-day data lag and was rewarded for it, while the biggest cluster of
     complaints on a 312-point launch was a map that failed silently.

Plus the one that keeps us honest: "unknown" must stay reachable. A tool for
people who check things has to be able to say it does not know yet.
"""

from __future__ import annotations

import json

import pytest

from app.intel import answers as A


def test_every_registered_answer_publishes_a_rule_and_a_lag() -> None:
    """The anti-clone contract for this phase, as an executable check. A new
    answer cannot be added without both fields."""
    items = pytest.importorskip("asyncio").run(A.all_answers())
    assert items, "no answers registered"
    for a in items:
        assert a["threshold"].strip(), f"{a['id']} has no published rule"
        assert len(a["threshold"]) > 40, f"{a['id']} rule is too short to be a real rule"
        # None is the "no evidence observed" sentinel and is only legitimate on
        # an unknown verdict; anything we actually concluded must say how old
        # the evidence was.
        if a["verdict"] == A.UNKNOWN:
            assert a["data_lag_s"] is None or isinstance(a["data_lag_s"], float)
            assert a["stale"] is True, f"{a['id']} claims freshness with no verdict"
        else:
            assert isinstance(a["data_lag_s"], float), f"{a['id']} has no numeric evidence age"
        assert a["verdict"] in {A.OPEN, A.REDUCED, A.CLOSED, A.UNKNOWN}
        assert a["question"].endswith("?"), f"{a['id']} is not phrased as a question"
        # Copy rule: operator-visible text carries no em dashes (CLAUDE.md).
        assert "—" not in a["threshold"]
        assert "—" not in a["detail"]


def test_the_dataclass_cannot_be_built_without_verdict_rule_and_lag() -> None:
    """Structural, not conventional: forgetting the rule is a TypeError, not a
    field that quietly defaults to empty."""
    with pytest.raises(TypeError):
        A.Answer(id="x", question="Is x open?")  # type: ignore[call-arg]


def test_unknown_carries_its_reason_and_does_not_claim_freshness() -> None:
    a = A._unknown("x", "Is x open?", "the rule", "Not enough history yet.")
    assert a.verdict == A.UNKNOWN
    assert "history" in a.detail
    # Nothing was observed, so there is no fresh evidence. Reporting a lag of 0
    # would read as "perfectly current", the opposite of the truth. None is the
    # sentinel because float("inf") does not survive JSON: it reaches the client
    # as null, and a consumer reading null as zero would invert the meaning.
    assert a.data_lag_s is None
    assert a.stale is True


def test_an_unknown_chokepoint_is_reported_not_guessed() -> None:
    import asyncio

    a = asyncio.run(A.chokepoint_answer("not-a-real-strait"))
    assert a.verdict == A.UNKNOWN
    assert "No chokepoint with that name" in a.detail


def test_known_chokepoints_are_slugged_stably() -> None:
    ids = A.chokepoint_ids()
    assert "strait-of-hormuz" in ids
    assert "panama-canal" in ids
    assert len(ids) == len(set(ids)), "slug collision would make an answer unaddressable"
    for i in ids:
        assert i == i.lower() and " " not in i


def test_staleness_is_reported_rather_than_silently_downgrading_the_verdict() -> None:
    """The caller must see BOTH what we concluded and that it is ageing; a
    verdict that quietly rewrites itself is how a stale map looks confident."""
    fresh = A.Answer(
        id="x",
        question="Is x open?",
        verdict=A.OPEN,
        threshold="r" * 50,
        as_of=0.0,
        data_lag_s=60.0,
        confidence="high",
        detail="d",
    )
    old = A.Answer(
        id="x",
        question="Is x open?",
        verdict=A.OPEN,
        threshold="r" * 50,
        as_of=0.0,
        data_lag_s=A.MAX_ANSWER_LAG_S + 1,
        confidence="high",
        detail="d",
    )
    assert fresh.stale is False
    assert old.stale is True
    assert old.verdict == A.OPEN  # unchanged; the flag is what moved
    assert old.to_dict()["stale"] is True


def test_thresholds_are_ordered_so_the_bands_cannot_invert() -> None:
    assert 0 < A.CLOSED_RATIO < A.REDUCED_RATIO < 1
    assert A.MIN_BASELINE_DAYS >= 1


def test_the_published_rule_states_the_actual_numbers() -> None:
    """The rule shown to the operator must contain the constants the code uses,
    so it cannot drift into a plausible paraphrase of different behaviour."""
    assert str(int(A.CLOSED_RATIO * 100)) in A.CHOKEPOINT_THRESHOLD
    assert str(int(A.REDUCED_RATIO * 100)) in A.CHOKEPOINT_THRESHOLD
    assert str(A.MIN_BASELINE_DAYS) in A.CHOKEPOINT_THRESHOLD


def test_no_evidence_survives_json_without_becoming_zero() -> None:
    """The wire contract. float("inf") serialises to null (or to invalid JSON),
    and a client treating null as 0 would read "we have nothing" as "perfectly
    current". `stale` carries the meaning so arithmetic on the lag is never the
    only thing standing between the operator and that inversion."""
    a = A._unknown("x", "Is x open?", "the rule", "Nothing recorded.")
    round_tripped = json.loads(json.dumps(a.to_dict()))
    assert round_tripped["data_lag_s"] is None
    assert round_tripped["stale"] is True
    assert round_tripped["verdict"] == A.UNKNOWN


# ── coverage answer ──────────────────────────────────────────────────────────
#
# The question nobody thinks to ask until it matters: is the picture complete
# enough to reason from? A thin snapshot looks exactly like a quiet sky. On
# 2026-07-29 the breadth tier was rate limited for a whole session and the
# console showed a quarter of the usual aircraft with nothing saying so.


def test_coverage_answer_is_first_so_it_frames_the_others() -> None:
    """It tells you how much to trust everything below it; burying it under ten
    chokepoints would invert that."""
    import asyncio

    items = asyncio.run(A.all_answers())
    assert items[0]["id"] == "aircraft-coverage"


def test_coverage_threshold_warns_against_reading_thin_as_quiet() -> None:
    assert "not a quiet sky" in A.COVERAGE_THRESHOLD
    assert "unknown rather than as evidence" in A.COVERAGE_THRESHOLD


def test_coverage_answer_reports_a_real_lag_and_a_verdict() -> None:
    import asyncio

    a = asyncio.run(A.coverage_answer())
    assert a.id == "aircraft-coverage"
    assert a.verdict in {A.OPEN, A.REDUCED, A.CLOSED, A.UNKNOWN}
    if a.verdict != A.UNKNOWN:
        # Measured against a live counter, so near-zero lag is honest here in a
        # way it would not be for an archive-backed answer.
        assert a.data_lag_s == 0.0
        assert a.stale is False
        assert a.observed is not None and a.baseline is not None
