"""SAR sweep loop — caching + summary, with the imagery fetch stubbed."""

from __future__ import annotations

import asyncio
from typing import Any

from app.intel import sar_sweep


def _fc(mil: int, dark: int, n: int) -> dict[str, Any]:
    return {
        "features": [{"type": "Feature", "properties": {"milHint": i < mil}} for i in range(n)],
        "summary": {"label": "X", "detections": n, "mil_hints": mil, "dark_candidates": dark,
                    "ais_coverage": 0, "px_size_m": 20.0, "date": "2026-07-04"},
    }


def test_sweep_caches_and_ranks(monkeypatch) -> None:
    sar_sweep.reset_state()

    async def fake_detect(aoi: str, *a, **k) -> dict[str, Any]:
        return {"hormuz": _fc(2, 1, 5), "taiwan-strait": _fc(0, 0, 1)}.get(aoi, _fc(0, 0, 0))

    monkeypatch.setattr(sar_sweep.sar_vessels, "detect_dark_vessels", fake_detect)
    monkeypatch.setattr(sar_sweep, "_GAP_S", 0.0)

    hit = asyncio.run(sar_sweep.sweep_once(["hormuz", "taiwan-strait"]))
    assert hit == 2  # both had ≥1 detection

    latest = sar_sweep.latest()
    assert latest["total_detections"] == 6
    assert latest["total_mil_hints"] == 2
    # ranked: hormuz (2 mil-hints) before taiwan-strait (0)
    assert latest["aois"][0]["aoi"] == "hormuz"

    full = sar_sweep.results_for("hormuz")
    assert full is not None and full["type"] == "FeatureCollection"
    assert len(full["features"]) == 5
    assert sar_sweep.results_for("never-swept") is None


def test_sweep_isolates_a_failing_aoi(monkeypatch) -> None:
    sar_sweep.reset_state()

    async def flaky(aoi: str, *a, **k) -> dict[str, Any]:
        if aoi == "bad":
            raise RuntimeError("upstream 500")
        return _fc(0, 0, 3)

    monkeypatch.setattr(sar_sweep.sar_vessels, "detect_dark_vessels", flaky)
    monkeypatch.setattr(sar_sweep, "_GAP_S", 0.0)

    asyncio.run(sar_sweep.sweep_once(["bad", "hormuz"]))
    # bad AOI skipped, good one cached
    assert sar_sweep.results_for("bad") is None
    assert sar_sweep.results_for("hormuz") is not None
