"""The batch pool's width, ordering, and how it accounts for failure."""

from __future__ import annotations

import asyncio

import pytest

from app import llm_pool


@pytest.mark.asyncio
async def test_never_runs_wider_than_its_width() -> None:
    # The whole point of the pool: a queue that lives here and can be measured,
    # rather than one inside the model server that cannot.
    peak = 0
    live = 0

    async def work(i: int) -> int:
        nonlocal peak, live
        live += 1
        peak = max(peak, live)
        await asyncio.sleep(0.01)
        live -= 1
        return i * 2

    out, stats = await llm_pool.map_bounded(list(range(20)), work, width=3)
    assert peak <= 3
    assert out == [i * 2 for i in range(20)]
    assert stats.completed == 20
    assert stats.failed == 0
    assert stats.slots == 3


@pytest.mark.asyncio
async def test_one_bad_item_does_not_take_the_batch_down() -> None:
    async def work(i: int) -> int:
        if i == 4:
            raise RuntimeError("upstream said no")
        return i

    out, stats = await llm_pool.map_bounded(list(range(8)), work, width=4)
    assert out[4] is None
    assert [x for x in out if x is not None] == [0, 1, 2, 3, 5, 6, 7]
    assert stats.completed == 7
    assert stats.failed == 1


@pytest.mark.asyncio
async def test_results_keep_the_input_order() -> None:
    # Concurrency reorders completion, never results. A caller zipping answers
    # back onto its own documents depends on this.
    async def work(i: int) -> int:
        await asyncio.sleep((10 - i) / 200)
        return i

    out, _ = await llm_pool.map_bounded(list(range(10)), work, width=10)
    assert out == list(range(10))


@pytest.mark.asyncio
async def test_refuses_an_unbounded_batch() -> None:
    async def work(_: int) -> int:
        return 0

    with pytest.raises(ValueError, match="MAX_BATCH"):
        await llm_pool.map_bounded(list(range(llm_pool.MAX_BATCH + 1)), work, width=2)


def test_explicit_width_override_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_POOL_WIDTH", "11")
    assert llm_pool.slots() == 11
    assert llm_pool.describe()["width_source"] == "LLM_POOL_WIDTH"


def test_ollama_width_is_read_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LLM_POOL_WIDTH", raising=False)
    monkeypatch.setattr(llm_pool.llm, "local_engine", lambda: "ollama")
    monkeypatch.setenv("OLLAMA_NUM_PARALLEL", "6")
    assert llm_pool.slots() == 6
    # Unset does NOT mean serial: Ollama auto-sizes, and the 2026-08-05 sweep
    # measured 7.4x at width 8 against a server declaring one slot.
    monkeypatch.delenv("OLLAMA_NUM_PARALLEL", raising=False)
    assert llm_pool.slots() == 4


def test_stats_report_measured_percentiles() -> None:
    s = llm_pool.BatchStats(submitted=4, completed=4, slots=2, wall_s=2.0)
    s.latencies_s = [1.0, 2.0, 3.0, 4.0]
    d = s.as_dict()
    assert d["throughput_per_s"] == 2.0
    assert d["p50_s"] == 3.0  # nearest-rank on 4 samples
    assert d["max_s"] == 4.0
