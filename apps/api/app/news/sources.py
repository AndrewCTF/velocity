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


@dataclass
class Article:
    title: str
    summary: str
    link: str
    source: str
    leaning: str
    published_iso: str | None


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


async def fetch_all(timeout_s: float = 12.0) -> list[Article]:
    """Fetch every feed concurrently, normalize, dedupe, newest-first, capped.

    Per-feed failures are swallowed (logged) so a single dead feed never blanks
    the whole batch. The total is capped at ``settings.news_max_items``.
    """
    results = await asyncio.gather(*(_fetch_one(s, timeout_s) for s in FEEDS))

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
