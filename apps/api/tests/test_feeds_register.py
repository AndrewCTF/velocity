"""Guards for the expanded categorized news feed register (task A1).

No network by default — REGISTER is static data and rotation is exercised
with a monkeypatched fetcher. A single OSINT_LIVE_PROBE=1-gated test hits the
real network to catch upstream feed rot.
"""

from __future__ import annotations

import os
import random

import pytest

from app.news import sources
from app.news.feeds_register import CATEGORIES, LEANING_BUCKETS, REGISTER
from app.news.sources import Article, Source

_ALLOWED_BUCKETS = {"left", "center", "right", "state", "wire"}


def test_register_urls_are_unique() -> None:
    urls = [s.url for s in REGISTER]
    assert len(urls) == len(set(urls)), "duplicate feed URL in REGISTER"


def test_register_has_at_least_100_feeds() -> None:
    assert len(REGISTER) >= 100, f"only {len(REGISTER)} feeds registered"


def test_every_category_in_register_is_declared() -> None:
    used = {s.category for s in REGISTER}
    assert used <= set(CATEGORIES), f"undeclared categories: {used - set(CATEGORIES)}"
    # And every declared category actually has at least one feed.
    assert set(CATEGORIES) <= used, f"categories with zero feeds: {set(CATEGORIES) - used}"


def test_every_leaning_has_a_bucket() -> None:
    used = {s.leaning for s in REGISTER}
    missing = used - set(LEANING_BUCKETS)
    assert not missing, f"leaning(s) missing from LEANING_BUCKETS: {missing}"


def test_every_bucket_value_is_allowed() -> None:
    bad = set(LEANING_BUCKETS.values()) - _ALLOWED_BUCKETS
    assert not bad, f"bucket(s) outside the allowed set: {bad}"


@pytest.mark.parametrize("category", ["general", "regional"])
def test_general_and_regional_have_diverse_leaning_buckets(category: str) -> None:
    buckets = {LEANING_BUCKETS[s.leaning] for s in REGISTER if s.category == category}
    assert len(buckets) >= 2, f"{category} category only spans buckets {buckets}"


def test_source_dataclass_stays_positionally_compatible() -> None:
    # Existing FEEDS entries construct Source positionally with 4 args; the
    # additive category/tier fields must default without breaking that.
    s = Source("Name", "https://example.com/rss", "center", "US")
    assert s.category == "general"
    assert s.tier == 1


# ── rotation (no network — stub the per-feed fetch) ─────────────────────────


def test_tier2_rotation_differs_across_cycles_tier1_stays_fixed(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[Source]] = []

    async def _fake_fetch_one(source: Source, timeout_s: float) -> list[Article]:
        return []

    async def _capture_bounded(feeds: list[Source]) -> None:
        calls.append(list(feeds))

    monkeypatch.setattr(sources, "_fetch_one", _fake_fetch_one)
    monkeypatch.setattr(sources, "_fetch_cycle", 0)

    async def run_cycle() -> set[str]:
        # fetch_all builds the feed list internally; capture it by wrapping
        # _select_register_feeds so we see exactly what tier-2 rotation chose,
        # while _fetch_one (stubbed above) keeps the run network-free.
        cycle = sources._fetch_cycle
        selected = sources._select_register_feeds(cycle)
        await sources.fetch_all(feeds=sources.FEEDS + sources.CONFLICT_FEEDS + selected)
        return {s.url for s in selected}

    import asyncio

    tier1_urls = {s.url for s in REGISTER if s.tier <= 1}

    urls_cycle_0 = asyncio.run(run_cycle())
    sources._fetch_cycle = 1
    urls_cycle_1 = asyncio.run(run_cycle())

    tier2_cycle_0 = urls_cycle_0 - tier1_urls
    tier2_cycle_1 = urls_cycle_1 - tier1_urls
    assert tier2_cycle_0 != tier2_cycle_1, "tier-2 rotation did not change across cycles"

    assert (urls_cycle_0 & tier1_urls) == (urls_cycle_1 & tier1_urls) == tier1_urls, (
        "tier-1 feeds must be present identically on every cycle"
    )


def test_fetch_all_default_unions_register_with_bounded_concurrency(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    fetched: list[str] = []

    async def _fake_fetch_one(source: Source, timeout_s: float) -> list[Article]:
        fetched.append(source.url)
        return []

    monkeypatch.setattr(sources, "_fetch_one", _fake_fetch_one)
    monkeypatch.setattr(sources, "_fetch_cycle", 0)

    asyncio.run(sources.fetch_all())

    # The default set includes FEEDS, CONFLICT_FEEDS, and at least the
    # tier-1 register feeds.
    tier1_urls = {s.url for s in REGISTER if s.tier <= 1}
    assert tier1_urls <= set(fetched)
    base_urls = {s.url for s in sources.FEEDS + sources.CONFLICT_FEEDS}
    assert base_urls <= set(fetched)


# ── live probe (network) ────────────────────────────────────────────────────


@pytest.mark.skipif(
    not os.environ.get("OSINT_LIVE_PROBE"),
    reason="live probe: set OSINT_LIVE_PROBE=1 to hit real feed URLs",
)
def test_random_register_feeds_are_live() -> None:
    import asyncio

    sample = random.sample(REGISTER, k=min(3, len(REGISTER)))

    async def _probe(src: Source) -> int:
        arts = await sources._fetch_one(src, 12.0)
        return len(arts)

    async def _probe_all() -> list[int]:
        return await asyncio.gather(*(_probe(s) for s in sample))

    counts = asyncio.run(_probe_all())
    failures = [(s.name, c) for s, c in zip(sample, counts, strict=True) if c < 1]
    assert not failures, f"live probe found dead feed(s): {failures}"
