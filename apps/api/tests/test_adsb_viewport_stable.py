"""viewport_filter decimation must be STABLE across polls.

Regression guard for the "aircraft frozen at world view" bug: the global
snapshot's feature order and exact count shift on every 1-2s refresh (multi-
source union + carry-forward merge). The old decimation used a positional
stride ``feats[int(i*stride)]``, so it resampled a DIFFERENT subset every poll.
The frontend upserts entities by id, so ~half the icons were destroyed and
re-created each second — which reset the in-place motion model and left
aircraft sitting frozen. Decimation keyed by feature id keeps the SAME aircraft
visible poll-to-poll.
"""

from __future__ import annotations

import random

from app.routes.adsb import viewport_filter


def _fc(ids: list[str], source: str = "adsb") -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": i,
                "geometry": {"type": "Point", "coordinates": [0.0, 0.0]},
                "properties": {"icao24": i, "source": source},
            }
            for i in ids
        ],
    }


def _kept_ids(fc: dict) -> set[str]:
    return {f["id"] for f in fc["features"]}


def test_decimation_is_stable_across_reordered_snapshots() -> None:
    ids = [f"aircraft:{n:06x}" for n in range(9000)]
    limit = 4000

    a = _fc(ids)
    shuffled = list(ids)
    random.Random(1).shuffle(shuffled)
    b = _fc(shuffled)

    keep_a = _kept_ids(viewport_filter(a, None, None, None, None, limit))
    keep_b = _kept_ids(viewport_filter(b, None, None, None, None, limit))

    assert len(keep_a) == limit
    assert keep_a == keep_b, (
        "reordering the same aircraft changed which subset survives — "
        f"{len(keep_a ^ keep_b)} ids churned"
    )


def test_decimation_churns_only_with_real_population_change() -> None:
    ids = [f"aircraft:{n:06x}" for n in range(9000)]
    limit = 4000
    keep0 = _kept_ids(viewport_filter(_fc(ids), None, None, None, None, limit))

    # Real feed delta: 30 aircraft leave, 30 new ones appear.
    ids2 = ids[30:] + [f"aircraft:{n:06x}" for n in range(9000, 9030)]
    keep1 = _kept_ids(viewport_filter(_fc(ids2), None, None, None, None, limit))

    churn = len(keep0 ^ keep1)
    # Old stride churned ~half (>4000). Stable decimation churns only near the
    # hash boundary + real entry/exit — comfortably under 5% of the cap.
    assert churn < limit * 0.05, f"excessive churn for a 30-aircraft delta: {churn}"


def test_decimation_prefers_live_tier_over_cached_opensky() -> None:
    # ~9k aircraft: 5000 live keyless-feed, 4000 cached OpenSky. With a 4000 cap
    # the world view should fill with movers, not stale OpenSky icons.
    live = _fc([f"aircraft:{n:06x}" for n in range(5000)], source="adsb")
    cached = _fc([f"aircraft:{n:06x}" for n in range(5000, 9000)], source="opensky")
    both = {"type": "FeatureCollection", "features": live["features"] + cached["features"]}

    kept = viewport_filter(both, None, None, None, None, 4000)["features"]
    sources = [f["properties"]["source"] for f in kept]
    assert len(kept) == 4000
    assert all(s == "adsb" for s in sources), "stale OpenSky leaked into a live-only cap"


def test_decimation_degrades_to_pure_hash_when_no_live_feeds() -> None:
    # Datacenter egress: every aircraft is OpenSky. All tiers tie, so it must
    # still be a stable hash subset (no crash, no churn) — same set across order.
    ids = [f"aircraft:{n:06x}" for n in range(9000)]
    a = _kept_ids(viewport_filter(_fc(ids, source="opensky"), None, None, None, None, 4000))
    shuffled = list(ids)
    random.Random(7).shuffle(shuffled)
    b = _kept_ids(viewport_filter(_fc(shuffled, source="opensky"), None, None, None, None, 4000))
    assert len(a) == 4000
    assert a == b
