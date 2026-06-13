"""GET /api/news/* — debias + fact-check news engine.

Three read endpoints plus a background refresher that the app lifespan starts /
stops:
  - ``/api/news/feed``      — the latest scraped headlines (cached).
  - ``/api/news/analysis``  — the cross-source debias / fact-check bundle.
  - ``/api/news/factcheck`` — adjudicate one free-text claim.

The refresher (``start_refresher`` / ``stop_refresher``) loops every
``settings.news_refresh_sec``, calling :func:`refresh_once` (fetch → analyze →
cache). Modeled on :mod:`app.correlate.runner`'s start/stop_all idiom.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Query

from app.config import get_settings
from app.news import analyze as news_analyze
from app.news import sources as news_sources
from app.news import store

log = logging.getLogger(__name__)

router = APIRouter(tags=["news"])


def _articles_payload(articles: list[news_sources.Article]) -> list[dict[str, Any]]:
    return [
        {
            "title": a.title,
            "summary": a.summary,
            "link": a.link,
            "source": a.source,
            "leaning": a.leaning,
            "published": a.published_iso,
        }
        for a in articles
    ]


async def _ensure_articles() -> list[news_sources.Article]:
    """Return cached articles, fetching + caching if empty or stale."""
    s = get_settings()
    age = store.articles_age_s()
    if store.has_articles() and age is not None and age <= s.news_refresh_sec:
        return store.get_articles()
    articles = await news_sources.fetch_all()
    store.set_articles(articles)
    return articles


@router.get("/api/news/feed")
async def news_feed() -> dict[str, Any]:
    """Latest scraped world headlines (cached, refreshed on staleness)."""
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False}
    articles = await _ensure_articles()
    return {"count": len(articles), "articles": _articles_payload(articles)}


# Serialize analysis so the background refresher and an on-demand request never
# fire two concurrent (slow, rate-limited) reason-tier calls — the race that
# made one of them fail and cache an "llm unavailable" result as if fresh.
_analysis_lock = asyncio.Lock()


async def _refresh_analysis() -> dict[str, Any]:
    """Refresh the cached analysis under a lock, double-checking staleness.

    A failed analysis (``method == "llm unavailable"``) is NOT cached as fresh,
    so the next request retries instead of serving the error for a full refresh
    interval.
    """
    s = get_settings()
    async with _analysis_lock:
        if not store.is_analysis_stale(s.news_refresh_sec):
            cached = store.get_analysis()
            if cached is not None:
                return cached
        articles = await _ensure_articles()
        analysis = await news_analyze.analyze(articles)
        if analysis.get("method") != "llm unavailable":
            store.set_analysis(analysis)
        return analysis


@router.get("/api/news/analysis")
async def news_analysis() -> dict[str, Any]:
    """Cross-source debias + fact-check bundle (cached; refresh on staleness)."""
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False}
    if store.is_analysis_stale(s.news_refresh_sec):
        return await _refresh_analysis()
    cached = store.get_analysis()
    return cached if cached is not None else {"events": [], "method": "not yet analyzed"}


@router.get("/api/news/factcheck")
async def news_factcheck(
    claim: str = Query(..., min_length=1, max_length=2000),
) -> dict[str, Any]:
    """Adjudicate a single free-text claim against current headlines."""
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False}
    headlines = [a.title for a in store.get_articles()] or None
    return await news_analyze.factcheck(claim, context_headlines=headlines)


# ── background refresher ────────────────────────────────────────────────────


async def refresh_once() -> dict[str, Any]:
    """Fetch → analyze → cache, once (shares the analysis lock). Returns the dict."""
    return await _refresh_analysis()


async def _refresh_loop(stop: asyncio.Event) -> None:
    # Small warmup so the app finishes booting before the first scrape + the
    # (slow) reason-tier analysis fire; keeps cold start snappy. A set stop
    # event during warmup exits early.
    try:
        await asyncio.wait_for(stop.wait(), timeout=3.0)
        return
    except TimeoutError:
        pass

    while not stop.is_set():
        try:
            await refresh_once()
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            log.warning("news refresh failed: %s", exc)
        interval = max(60, get_settings().news_refresh_sec)
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            continue


_tasks: list[asyncio.Task[None]] = []
_stop = asyncio.Event()


def start_refresher() -> None:
    """Start the background fetch+analyze loop (no-op when disabled/running)."""
    if _tasks:
        return
    if not get_settings().news_enabled:
        return
    _stop.clear()
    _tasks.append(asyncio.create_task(_refresh_loop(_stop), name="news_refresh"))


async def stop_refresher() -> None:
    """Cancel the background loop and await its teardown."""
    _stop.set()
    for t in _tasks:
        t.cancel()
    for t in _tasks:
        try:
            await t
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    _tasks.clear()
