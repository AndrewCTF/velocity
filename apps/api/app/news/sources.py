"""World-news RSS sources + concurrent fetch / parse.

Every feed URL below has been verified to answer HTTP 200 with items. The
parsing is split so a unit test can feed canned RSS bytes to
:func:`parse_feed_bytes` offline — no network in tests.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass

import feedparser

from app.config import get_settings
from app.upstream import get_client

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    leaning: str
    region: str
    category: str = "general"
    tier: int = 1


@dataclass
class Article:
    title: str
    summary: str
    link: str
    source: str
    leaning: str
    published_iso: str | None
    image: str = ""


# Verified-working RSS feeds (HTTP 200 with items). Diverse leanings on
# purpose: corroboration across leanings is what lets the analyzer separate
# fact from spin.
FEEDS: list[Source] = [
    Source("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml", "center", "UK"),
    Source(
        "Al Jazeera",
        "https://www.aljazeera.com/xml/rss/all.xml",
        "center-left/qatari-state",
        "QA",
    ),
    Source("Guardian World", "https://www.theguardian.com/world/rss", "center-left", "UK"),
    Source("NPR World", "https://feeds.npr.org/1004/rss.xml", "center-left", "US"),
    Source("France24", "https://www.france24.com/en/rss", "center", "FR"),
    Source("DW", "https://rss.dw.com/rdf/rss-en-world", "center", "DE"),
    Source("Sky News World", "https://feeds.skynews.com/feeds/rss/world.xml", "center", "UK"),
    Source("CNBC", "https://www.cnbc.com/id/100727362/device/rss/rss.html", "center", "US"),
    Source("CNN World", "http://rss.cnn.com/rss/edition_world.rss", "center-left", "US"),
    Source("Fox World", "https://moxie.foxnews.com/google-publisher/world.xml", "right", "US"),
    Source(
        "Reuters",
        "https://news.google.com/rss/search?q=when:1d%20source:reuters&hl=en-US&gl=US&ceid=US:en",
        "wire",
        "global",
    ),
    Source(
        "AP",
        "https://news.google.com/rss/search?q=when:1d%20source:%22Associated%20Press%22"
        "&hl=en-US&gl=US&ceid=US:en",
        "wire",
        "global",
    ),
]


def google_news_search(query: str, *, when_days: int = 2) -> str:
    """Build a Google-News RSS keyword-search URL (same host as the wire feeds).

    Boolean ``OR`` and Google's ``when:Nd`` recency operator both work inside
    ``q`` once URL-encoded. The general "world" front-page feeds above routinely
    miss a specific conflict (the front page is bird-flu/sports), so a keyword
    search is what actually puts the war into the corpus the debias/fact-check
    engine reasons over. Keyless, parsed by the same ``parse_feed_bytes`` path.
    """
    from urllib.parse import quote

    q = f"({query}) when:{when_days}d" if when_days else f"({query})"
    return f"https://news.google.com/rss/search?q={quote(q)}&hl=en-US&gl=US&ceid=US:en"


# Conflict-scoped search feeds — folded into the DEFAULT fetch set so the
# Iran/Israel war is present for /feed, /analysis, and /factcheck alike, not just
# when the world front page happens to lead with it.
_MIDEAST_QUERY = (
    "Iran OR Israel OR Hezbollah OR Hamas OR Gaza OR Lebanon OR "
    "Hormuz OR IRGC OR Tehran OR IDF"
)

CONFLICT_FEEDS: list[Source] = [
    Source(
        "Google News · Mideast",
        google_news_search(_MIDEAST_QUERY),
        "aggregator",
        "mideast",
    ),
]

# Named topic presets the API can request by key (free text also accepted).
TOPIC_QUERIES: dict[str, str] = {
    "mideast": _MIDEAST_QUERY,
    "ukraine": "Ukraine OR Russia OR Kyiv OR Moscow OR Donbas OR Crimea",
}


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def strip_html(text: str | None) -> str:
    """Remove HTML tags + collapse whitespace from an RSS summary."""
    if not text:
        return ""
    no_tags = _TAG_RE.sub(" ", text)
    # feedparser leaves entities like &amp; — a light unescape keeps summaries
    # readable without pulling in a heavy HTML parser.
    no_tags = (
        no_tags.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
    )
    return _WS_RE.sub(" ", no_tags).strip()


def _entry_published_iso(entry: object) -> str | None:
    """Best-effort ISO-8601 timestamp from a feedparser entry."""
    import time as _time

    parsed = getattr(entry, "published_parsed", None) or getattr(entry, "updated_parsed", None)
    if parsed:
        try:
            return _time.strftime("%Y-%m-%dT%H:%M:%SZ", parsed)
        except Exception:  # noqa: BLE001 — malformed struct_time → fall through
            pass
    # Fall back to the raw string if present.
    raw = getattr(entry, "published", None) or getattr(entry, "updated", None)
    return str(raw) if raw else None


def _entry_image(entry: object) -> str:
    """Best-effort image URL from an RSS/Atom entry's media tags."""
    # media:thumbnail / media:content (Yahoo MRSS — feedparser normalizes both)
    for attr in ("media_thumbnail", "media_content"):
        items = getattr(entry, attr, None) or []
        for it in items:
            url = (it.get("url") if isinstance(it, dict) else "") or ""
            if url:
                return url.strip()
    # <enclosure type="image/*"> shows up under links with rel="enclosure"
    for lk in getattr(entry, "links", None) or []:
        if isinstance(lk, dict) and lk.get("rel") == "enclosure":
            if str(lk.get("type", "")).startswith("image") and lk.get("href"):
                return str(lk["href"]).strip()
    return ""


