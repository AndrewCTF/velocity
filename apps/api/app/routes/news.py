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
import math
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.news import analyze as news_analyze
from app.news import brief as news_brief
from app.news import history_local
from app.news import images as news_images
from app.news import sources as news_sources
from app.news import store
from app.news import verify as news_verify
from app.news.storygeo import locate_story

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


def _matches_iso3(article: news_sources.Article, iso3u: str) -> bool:
    """True when ``article`` names the given country, via the same
    deterministic title+summary name-matching :func:`app.news.verify.country_tags`
    already uses for edition stories — reused here (not duplicated) so a
    country and its news share one definition of "about this country"."""
    from app.news.verify import country_tags  # noqa: PLC0415 — avoid import cycle at module load

    tags = country_tags({"title": article.title, "neutral_summary": article.summary})
    return iso3u in tags


@router.get("/api/news/feed")
async def news_feed(
    topic: str | None = Query(None, max_length=200),
    iso3: str | None = Query(None, min_length=3, max_length=3),
) -> dict[str, Any]:
    """Latest scraped world headlines (cached, refreshed on staleness).

    The default corpus already carries the conflict feed (see
    :data:`app.news.sources.CONFLICT_FEEDS`). An optional ``?topic=`` (preset
    key like ``mideast`` or free text) fetches a scoped keyword search on demand,
    bypassing the single-slot cache so it never poisons the default feed.

    ``?iso3=`` filters the returned headlines to those whose title/summary
    names that country (best-effort text match, same rule the news edition
    uses for its per-story ``countries`` tags — see the Country app's news
    card). Never errors on an unknown/garbage code; it just yields zero rows.
    """
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False}
    if topic and topic.strip():
        articles = await news_sources.fetch_for_topic(topic)
    else:
        articles = await _ensure_articles()
    if iso3 and iso3.strip():
        iso3u = iso3.strip().upper()
        articles = [a for a in articles if _matches_iso3(a, iso3u)]
    return {"count": len(articles), "articles": _articles_payload(articles)}


# Serialize analysis so the background refresher and an on-demand request never
# fire two concurrent (slow, rate-limited) reason-tier calls — the race that
# made one of them fail and cache an "llm unavailable" result as if fresh.
_analysis_lock = asyncio.Lock()

_EDITION_REFRESH_SEC = 1200  # ~20 min — ~40 reason-tier rewrites is expensive
_edition_lock = asyncio.Lock()


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


def _empty_edition() -> dict[str, Any]:
    return {
        "generated": None, "categories": news_analyze.EDITION_CATEGORIES,
        "lead": None, "stories": [], "method": "not yet built",
        "backend": None, "article_count": 0, "source_count": 0,
    }


async def _refresh_edition() -> dict[str, Any]:
    """Build + cache the edition under a lock; never cache an LLM-down result."""
    async with _edition_lock:
        if not store.is_edition_stale(_EDITION_REFRESH_SEC):
            cached = store.get_edition()
            if cached is not None:
                return cached
        articles = await _ensure_articles()
        edition = await news_analyze.analyze_edition(articles)
        if edition.get("stories"):
            store.set_edition(edition)
        return edition


@router.get("/api/news/edition")
async def news_edition() -> Any:
    """Public Velocity News edition (cached; refreshed by the background loop).

    Public + keyless. Serves the cached edition; if none exists yet it kicks a
    build but returns a well-formed empty edition rather than blocking the page.
    """
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False, **_empty_edition()}
    cached = store.get_edition()
    if cached is not None:
        return cached
    # No edition yet: try a short build, else empty-state. ANY failure (timeout,
    # upstream RSS error, LLM raise) must degrade to a 200 empty edition — the
    # public page must never see a 500 or hang.
    try:
        return await asyncio.wait_for(_refresh_edition(), timeout=88.0)
    except Exception as exc:  # noqa: BLE001 — never 500 the public page
        log.warning("news edition on-demand build failed: %s", exc)
        return _empty_edition()


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


_HISTORY_KINDS = ("edition", "analysis", "brief")


@router.get("/api/news/brief")
async def news_brief_route() -> Any:
    """Latest assembled morning brief (top story per category + one synthesis
    paragraph). Built by the background refresher on a ~20h cadence and served
    straight from local history — never built on-demand by this route.
    """
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False}
    row = await history_local.latest("brief")
    if row is None:
        return JSONResponse(status_code=404, content={"error": "no brief yet"})
    return row["payload"]


