"""A ban is per-deployment, not per-codebase.

api.airplanes.live answers 403 to this egress on every verb, with a body asking
the project to email contact@airplanes.live. Deleting it from the source list
would push one egress's outage onto every self-hosted deploy, including the ones
it has not banned - the same class of mistake as the audit this branch is
correcting. So the host stays wired and the operator switches it off.
"""

from __future__ import annotations

import pytest

from app.config import get_settings
from app.routes import adsb


@pytest.fixture(autouse=True)
def _clear():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_nothing_is_disabled_by_default(monkeypatch) -> None:
    monkeypatch.delenv("ADSB_DISABLED_HOSTS", raising=False)
    get_settings.cache_clear()
    assert adsb.head_hosts() == adsb._HEAD_HOSTS
    assert adsb.firehose_urls() == adsb._FIREHOSE_URLS


def test_a_disabled_host_leaves_both_tiers(monkeypatch) -> None:
    monkeypatch.setenv("ADSB_DISABLED_HOSTS", "api.airplanes.live")
    get_settings.cache_clear()
    assert "https://api.airplanes.live" not in adsb.head_hosts()
    assert not any("airplanes.live" in u for u in adsb.firehose_urls())
    # The survivors keep their order; this is a filter, not a re-rank.
    assert adsb.head_hosts() == [
        h for h in adsb._HEAD_HOSTS if "airplanes.live" not in h
    ]


def test_the_primary_index_keys_off_the_filtered_list(monkeypatch) -> None:
    """_primary_host_idx takes a modulo over the host count.

    If it kept using the unfiltered length while the walk used the filtered one,
    the deterministic primary would land on a different host than intended and
    cell-to-host affinity - the thing that gives the upstream cache locality -
    would quietly break.
    """
    monkeypatch.setenv("ADSB_DISABLED_HOSTS", "api.airplanes.live")
    get_settings.cache_clear()
    n = len(adsb.head_hosts())
    for lat, lon in ((50.0, 8.0), (-33.9, 151.2), (40.0, -74.0), (0.0, 0.0)):
        assert 0 <= adsb._primary_host_idx(lat, lon) < n


def test_disabling_everything_degrades_rather_than_deletes(monkeypatch) -> None:
    """A config typo must not empty the tier and blank the map."""
    monkeypatch.setenv(
        "ADSB_DISABLED_HOSTS",
        ",".join(h.split("//")[-1].split("/")[0] for h in adsb._HEAD_HOSTS),
    )
    get_settings.cache_clear()
    assert adsb.head_hosts() == adsb._HEAD_HOSTS


def test_the_setting_is_whitespace_and_case_tolerant(monkeypatch) -> None:
    monkeypatch.setenv("ADSB_DISABLED_HOSTS", "  API.Airplanes.Live , ")
    get_settings.cache_clear()
    assert "https://api.airplanes.live" not in adsb.head_hosts()
