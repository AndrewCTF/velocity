"""Best-effort og:image enrichment for published news leads.

Pure parser (offline-testable) + a bounded, cached fetch. Only called for the
handful of stories that actually ship in an edition — never the full 400-article
corpus. Any failure degrades to "" so the edition never blocks on a slow page.
"""
from __future__ import annotations

import logging
import re

from app.upstream import get_client

log = logging.getLogger(__name__)

# ponytail: in-memory URL->image cache, single fetch attempt. Swap to a
# persistent/LRU cache if refresh cost matters.
_cache: dict[str, str] = {}

_OG_RE = re.compile(
    r"""<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*>""",
    re.IGNORECASE,
)
_CONTENT_RE = re.compile(r"""content\s*=\s*["']([^"']+)["']""", re.IGNORECASE)

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def parse_og_image(html: str) -> str:
    """Extract the og:image (or twitter:image) URL from page HTML; "" if none."""
    if not html:
        return ""
    m = _OG_RE.search(html)
    if not m:
        return ""
    c = _CONTENT_RE.search(m.group(0))
    return c.group(1).strip() if c else ""


async def fetch_og_image(url: str, timeout_s: float = 6.0) -> str:
    """Fetch a page and pull its og:image. Cached; "" on any failure."""
    url = (url or "").strip()
    if not url:
        return ""
    if url in _cache:
        return _cache[url]
    img = ""
    try:
        client = get_client()
        r = await client.get(
            url, timeout=timeout_s, follow_redirects=True,
            headers={"User-Agent": _UA},
        )
        if r.status_code == 200:
            # Only need the <head>; cap bytes scanned.
            img = parse_og_image(r.text[:200_000])
    except Exception as exc:  # noqa: BLE001 — best effort, never raise
        log.debug("og:image fetch %s failed: %s", url, exc)
    _cache[url] = img
    return img
