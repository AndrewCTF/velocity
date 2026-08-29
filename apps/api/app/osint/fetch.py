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
import hashlib
import ipaddress
import json
import re
from typing import Any
from urllib.parse import urlsplit

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


# 32/40/64 lowercase-or-mixed hex → md5/sha1/sha256. Length alone disambiguates
# the algorithm; we don't need to know which one the caller means.
_HASH_RE = re.compile(r"^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$")

# BTC base58 (P2PKH/P2SH: starts 1 or 3, 26-35 chars total) or bech32 (bc1…).
# base58 excludes 0/O/I/l so it stays case-sensitive (canonical form keeps case);
# bech32 is conventionally lowercase.
_BTC_BASE58_RE = re.compile(r"^[13][A-HJ-NP-Za-km-z1-9]{25,34}$")
_BTC_BECH32_RE = re.compile(r"^bc1[ac-hj-np-z02-9]{6,87}$", re.IGNORECASE)
_ETH_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

# Optional "AS" prefix (case-insensitive) + digits. Real ASNs top out at the
# 32-bit ceiling (4294967295 / 10 digits) — anything longer is noise, not an ASN.
_ASN_RE = re.compile(r"^(?:as)?(\d+)$", re.IGNORECASE)
_ASN_MAX = 4_294_967_295

# A phone target is punctuation + digits and NOTHING else, which is what keeps
# it from eating a url or a hostname that merely contains digits.
_PHONE_RE = re.compile(r"^\+?[0-9(][0-9 ()\-.]{5,20}$")

# Decimal degrees: "38.8977,-77.0365" / "38.8977 -77.0365" / "38.8977, -77.0365".
_DD_RE = re.compile(
    r"^\s*([+-]?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*([+-]?\d{1,3}(?:\.\d+)?)\s*$"
)
# Degrees/minutes/seconds, the form ch. 27 spends the most time on:
# 41°53'23.2"N 12°29'32.2"E. Minutes and seconds are optional so 41°N 12°E works.
_DMS_ONE = (
    r"(\d{1,3})\s*[°d:\s]\s*(?:(\d{1,2})\s*['m:\s]\s*)?"
    r"(?:(\d{1,2}(?:\.\d+)?)\s*(?:\"|''|s)?\s*)?\s*([NSEWnsew])"
)
_DMS_RE = re.compile(rf"^\s*{_DMS_ONE}\s*[, ]\s*{_DMS_ONE}\s*$")


def normalise_url(target: str) -> str | None:
    """Canonicalise a URL; None unless it carries a scheme OR a path/query.

    A bare domain (``example.com``) must NOT classify as a url — that stays a
    ``domain`` target — so we require either an explicit ``http``/``https``
    scheme, or (schemeless) a ``/`` or ``?`` proving the caller meant more than
    a hostname. Host is lower-cased; path/query keep their original case. The
    host itself must be a real domain or IP (reuses ``normalise_domain`` /
    ``normalise_ip``) — a hostless-looking string like ``http://evil/../``
    isn't a url target, it's noise.
    """
    t = (target or "").strip()
    if not t or len(t) > 2048:
        return None
    m = re.match(r"^([a-zA-Z][a-zA-Z0-9+.\-]*):", t)
    if m:
        scheme = m.group(1).lower()
        if scheme not in ("http", "https"):
            return None
        rest = t
    else:
        if "/" not in t and "?" not in t:
            return None
        scheme = "http"
        rest = f"http://{t}"
    parsed = urlsplit(rest)
    raw_host = parsed.hostname
    if not raw_host:
        return None
    host = normalise_domain(raw_host) or normalise_ip(raw_host)
    if host is None:
        return None
    port = f":{parsed.port}" if parsed.port else ""
    canonical = f"{scheme}://{host}{port}{parsed.path}"
    if parsed.query:
        canonical += f"?{parsed.query}"
    return canonical if len(canonical) <= 2048 else None


def normalise_hash(target: str) -> str | None:
    """Lower-case a bare md5/sha1/sha256 hex digest; None otherwise."""
    t = (target or "").strip().lower()
    return t if _HASH_RE.match(t) else None


def normalise_wallet(target: str) -> str | None:
    """Return a canonical ``"<chain>:<address>"`` wallet id, else None.

    BTC: base58 (``1``/``3`` prefix, 26-35 chars) or bech32 (``bc1…``). ETH:
    ``0x`` + exactly 40 hex chars. Case is preserved for base58 (it's
    case-sensitive); lower-cased for bech32 and ETH hex.
    """
    t = (target or "").strip()
    if _ETH_RE.match(t):
        return f"eth:{t.lower()}"
    if _BTC_BECH32_RE.match(t):
        return f"btc:{t.lower()}"
    if _BTC_BASE58_RE.match(t):
        return f"btc:{t}"
    return None


def normalise_asn(target: str) -> str | None:
    """Parse ``AS15169`` / ``as15169`` / ``15169`` → ``"AS15169"``; else None."""
    t = (target or "").strip()
    m = _ASN_RE.match(t)
    if not m:
        return None
    n = int(m.group(1))
    if n == 0 or n > _ASN_MAX:
        return None
    return f"AS{n}"


