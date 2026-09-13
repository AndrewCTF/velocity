"""The sidecar-only snapshot path must attribute its tier like every other one.

`_do_global_fanout` has an early return for ADSB_SIDECAR_ONLY deployments (the
default on a box with a healthy tar1090 sidecar). It built its feature dict with
`_merge_raw_into(sidecar, feeds0)` — no observer map, no tier — and returned
without calling `_stamp_sources`. So every contact it served carried no
`sources`, no `source_count` and no `confidence`.

Measured on this box 2026-08-30 before the fix: 8,081 of 8,588 features
unattributed, 94%. /api/status/provenance reported them as `unattributed`
rather than guessing, which was the honest thing to do with a writer that never
spoke — but "we cannot speak to 94% of the contacts" is not an answer an
analyst can use, and the README stakes the product on "which independent
sources reported it, how many agreed".

One tier means every contact here is single-source. Saying THAT plainly is the
fix; inventing corroboration is not.
"""

from __future__ import annotations

import pytest

from app.routes import adsb


def _raw(hexid: str, lon: float = 1.0, lat: float = 51.0) -> dict:
    return {"hex": hexid, "lon": lon, "lat": lat, "flight": "TEST123", "seen_pos": 1.0}


def test_the_sidecar_only_path_stamps_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    import anyio

    settings = adsb.get_settings()
    monkeypatch.setattr(settings, "adsb_sidecar_only", True, raising=False)
    monkeypatch.setattr(adsb, "get_settings", lambda: settings)
    # Enough contacts to clear the sidecar-only floor so the early return fires.
    raw = [_raw(f"a{i:05x}") for i in range(adsb._SIDECAR_ONLY_FLOOR + 5)]

    async def _feeds():
        return raw

    monkeypatch.setattr(adsb, "_readsb_feeds", _feeds)

    fc = anyio.run(adsb._do_global_fanout)
    feats = fc["features"]
    assert len(feats) >= adsb._SIDECAR_ONLY_FLOOR

    unattributed = [f for f in feats if not (f.get("properties") or {}).get("sources")]
    assert not unattributed, (
        f"{len(unattributed)}/{len(feats)} contacts left the sidecar-only path with no "
        "`sources`. That path returns before _stamp_sources unless it is told to stamp."
    )

    props = feats[0]["properties"]
    assert props["sources"] == ["feeds"], props["sources"]
    assert props["source_count"] == 1
    # The confidence rule is published next to the code that implements it, and
    # a stamped contact must carry its verdict.
    assert props.get("confidence")


def test_one_tier_reports_single_source_not_fake_corroboration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fix must not manufacture agreement out of one observer."""
    import anyio

    settings = adsb.get_settings()
    monkeypatch.setattr(settings, "adsb_sidecar_only", True, raising=False)
    monkeypatch.setattr(adsb, "get_settings", lambda: settings)
    raw = [_raw(f"b{i:05x}") for i in range(adsb._SIDECAR_ONLY_FLOOR + 5)]

    async def _feeds():
        return raw

    monkeypatch.setattr(adsb, "_readsb_feeds", _feeds)
    fc = anyio.run(adsb._do_global_fanout)

    counts = {(f["properties"]["source_count"]) for f in fc["features"]}
    assert counts == {1}, f"expected every contact single-source, got {counts}"
