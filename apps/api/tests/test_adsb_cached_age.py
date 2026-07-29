"""Guard: a cached tier must publish the age of the DATA, not the age of the pull.

OpenSky is pulled once per UTC day and served from memory on every tick. It used
to stamp `seen_pos_s` (a DURATION) once, at pull time, so the number froze while
the clock kept moving: an aircraft whose fix was 5 s old at 0000 UTC still
claimed "5 s old" at 2300 UTC and rode the union all day as a live-looking icon
parked on this morning's position. That is the operator's "OpenSky has so many
dead planes", and routes/adsb.py carried it as an accepted ceiling.

The fix stamps an ABSOLUTE `pos_epoch` at pull time and re-derives the duration
at the serve boundary. This module pins the three properties that makes correct:

  1. the reported age GROWS with wall-clock time for a cached fix;
  2. the freshest-observation-wins union is unchanged, because
     `seen_at - seen_pos_s` still evaluates to the real observation instant;
  3. an aged cached contact is MARKED, not dropped, so the >=8000 breadth
     guardrail survives (dropping at the live cap would blank the tier fifteen
     minutes into every UTC day).

See CLAUDE.md ("A tier that can serve a CACHE must publish the age of the DATA")
and docs/decisions.md (2026-07-15 AIS post-mortem, where the same rule was first
applied to the :8093 sidecar via last_good/age_s).
"""

from __future__ import annotations

from app.routes.adsb import (
    _CACHED_POS_CAP_S,
    _FRESH_POS_S,
    _STALE_POS_CAP_S,
    _age_cached_positions,
    _pos_stale,
)

_T0 = 1_800_000_000.0  # fixed epoch; these tests never read the real clock


def _cached_feat(fid: str, pos_epoch: float, pull_at: float) -> dict:
    """A feature as the OpenSky pull stamps it, then caches."""
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Point", "coordinates": [-75.0, 40.0]},
        "properties": {
            "source": "opensky",
            "pos_epoch": pos_epoch,
            "seen_at": pull_at,
            "seen_pos_s": max(0.0, pull_at - pos_epoch),
        },
    }


def _live_feat(fid: str, seen_pos_s: float) -> dict:
    """A live-tier feature: a duration, no absolute instant."""
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Point", "coordinates": [-75.0, 40.0]},
        "properties": {"source": "feeds", "seen_at": _T0, "seen_pos_s": seen_pos_s},
    }


def _fc(*feats: dict) -> dict:
    return {"type": "FeatureCollection", "features": list(feats)}


def test_cached_age_grows_with_the_clock() -> None:
    """The whole bug in one assertion: five seconds old at pull, six hours old
    six hours later."""
    fc = _fc(_cached_feat("a", pos_epoch=_T0 - 5.0, pull_at=_T0))
    props = fc["features"][0]["properties"]

    assert props["seen_pos_s"] == 5.0  # as stamped at pull

    _age_cached_positions(fc, now=_T0 + 6 * 3600)
    assert props["seen_pos_s"] == 5.0 + 6 * 3600


def test_reage_is_idempotent() -> None:
    """Serving twice at the same instant must not double-age. The serve boundary
    mutates shared cached dicts, so this has to be a pure function of pos_epoch."""
    fc = _fc(_cached_feat("a", pos_epoch=_T0 - 5.0, pull_at=_T0))
    _age_cached_positions(fc, now=_T0 + 900)
    once = fc["features"][0]["properties"]["seen_pos_s"]
    _age_cached_positions(fc, now=_T0 + 900)
    assert fc["features"][0]["properties"]["seen_pos_s"] == once


def test_observation_instant_is_preserved() -> None:
    """`seen_at - seen_pos_s` is what the freshest-observation-wins union keys on
    (tests/test_adsb_no_reverse.py). Re-aging moves both fields together, so the
    derived instant is invariant and no tier's ordering changes."""
    fix_at = _T0 - 5.0
    fc = _fc(_cached_feat("a", pos_epoch=fix_at, pull_at=_T0))
    for elapsed in (0.0, 60.0, 3600.0, 20 * 3600.0):
        _age_cached_positions(fc, now=_T0 + elapsed)
        p = fc["features"][0]["properties"]
        assert p["seen_at"] - p["seen_pos_s"] == fix_at


def test_live_tier_is_untouched() -> None:
    """A tier without pos_epoch reports a real duration already. Re-aging it
    would double-count the time since its own stamp."""
    fc = _fc(_live_feat("b", seen_pos_s=7.0))
    assert _age_cached_positions(fc, now=_T0 + 10_000) == 0
    assert fc["features"][0]["properties"]["seen_pos_s"] == 7.0
    assert "stale" not in fc["features"][0]["properties"]


def test_stale_flag_tracks_the_freshness_threshold() -> None:
    fc = _fc(
        _cached_feat("fresh", pos_epoch=_T0 - 1.0, pull_at=_T0),
        _cached_feat("old", pos_epoch=_T0 - 5 * _FRESH_POS_S, pull_at=_T0),
    )
    _age_cached_positions(fc, now=_T0)
    by_id = {f["id"]: f["properties"] for f in fc["features"]}
    assert by_id["fresh"]["stale"] is False
    assert by_id["old"]["stale"] is True


def test_aged_cached_contact_is_marked_not_dropped() -> None:
    """The count-holding half. An hour-old cached fix is far past the LIVE cap,
    but it keeps its slot (marked) so the breadth tier does not blank out fifteen
    minutes into every UTC day."""
    hour_old = _cached_feat("a", pos_epoch=_T0 - 3600.0, pull_at=_T0)
    _age_cached_positions(_fc(hour_old), now=_T0)

    assert hour_old["properties"]["seen_pos_s"] > _STALE_POS_CAP_S
    assert hour_old["properties"]["stale"] is True
    assert _pos_stale(hour_old) is False  # marked, still served


def test_cached_contact_leaves_the_union_past_a_full_pull_interval() -> None:
    """Marking is not forever. Past a day plus slack the aircraft is unaccounted
    for rather than merely un-refreshed, and it goes."""
    ancient = _cached_feat("a", pos_epoch=_T0 - (_CACHED_POS_CAP_S + 60.0), pull_at=_T0)
    _age_cached_positions(_fc(ancient), now=_T0)
    assert _pos_stale(ancient) is True


def test_live_tier_keeps_the_tighter_cap() -> None:
    """A live tier reporting a 20-minute-old fix has lost the aircraft; the
    cached tier's generous cap must not leak across to it."""
    assert _pos_stale(_live_feat("b", seen_pos_s=_STALE_POS_CAP_S + 1.0)) is True
    assert _pos_stale(_live_feat("b", seen_pos_s=_STALE_POS_CAP_S - 1.0)) is False


def test_unknown_age_is_never_treated_as_stale() -> None:
    """An absent age is not evidence of staleness; dropping unknowns would thin
    the union for no reason."""
    assert _pos_stale({"properties": {}}) is False
    assert _pos_stale({"properties": {"seen_pos_s": "nope"}}) is False