def parse_feed_bytes(raw: bytes, source: Source) -> list[Article]:
    """Parse RSS/Atom bytes into normalized :class:`Article` records.

    Pure + offline — the unit tests feed canned bytes here. Never raises on a
    malformed feed; returns whatever entries parsed cleanly.
    """
    parsed = feedparser.parse(raw)
    out: list[Article] = []
    for entry in getattr(parsed, "entries", []) or []:
        title = strip_html(getattr(entry, "title", "")).strip()
        if not title:
            continue
        summary = strip_html(getattr(entry, "summary", "") or getattr(entry, "description", ""))
        link = (getattr(entry, "link", "") or "").strip()
        out.append(
            Article(
                title=title,
                summary=summary,
                link=link,
                source=source.name,
                leaning=source.leaning,
                published_iso=_entry_published_iso(entry),
                image=_entry_image(entry),
            )
        )
    return out


async def _fetch_one(source: Source, timeout_s: float) -> list[Article]:
    """Fetch + parse a single feed; tolerate any failure (log + return [])."""
    try:
        client = get_client()
        r = await client.get(source.url, timeout=timeout_s, follow_redirects=True)
        if r.status_code != 200:
            log.debug("news feed %s -> HTTP %s", source.name, r.status_code)
            return []
        return parse_feed_bytes(r.content, source)
    except Exception as exc:  # noqa: BLE001 — one bad feed must not kill the batch
        log.debug("news feed %s failed: %s", source.name, exc)
        return []


def _published_sort_key(a: Article) -> str:
    # ISO-8601 sorts lexicographically; missing timestamps sort oldest.
    return a.published_iso or ""


# Bounded so a 100+ feed register doesn't fire every fetch concurrently and
# trip upstream throttling (the airplanes.live/ADS-B post-mortem pattern).
_FETCH_CONCURRENCY = 16

# Incremented once per fetch_all() call using the default feed set; decides
# which half of the tier-2 register feeds are in rotation this cycle. Module
# global, deterministic, no randomness so tests can assert on it.
_fetch_cycle = 0


def _select_register_feeds(cycle: int) -> list[Source]:
    """Tier-1 register feeds every cycle; tier-2 feeds in a 2-way rotation."""
    from app.news import feeds_register  # lazy import — avoids an import cycle

    selected: list[Source] = []
    for src in feeds_register.REGISTER:
        if src.tier <= 1 or (hash(src.url) % 2) == (cycle % 2):
            selected.append(src)
    return selected


async def fetch_all(
    timeout_s: float = 12.0,
    *,
    feeds: list[Source] | None = None,
) -> list[Article]:
    """Fetch every feed concurrently (bounded), normalize, dedupe, cap.

    The default feed set is the general world feeds PLUS :data:`CONFLICT_FEEDS`
    PLUS the categorized :data:`app.news.feeds_register.REGISTER` (tier-2
    entries rotate in/out per call so a 100+ feed register doesn't trip
    upstream throttling). Per-feed failures are swallowed (logged) so a single
    dead feed never blanks the whole batch. The total is capped at
    ``settings.news_max_items``.
    """
    global _fetch_cycle
    if feeds is None:
        cycle = _fetch_cycle
        _fetch_cycle += 1
        feeds = FEEDS + CONFLICT_FEEDS + _select_register_feeds(cycle)

    sem = asyncio.Semaphore(_FETCH_CONCURRENCY)

    async def _bounded_fetch(source: Source) -> list[Article]:
        async with sem:
            return await _fetch_one(source, timeout_s)

    results = await asyncio.gather(*(_bounded_fetch(s) for s in feeds))

    seen: set[str] = set()
    articles: list[Article] = []
    for batch in results:
        for art in batch:
            key = art.link or f"{art.source}:{art.title}"
            if key in seen:
                continue
            seen.add(key)
            articles.append(art)

    articles.sort(key=_published_sort_key, reverse=True)
    cap = max(1, get_settings().news_max_items)
    return articles[:cap]


async def fetch_for_topic(topic: str | None, timeout_s: float = 12.0) -> list[Article]:
    """Fetch a single ad-hoc/preset keyword search, or the default union.

    ``topic`` may be a preset key (e.g. ``"mideast"``, ``"ukraine"``) or free
    text; blank/``None`` falls back to the default base+conflict union. Used by
    the route's optional ``?topic=`` param to scope the corpus on demand without
    poisoning the single-slot cache.
    """
    topic = (topic or "").strip()
    if not topic:
        return await fetch_all(timeout_s)
    query = TOPIC_QUERIES.get(topic.lower(), topic)
    feeds = [Source(f"Google News · {topic}", google_news_search(query), "aggregator", topic)]
    return await fetch_all(timeout_s, feeds=feeds)
