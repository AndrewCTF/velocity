"""Best-effort og:image enrichment for published news leads.

Pure parser (offline-testable) + a bounded, cached fetch. Only called for the
handful of stories that actually ship in an edition — never the full 400-article
corpus. Any failure degrades to "" so the edition never blocks on a slow page.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
from urllib.parse import urljoin, urlparse

from app.upstream import get_client

log = logging.getLogger(__name__)

# ponytail: in-memory URL->image cache, single fetch attempt. Swap to a
# persistent/LRU cache if refresh cost matters.
_cache: dict[str, str] = {}

# SSRF guard: og:image URLs come from third-party RSS, so they are
# attacker-influenced. Only fetch public http(s) hosts, and re-validate every
# redirect hop — otherwise a feed could steer the server at 127.0.0.1 or the
# cloud metadata endpoint (169.254.169.254).
_MAX_REDIRECTS = 3

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


async def _is_public_url(url: str) -> bool:
    """True only for an http(s) URL whose host resolves to public unicast IPs.

    Resolves the host (async, no blocking the loop) and rejects the request if
    ANY resolved address is loopback/private/link-local/reserved/multicast —
    the SSRF gate. A literal-IP host is parsed directly (no DNS, offline-safe).
    """
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    try:
        infos = await asyncio.get_event_loop().getaddrinfo(p.hostname, p.port or None)
    except Exception:  # noqa: BLE001 — unresolvable host → treat as unsafe
        return False
    if not infos:
        return False
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_reserved
            or addr.is_multicast
            or addr.is_unspecified
        ):
            return False
    return True


async def fetch_og_image(url: str, timeout_s: float = 6.0) -> str:
    """Fetch a page and pull its og:image. Cached; "" on any failure.

    SSRF-guarded: validates the scheme + resolved IP of the URL and of every
    redirect hop before issuing each request (``follow_redirects=False`` so a
    302 to an internal address cannot slip past the check).
    """
    url = (url or "").strip()
    if not url:
        return ""
    if url in _cache:
        return _cache[url]
    img = ""
    try:
        client = get_client()
        cur = url
        for _ in range(_MAX_REDIRECTS + 1):
            if not await _is_public_url(cur):
                break
            r = await client.get(
                cur, timeout=timeout_s, follow_redirects=False,
                headers={"User-Agent": _UA},
            )
            loc = r.headers.get("location")
            if r.status_code in (301, 302, 303, 307, 308) and loc:
                cur = urljoin(cur, loc)
                continue
            if r.status_code == 200:
                # Only need the <head>; cap bytes scanned.
                img = parse_og_image(r.text[:200_000])
            break
    except Exception as exc:  # noqa: BLE001 — best effort, never raise
        log.debug("og:image fetch %s failed: %s", url, exc)
    _cache[url] = img
    return img
