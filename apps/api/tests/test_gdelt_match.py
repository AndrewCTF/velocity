"""Guards for the shared word-boundary GDELT actor-name matcher.

Regression coverage for the demonym-substring bug (a St. Paul, Minnesota
crime story naming an "Ethiopian" suspect got mis-attributed to Ethiopia's
country brief because "ethiopia" is a substring of "ethiopian").
"""

from __future__ import annotations

from app.intel.gdelt_match import actor_matches_country, norm


def test_demonym_does_not_match_country_name():
    # "ethiopia" is a substring of "ethiopian" -- the bug this module fixes.
    assert actor_matches_country("An Ethiopian-American man", "Ethiopia") is False
    assert actor_matches_country("Ethiopian Airlines", "Ethiopia") is False


def test_country_name_as_whole_word_matches():
    assert actor_matches_country("Ethiopia Government", "Ethiopia") is True
    assert actor_matches_country("forces loyal to Ethiopia", "Ethiopia") is True


def test_multi_word_country_name_matches_as_a_phrase():
    assert actor_matches_country("the United Kingdom Government", "United Kingdom") is True
    # but not when only part of the phrase appears
    assert actor_matches_country("the Kingdom of Bahrain", "United Kingdom") is False


def test_case_and_whitespace_insensitive():
    assert actor_matches_country("  NIGERIA POLICE  ", "nigeria") is True


def test_empty_or_missing_input_never_matches():
    assert actor_matches_country(None, "Ethiopia") is False
    assert actor_matches_country("Ethiopia Government", None) is False
    assert actor_matches_country("", "") is False
    assert actor_matches_country("   ", "Ethiopia") is False


def test_norm_casefolds_and_strips():
    assert norm("  Ethiopia  ") == "ethiopia"
    assert norm(None) == ""
