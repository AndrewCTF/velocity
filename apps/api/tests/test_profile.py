"""Deployment profiles — what a fresh install runs, and what it does not.

The shipping default is `lite`, because a default boot previously ran two
headless Chromium tiers (25 processes, 4.4 GB) and pulled a 21 GB model into
VRAM from a background loop, on a box whose own /api/ai/local said the model
feature was off. On 4 cores / 8 GB / no GPU that is not slow, it is dead.
"""

from __future__ import annotations

import pytest

from app import profile


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path):
    # Run from an EMPTY directory. apply() honours keys already present in a
    # `.env` (see profile._dotenv_keys), so without this every assertion here
    # would depend on whatever the developer happens to have in the repo-root
    # `.env` — green on one box, red on another. Tests that care about `.env`
    # write their own into this directory.
    monkeypatch.chdir(tmp_path)
    for key in (
        "OSINT_PROFILE",
        "ADSB_SIDECAR_ENABLED",
        "AIS_MYSHIPTRACKING_SIDECAR_ENABLED",
        "AIS_MARINETRAFFIC_SIDECAR_ENABLED",
        "AIS_VESSELFINDER_SIDECAR_ENABLED",
        "AI_BACKGROUND_ENABLED",
        "NEWS_ENABLED",
        "OLLAMA_KEEP_ALIVE",
    ):
        monkeypatch.delenv(key, raising=False)
    yield


def test_the_default_is_lite() -> None:
    """A fresh install must boot on a small box. If this flips back to `full`,
    the first run on a 4-core/8 GB machine stops working."""
    assert profile.DEFAULT == profile.LITE
    assert profile.resolve() == "lite"


def test_an_unknown_profile_falls_back_rather_than_crashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OSINT_PROFILE", "enormous")
    assert profile.resolve() == profile.DEFAULT


def test_profile_name_is_case_and_space_tolerant(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OSINT_PROFILE", "  FULL ")
    assert profile.resolve() == "full"


def test_lite_switches_off_the_browser_tier_and_automatic_inference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OSINT_PROFILE", "lite")
    profile.apply()
    import os

    assert os.environ["ADSB_SIDECAR_ENABLED"] == "0"
    assert os.environ["AIS_MYSHIPTRACKING_SIDECAR_ENABLED"] == "0"
    assert os.environ["AI_BACKGROUND_ENABLED"] == "0"
    # Release the card as soon as an explicitly requested call finishes.
    assert os.environ["OLLAMA_KEEP_ALIVE"] == "0"


def test_full_changes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """`full` is the previous behaviour verbatim — it must seed nothing at all,
    or an existing install would silently change when it upgrades."""
    monkeypatch.setenv("OSINT_PROFILE", "full")
    profile.apply()
    import os

    for key in ("ADSB_SIDECAR_ENABLED", "AI_BACKGROUND_ENABLED", "NEWS_ENABLED"):
        assert key not in os.environ, f"full seeded {key}"


def test_an_explicit_setting_always_beats_the_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A profile has an opinion about an UNCONFIGURED box and none at all about
    a configured one. Someone running `lite` who explicitly wants the ADS-B
    sidecar must keep it."""
    monkeypatch.setenv("OSINT_PROFILE", "lite")
    monkeypatch.setenv("ADSB_SIDECAR_ENABLED", "1")
    profile.apply()
    import os

    assert os.environ["ADSB_SIDECAR_ENABLED"] == "1"
    # and the untouched ones still get the profile's default
    assert os.environ["AI_BACKGROUND_ENABLED"] == "0"


def test_summary_reports_what_the_operator_overrode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OSINT_PROFILE", "lite")
    monkeypatch.setenv("ADSB_SIDECAR_ENABLED", "1")
    profile.apply()
    s = profile.summary()
    assert s["profile"] == "lite"
    assert s["default"] == "lite"
    assert "ADSB_SIDECAR_ENABLED" in s["overridden"]
    assert "AI_BACKGROUND_ENABLED" not in s["overridden"]


def test_workstation_keeps_the_adsb_tier_but_not_the_ais_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OSINT_PROFILE", "workstation")
    profile.apply()
    import os

    assert "ADSB_SIDECAR_ENABLED" not in os.environ, "workstation keeps ADS-B"
    assert os.environ["AIS_MYSHIPTRACKING_SIDECAR_ENABLED"] == "0"


def test_a_dotenv_setting_also_beats_the_profile(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """The sibling test above only ever set a REAL environment variable, which is
    why this shipped broken.

    pydantic-settings ranks real env vars ABOVE `.env`, so a profile default
    seeded into os.environ does not lose to an `.env` entry — it outranks it.
    Measured 2026-08-02 on a 32-core/121 GB/RTX 5090 box: `.env` carried
    ADSB_SIDECAR_ENABLED=1 and ADSB_SIDECAR_ONLY=1, and the backend still booted
    with :8090 never spawned and the snapshot on its <8000 backfill, because
    `lite` had already put a 0 in the environment. `.env` is a configured box.
    """
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text(
        "# operator config\nADSB_SIDECAR_ENABLED=1\nUNRELATED=x\n", encoding="utf-8"
    )
    monkeypatch.setenv("OSINT_PROFILE", "lite")
    profile.apply()
    import os

    assert "ADSB_SIDECAR_ENABLED" not in os.environ, (
        "the profile must not shadow a key the operator set in .env"
    )
    # Opinions about keys the operator did NOT configure still apply.
    assert os.environ["AI_BACKGROUND_ENABLED"] == "0"


def test_dotenv_parsing_ignores_comments_and_blanks(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text(
        "\n# NEWS_ENABLED=1 is commented out and must not count\n\nFOO=1\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("OSINT_PROFILE", "lite")
    profile.apply()
    import os

    assert os.environ["NEWS_ENABLED"] == "0", "a commented key is not configured"