@router.get("/api/news/history")
async def news_history(
    kind: str = Query("edition"),
    limit: int = Query(20, ge=1, le=50),
) -> Any:
    """Light index of recent local-history snapshots for ``kind``
    (``edition`` | ``analysis`` | ``brief``). Payloads are excluded to keep the
    list cheap — fetch the full latest payload via ``/api/news/edition``,
    ``/api/news/analysis``, or ``/api/news/brief`` instead.
    """
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False}
    if kind not in _HISTORY_KINDS:
        return JSONResponse(
            status_code=400,
            content={"error": f"invalid kind: {kind!r}", "valid_kinds": list(_HISTORY_KINDS)},
        )
    rows = await history_local.list_snapshots(kind, limit=limit)
    items = [
        {
            "id": r["id"],
            "kind": r["kind"],
            "created_utc": r["created_utc"],
            "article_count": r["article_count"],
            "verified_count": r["verified_count"],
        }
        for r in rows
    ]
    return {"items": items}


# ── background refresher ────────────────────────────────────────────────────

_IMAGE_ENRICH_LIMIT = 60
_BRIEF_REFRESH_SEC = 20 * 3600  # ~20h cadence — a brief is a slow-moving digest


def _brief_is_stale(latest_row: dict[str, Any] | None) -> bool:
    """True when there is no brief snapshot yet, or its ``created_utc`` is
    older than :data:`_BRIEF_REFRESH_SEC`. An unparseable timestamp is treated
    as stale (rebuild rather than get stuck never refreshing)."""
    if latest_row is None:
        return True
    created = latest_row.get("created_utc")
    if not created:
        return True
    try:
        created_dt = datetime.fromisoformat(created)
    except ValueError:
        return True
    if created_dt.tzinfo is None:
        created_dt = created_dt.replace(tzinfo=UTC)
    return (datetime.now(UTC) - created_dt).total_seconds() > _BRIEF_REFRESH_SEC


async def refresh_once() -> dict[str, Any]:
    """Fetch → analyze → cache (analysis), then best-effort build the edition,
    bias-verify it, backfill missing images, write-through both snapshots to
    local history, and (on a ~20h cadence) assemble + persist a fresh brief.

    Every stage past the base analysis is best-effort: a verify/image/history/
    brief failure is logged and skipped, never re-raised — the in-memory
    serving path (``/api/news/edition``, ``/api/news/analysis``) must keep
    working even when local persistence or the verifier ensemble is down.
    """
    result = await _refresh_analysis()
    try:
        edition = await _refresh_edition()
    except Exception as exc:  # noqa: BLE001 — edition failure must not kill the loop
        log.warning("news edition build failed: %s", exc)
        edition = None

    if not edition or not edition.get("stories"):
        return result

    try:
        edition = await news_verify.verify_edition(edition)
        store.set_edition(edition)
    except Exception as exc:  # noqa: BLE001 — verify failure serves the unverified edition
        log.warning("news edition verify failed: %s", exc)

    try:
        await news_images.enrich_images(edition.get("stories") or [], limit=_IMAGE_ENRICH_LIMIT)
    except Exception as exc:  # noqa: BLE001 — image enrichment is cosmetic, best-effort
        log.warning("news image enrichment failed: %s", exc)

    try:
        # Deterministic, no-network location resolution (A8): attach a real
        # satellite AOI only for stories that name a specific chokepoint/sea/
        # canal/port. Cheap CPU-only pass over every story in the edition —
        # most stories get no confident location and no `geo` field at all.
        for s in edition.get("stories") or []:
            if isinstance(s, dict):
                geo = locate_story(s)
                if geo is not None:
                    s["geo"] = geo
    except Exception as exc:  # noqa: BLE001 — geo attach is cosmetic, best-effort
        log.warning("news story geo resolution failed: %s", exc)

    stories = edition.get("stories") or []
    verified_count = sum(
        1
        for s in stories
        if isinstance(s, dict) and (s.get("verification") or {}).get("status") == "verified-neutral"
    )

    try:
        await history_local.append_snapshot(
            "edition",
            edition,
            article_count=int(edition.get("article_count") or 0),
            verified_count=verified_count,
        )
        await history_local.append_snapshot(
            "analysis",
            result,
            article_count=len(store.get_articles()),
            verified_count=verified_count,
        )
    except Exception as exc:  # noqa: BLE001 — a DB error must not break in-memory serving
        log.warning("news history append failed: %s", exc)

    try:
        latest_brief = await history_local.latest("brief")
        if _brief_is_stale(latest_brief):
            b = await news_brief.build_brief(edition)
            await history_local.append_snapshot("brief", b)
    except Exception as exc:  # noqa: BLE001 — brief cadence is best-effort
        log.warning("news brief build failed: %s", exc)

    return result


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
