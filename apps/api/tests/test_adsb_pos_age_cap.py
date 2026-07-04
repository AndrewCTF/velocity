"""The served snapshot must not carry position-stale stragglers.

Regression guard for the "aircraft 44m ago (a few)" bug: OpenSky is pulled
once/UTC-day and served cached, so a contact that was already out-of-coverage at
pull time keeps a FROZEN seen_pos_s while its seen_at is re-stamped fresh each
cycle. Before the cap it rode the union all day and surfaced in EntityPanel as
"44m ago". viewport_filter now drops any served feature whose seen_pos_s exceeds
_STALE_POS_CAP_S, and _merge_with_previous refuses to carry such a contact
forward. Contacts with fresh or unknown position age are untouched (count held).
"""

from __future__ import annotations

import time

from app.routes.adsb import _STALE_POS_CAP_S, _merge_with_previous, viewport_filter


def _feat(fid: str, seen_pos_s: float | None, source: str = "adsb") -> dict:
    props: dict = {"icao24": fid, "source": source, "seen_at": time.time()}
    if seen_pos_s is not None:
        props["seen_pos_s"] = seen_pos_s
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Point", "coordinates": [0.0, 0.0]},
        "properties": props,
    }


def _fc(feats: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": feats}


def _ids(fc: dict) -> set[str]:
    return {f["id"] for f in fc["features"]}


def test_viewport_filter_drops_position_stale_features() -> None:
    over = _STALE_POS_CAP_S + 1.0
    fc = _fc(
        [
            _feat("aircraft:fresh", 3.0),
            _feat("aircraft:borderline", _STALE_POS_CAP_S),  # == cap → kept
            _feat("aircraft:stale", over),  # > cap → dropped
            _feat("aircraft:unknown", None),  # no seen_pos_s → kept
        ]
    )
    out = viewport_filter(fc, None, None, None, None, None)
    kept = _ids(out)
    assert "aircraft:stale" not in kept
    assert kept == {"aircraft:fresh", "aircraft:borderline", "aircraft:unknown"}


def test_viewport_filter_holds_fresh_union_count() -> None:
    # A realistic union: mostly fresh + a few frozen stragglers. Count stays high.
    fresh = [_feat(f"aircraft:{n:06x}", 2.0) for n in range(9000)]
    stale = [_feat(f"aircraft:s{n:05x}", 2600.0) for n in range(30)]
    out = viewport_filter(_fc(fresh + stale), None, None, None, None, _WORLD := 20000)
    assert len(out["features"]) == 9000  # all stragglers gone, breadth intact


def test_merge_with_previous_refuses_stale_carry_forward() -> None:
    new = _fc([_feat("aircraft:mover", 2.0)])
    prev = _fc(
        [
            _feat("aircraft:mover", 2.0),
            _feat("aircraft:stragglerA", 5.0),  # fresh position → carried forward
            _feat("aircraft:stragglerB", _STALE_POS_CAP_S + 60.0),  # stale → dropped
        ]
    )
    merged = _merge_with_previous(new, prev)
    kept = _ids(merged)
    assert "aircraft:stragglerB" not in kept
    assert kept == {"aircraft:mover", "aircraft:stragglerA"}