def normalise_phone(target: str) -> str | None:
    """Canonicalise a telephone number to digits (``+`` kept for international).

    Accepted shapes, and only these:

      * a leading ``+`` with 8-15 digits — an explicit international number;
      * separator punctuation plus 7-15 digits — ``618-462-0000``, ``(618) 462
        0000``. The punctuation is the caller SAYING "this is a number";
      * a bare 10 or 11 digits — NANP length, the one unpunctuated form common
        enough to be worth claiming.

    A bare 5-9 or 12-15 digit run stays ambiguous and is NOT a phone, which is
    what leaves ``15169`` to ``normalise_asn``. The one collision this does
    accept is a bare 10-digit 32-bit ASN: ``4200000000`` classifies as a phone.
    That is deliberate — every source this platform reads writes an ASN with
    its ``AS`` prefix, and ``normalise_asn`` still takes ``AS4200000000``.
    """
    t = (target or "").strip()
    if not _PHONE_RE.match(t):
        return None
    plus = t.startswith("+")
    digits = re.sub(r"\D", "", t)
    n = len(digits)
    if plus:
        return f"+{digits}" if 8 <= n <= 15 else None
    if re.search(r"[ ()\-.]", t):
        return digits if 7 <= n <= 15 else None
    return digits if n in (10, 11) else None

def _dms_to_dd(deg: str, minutes: str | None, seconds: str | None, hemi: str) -> float:
    v = float(deg) + float(minutes or 0) / 60.0 + float(seconds or 0) / 3600.0
    return -v if hemi.upper() in ("S", "W") else v


def normalise_coordinate(target: str) -> str | None:
    """Canonicalise a lat/lon pair to ``"<lat>,<lon>"`` at 6 decimals, else None.

    Two input forms, both from ch. 27: decimal degrees, and the degrees/minutes/
    seconds form that map sites and image EXIF hand you. A DMS pair may be given
    in either order (``12°E 41°N`` is the same point as ``41°N 12°E``) because
    half the sources write longitude first; decimal degrees is always lat,lon,
    which is the convention every mapping url in the catalog uses.

    Six decimals is ~11 cm — past the precision of anything this platform
    ingests, and short enough that the same point always renders the same url.
    """
    t = (target or "").strip()
    if not t:
        return None

    m = _DMS_RE.match(t)
    if m:
        a = _dms_to_dd(m.group(1), m.group(2), m.group(3), m.group(4))
        b = _dms_to_dd(m.group(5), m.group(6), m.group(7), m.group(8))
        lat, lon = (a, b) if m.group(4).upper() in ("N", "S") else (b, a)
    else:
        m = _DD_RE.match(t)
        if not m:
            return None
        # A bare "38.9,-77.0" is only a coordinate if both halves are in range;
        # otherwise it is some other pair of numbers and not ours to claim.
        lat, lon = float(m.group(1)), float(m.group(2))

    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        return None
    return f"{lat:.6f},{lon:.6f}".replace(".000000", ".0")

def classify_target(target: str) -> tuple[str, str] | None:
    """Detect a target's kind. Returns (kind, canonical).

    Order (specific → loose): ip → email (contains a domain) → wallet →
    coordinate → phone → asn → file (hash) → url → domain → username. Wallet/asn/hash have a
    distinctive enough shape to go before url/domain (a bech32 address is all
    lower-alnum and would otherwise be eaten by username); url needs a scheme or
    a path/query so it can't eat a bare domain; username stays the loosest.
    Phone goes before asn on purpose: a bare 10-digit run matches ``_ASN_RE``
    too, and ``normalise_phone`` documents which way that collision falls.
    Coordinate goes before phone for the same reason: ``38.8977 -77.0365`` is
    digits, dots, a space and a hyphen, which is exactly the phone shape.
    """
    ip = normalise_ip(target)
    if ip is not None:
        return ("ip", ip)
    email = normalise_email(target)
    if email is not None:
        return ("email", email)
    wallet = normalise_wallet(target)
    if wallet is not None:
        return ("wallet", wallet)
    coord = normalise_coordinate(target)
    if coord is not None:
        return ("coordinate", coord)
    phone = normalise_phone(target)
    if phone is not None:
        return ("phone", phone)
    asn = normalise_asn(target)
    if asn is not None:
        return ("asn", asn)
    file_hash = normalise_hash(target)
    if file_hash is not None:
        return ("file", file_hash)
    url = normalise_url(target)
    if url is not None:
        return ("url", url)
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


def _body_digest(data: Any, json_body: Any) -> str:
    """Stable short hash of a POST body, for cache-key purposes only."""
    payload = json.dumps({"data": data, "json": json_body}, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


async def fetch_json_post(
    url: str,
    ttl: float,
    *,
    data: dict[str, Any] | None = None,
    json_body: Any | None = None,
    headers: dict[str, str] | None = None,
    browser_ua: bool = False,
) -> Any:
    """Cached, bounded POST returning parsed JSON — or None on any failure.

    Mirrors ``fetch_json`` (same semaphore, same cache, same degrade-to-None
    on any failure / non-200 / non-JSON body) but issues a POST — several
    threat-intel feeds (abuse.ch's urlhaus/malwarebazaar/yaraify) are
    POST-only. Pass ``data`` for a form-encoded body, ``json_body`` for a JSON
    body — never both. The cache key folds in a stable hash of the body (not
    just the URL) so different POST bodies against the same endpoint don't
    collide in the shared TTL cache.
    """
    cache_key = f"{url}#{_body_digest(data, json_body)}"

    async def loader() -> Any:
        hdrs = dict(headers or {})
        if browser_ua:
            hdrs["User-Agent"] = _UA
        async with _SEMAPHORE:
            try:
                r = await get_client().post(
                    url,
                    data=data,
                    json=json_body,
                    headers=hdrs or None,
                    follow_redirects=True,
                )
            except Exception:  # noqa: BLE001 — network error → degrade
                return None
        if r.status_code != 200:
            return None
        try:
            return r.json()
        except Exception:  # noqa: BLE001 — non-JSON body (e.g. rate-limit text)
            return None

    return await cache.get_or_fetch(cache_key, ttl, loader)
