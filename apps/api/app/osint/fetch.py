"""Shared fetch primitives for the keyless OSINT connectors.

Two concerns live here so the connectors stay thin:

1. **Target validation.** Every lookup takes a user-supplied domain or IP. We
   validate its FORMAT before it ever reaches an upstream — a bad target is a
   400, not a mangled request. Note: classic SSRF (the server being steered at an
   internal address) does NOT apply to these connectors — the fetch *host* is
   always a fixed, trusted provider (``dns.google``, ``crt.sh`` …); the user
   controls only the query string. A future connector that fetches a
   *user-supplied URL* must add the resolve-and-reject guard from
   ``news/images.py:_is_public_url`` — it isn't needed here.

2. **Bounded JSON fetch.** ``fetch_json`` layers a small concurrency semaphore +
   the shared ``upstream.cache`` TTL cache over the shared httpx client, so a
   burst of connectors can't hammer a free API and repeat lookups are cached.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
from typing import Any

from app.upstream import cache, get_client

# Polite cap: connectors fan out ~4-6 upstreams per investigate; keep total
# in-flight OSINT upstream calls bounded so a multi-target session stays under
# the free-tier rate limits (ip-api is 45/min, crt.sh throttles bursts).
_SEMAPHORE = asyncio.Semaphore(6)

# A browser UA — some providers (crt.sh behind Cloudflare) reject the default.
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# RFC-1123 hostname: labels of a-z0-9- (no leading/trailing hyphen), 1+ dots,
# TLD is alphabetic. Rejects IPs, ports, schemes, paths, and injection chars.
_DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
)


def normalise_domain(target: str) -> str | None:
    """Lower-case + strip a domain; return None if it isn't a valid FQDN."""
    t = (target or "").strip().lower().rstrip(".")
    # Tolerate a pasted URL — keep just the host.
    if "//" in t:
        t = t.split("//", 1)[1]
    t = t.split("/", 1)[0].split(":", 1)[0]
    return t if _DOMAIN_RE.match(t) else None


def normalise_ip(target: str) -> str | None:
    """Return the canonical string form of a valid IPv4/IPv6 target, else None."""
    t = (target or "").strip()
    try:
        return str(ipaddress.ip_address(t))
    except ValueError:
        return None


# An email local-part is permissive (RFC 5322 is huge); this covers the real
# world without accepting injection chars. Username: a handle 1-39 chars of
# a-z0-9 plus - and _ (GitHub's own ceiling), no dots (a dotted string is a domain).
_EMAIL_RE = re.compile(r"^[a-z0-9._%+\-]+@([a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
_USERNAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9\-_]{0,38})$")


def normalise_email(target: str) -> str | None:
    """Lower-case + strip an email address; None if it isn't a plausible address."""
    t = (target or "").strip().lower()
    return t if _EMAIL_RE.match(t) else None


def normalise_username(target: str) -> str | None:
    """Lower-case + strip a bare handle; None if it isn't a plausible username.

    Rejects anything with a dot (that's a domain) or an @ (that's an email) so
    ``classify_target`` stays unambiguous.
    """
    t = (target or "").strip().lstrip("@").lower()
    return t if _USERNAME_RE.match(t) else None


def classify_target(target: str) -> tuple[str, str] | None:
    """Detect a target's kind. Returns (kind, canonical).

    Order matters: ip → email (contains a domain) → domain → username (the
    loosest). An email is tried before a domain because an address embeds one.
    """
    ip = normalise_ip(target)
    if ip is not None:
        return ("ip", ip)
    email = normalise_email(target)
    if email is not None:
        return ("email", email)
    dom = normalise_domain(target)
    if dom is not None:
        return ("domain", dom)
    user = normalise_username(target)
    if user is not None:
        return ("username", user)
    return None


async def fetch_json(
    url: str,
    ttl: float,
    *,
    headers: dict[str, str] | None = None,
    browser_ua: bool = False,
) -> Any:
    """Cached, bounded GET returning parsed JSON — or None on any failure.

    Connectors degrade gracefully: a dead/flaky upstream (crt.sh and OTX both
    404/timeout from datacenter egress) yields None, which the connector turns
    into an empty result + a ``note`` rather than a 502. Cache key is the URL.
    """
    async def loader() -> Any:
        hdrs = dict(headers or {})
        if browser_ua:
            hdrs["User-Agent"] = _UA
        async with _SEMAPHORE:
            try:
                # follow_redirects: rdap.org is a bootstrap that 302s to the
                # authoritative registry RDAP server. Hosts are fixed trusted
                # providers (not user-supplied), so redirect-SSRF doesn't apply.
                r = await get_client().get(
                    url, headers=hdrs or None, follow_redirects=True
                )
            except Exception:  # noqa: BLE001 — network error → degrade
                return None
        if r.status_code != 200:
            return None
        try:
            return r.json()
        except Exception:  # noqa: BLE001 — non-JSON body (e.g. rate-limit text)
            return None

    return await cache.get_or_fetch(url, ttl, loader)
