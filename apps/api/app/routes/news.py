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

import math

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

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
async def news_feed(
    topic: str | None = Query(None, max_length=200),
) -> dict[str, Any]:
    """Latest scraped world headlines (cached, refreshed on staleness).

    The default corpus already carries the conflict feed (see
    :data:`app.news.sources.CONFLICT_FEEDS`). An optional ``?topic=`` (preset
    key like ``mideast`` or free text) fetches a scoped keyword search on demand,
    bypassing the single-slot cache so it never poisons the default feed.
    """
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False}
    if topic and topic.strip():
        articles = await news_sources.fetch_for_topic(topic)
    else:
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
async def news_analysis() -> Any:
    """Cross-source debias + fact-check bundle (cached; refresh on staleness).

    Hard-capped at 88 s (inside Cloudflare's 100 s origin timeout) so a hung
    reason-tier call returns a 503/partial instead of timing out at the edge.
    """
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False}
    if store.is_analysis_stale(s.news_refresh_sec):
        try:
            result = await asyncio.wait_for(_refresh_analysis(), timeout=88.0)
        except TimeoutError:
            cached = store.get_analysis()
            partial = cached if cached is not None else {"events": [], "method": "partial"}
            return JSONResponse(status_code=503, content={"partial": True, **partial})
        return result
    cached = store.get_analysis()
    return cached if cached is not None else {"events": [], "method": "not yet analyzed"}


@router.get("/api/news/factcheck")
async def news_factcheck(
    claim: str = Query(..., min_length=1, max_length=2000),
    topic: str | None = Query(None, max_length=200),
    fast: bool = Query(False),
    as_of: str | None = Query(None, max_length=100),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float | None = Query(None, ge=0.0),
) -> dict[str, Any]:
    """Adjudicate a single free-text claim against current headlines.

    ``?topic=`` pulls a scoped keyword search on demand (so a war claim has
    matching in-theater headlines to adjudicate against even if the cached feed
    hasn't surfaced it); otherwise the cached corpus (which carries the conflict
    feed) is used. ``?fast=true`` uses the cheap LLM tier for a quick verdict.

    ``?as_of=`` — optional timestamp string forwarded to the fact-checker so it
    scopes its reasoning temporally. ``?lat=&lon=&radius_nm=`` — when all three
    are present, a bounding box is computed and forwarded for geographic scoping.
    """
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False}
    if topic and topic.strip():
        headlines = [a.title for a in await news_sources.fetch_for_topic(topic)] or None
    else:
        headlines = [a.title for a in store.get_articles()] or None

    # Build bbox from lat/lon/radius_nm when all three are provided.
    bbox: tuple[float, float, float, float] | None = None
    if lat is not None and lon is not None and radius_nm is not None:
        deg = radius_nm / 60.0  # 1 nautical mile ≈ 1 arcminute ≈ 1/60 degree
        lat_d = deg
        lon_d = deg / max(math.cos(math.radians(lat)), 1e-6)
        bbox = (lon - lon_d, lat - lat_d, lon + lon_d, lat + lat_d)

    # Hard-cap at 90 s (inside Cloudflare's 100 s origin timeout) so a hung
    # reason-tier MiniMax→DeepSeek chain returns a clean 503 rather than a 504.
    try:
        return await asyncio.wait_for(
            news_analyze.factcheck(
                claim,
                context_headlines=headlines,
                fast=fast,
                as_of=as_of,
                bbox=bbox,
            ),
            timeout=90.0,
        )
    except TimeoutError:
        return JSONResponse(
            status_code=503,
            content={"claim": claim, "verdict": "unavailable", "note": "fact-check timed out"},
        )


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
