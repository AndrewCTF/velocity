"""/api/timeline/density must not serve an unmeasured lane as a measured zero.

`gaps` used to be `[0] * bins`, returned unconditionally, and documented in the
route's own docstring as a placeholder. On the wire an absent measurement and a
measured zero were indistinguishable: a caller reading the array saw "no AIS
gaps in this window" with no way to learn that nothing had looked. The console
never rendered it, which is exactly why it survived — the API is not only read
by the console.

Same rule the feeds are held to by tests/test_feed_honesty.py: a thing may be
empty, it may not be empty and silent about why.
"""

from __future__ import annotations


def test_the_gaps_lane_reports_unmeasured_rather_than_zeros(client) -> None:
    r = client.get("/api/timeline/density?bins=24&window_sec=3600")
    assert r.status_code == 200
    body = r.json()

    assert body["gaps"] is None, (
        "gaps came back as a series. If per-MMSI gap tracking now exists, delete "
        "this test and assert the real measurement; do not restore a zero-fill."
    )
    assert body["gaps_status"] == "unmeasured"


def test_the_lanes_that_are_measured_are_still_full_length(client) -> None:
    """The honesty fix must not have thinned the two real series."""
    r = client.get("/api/timeline/density?bins=24&window_sec=3600")
    body = r.json()
    assert len(body["detections"]) == 24
    assert len(body["alerts"]) == 24
    assert body["bins"] == 24
    # And neither of the real lanes is nulled out by association.
    assert all(isinstance(n, int) for n in body["detections"])
    assert all(isinstance(n, int) for n in body["alerts"])
