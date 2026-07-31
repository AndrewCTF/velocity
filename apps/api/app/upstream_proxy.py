"""Rotating outbound proxy pool for the shared upstream client.

WHY: several upstreams gate on the CALLER'S IP, not on credentials —
airplanes.live and globe.theairtraffic.com answer a datacenter address with a
Cloudflare 403 (measured), adsb.lol rate-limits per source IP, and OpenSky's
anonymous credit budget is per IP. An operator who has their own egress
addresses can spread the load across them instead of burning one.

SCOPE, deliberately: this pool is whatever the operator configures in
`UPSTREAM_PROXIES` and nothing else. There is no discovery, no scraping of
public "free proxy" lists, no bundled defaults. Those lists are not a supply of
spare capacity — the residential entries are overwhelmingly consumer machines
enrolled by malware whose owners never agreed to carry traffic, and the rest
are interception points that would read every query this console makes. Both
are somebody else's problem to be handed, not ours to hand them. Point this at
addresses you own or pay for.

OFF unless configured: with `UPSTREAM_PROXIES` empty, `pool()` returns None and
`app.upstream` wires exactly the transport it always did.

Failure handling is the point of the rotation. A proxy that errors is put on a
cooldown (`UPSTREAM_PROXY_COOLDOWN_S`) rather than dropped for good, since the
usual cause is a transient upstream refusal; the next request skips it. When
every entry is cooling down the pool either fails the request or falls back to
a direct connection, per `UPSTREAM_PROXY_FALLBACK_DIRECT` — default FALSE,
because an operator running through a proxy generally means "do not send this
from my own address", and silently reverting to direct would leak the very
thing the proxy was for.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from itertools import count

import httpx

log = logging.getLogger(__name__)

# Loopback must never ride the pool: the ADS-B (:8090) and AIS (:8093) sidecars
# are same-host services, and routing them through an external hop would both
# break them and publish their traffic. app.upstream mounts these direct.
LOOPBACK_PATTERNS = (
    "all://localhost",
    "all://127.0.0.1",
    "all://[::1]",
    "all://127.0.0.0/8",
)


def parse_pool(raw: str) -> list[str]:
    """Split the configured list, keeping order and dropping blanks/dupes."""
    seen: set[str] = set()
    out: list[str] = []
    for item in raw.split(","):
        url = item.strip()
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(url)
    return out


class _Entry:
    __slots__ = ("url", "transport", "cooldown_until", "failures", "successes")

    def __init__(self, url: str, transport: httpx.AsyncBaseTransport) -> None:
        self.url = url
        self.transport = transport
        self.cooldown_until = 0.0
        self.failures = 0
        self.successes = 0

    def available(self, now: float) -> bool:
        return now >= self.cooldown_until


class RotatingProxyTransport(httpx.AsyncBaseTransport):
    """Round-robins requests over the configured proxies, with failover.

    Implemented as a transport rather than per-call plumbing so every existing
    `get_client().get(...)` call site is covered without being touched.
    """

    def __init__(
        self,
        entries: list[_Entry],
        *,
        direct: httpx.AsyncBaseTransport | None,
        cooldown_s: float,
        max_tries: int,
    ) -> None:
        if not entries:
            raise ValueError("RotatingProxyTransport needs at least one proxy")
        self._entries = entries
        self._direct = direct
        self._cooldown_s = cooldown_s
        self._max_tries = max(1, min(max_tries, len(entries)))
        self._counter = count()

    def _ordered(self, now: float) -> list[_Entry]:
        """Available entries, starting at the rotation cursor."""
        n = len(self._entries)
        start = next(self._counter) % n
        rotated = [self._entries[(start + i) % n] for i in range(n)]
        return [e for e in rotated if e.available(now)]

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        now = time.monotonic()
        candidates = self._ordered(now)
        last_exc: Exception | None = None

        for entry in candidates[: self._max_tries]:
            try:
                response = await entry.transport.handle_async_request(request)
            except Exception as exc:  # noqa: BLE001 — any transport error rotates
                last_exc = exc
                entry.failures += 1
                entry.cooldown_until = time.monotonic() + self._cooldown_s
                log.warning(
                    "upstream proxy %s failed (%s: %s), cooling down %.0fs",
                    entry.url,
                    type(exc).__name__,
                    exc,
                    self._cooldown_s,
                )
                continue
            entry.successes += 1
            return response

        if self._direct is not None:
            log.warning(
                "all %d upstream proxies unavailable — falling back to a direct "
                "connection for %s",
                len(self._entries),
                request.url.host,
            )
            return await self._direct.handle_async_request(request)

        # Fail closed. Raising the real error keeps the caller's existing
        # httpx-exception handling working instead of inventing a new type.
        if last_exc is not None:
            raise last_exc
        raise httpx.ConnectError(
            "every configured upstream proxy is cooling down", request=request
        )

    def stats(self) -> list[dict[str, object]]:
        """Per-proxy health, for /api/status surfaces. No credentials echoed."""
        now = time.monotonic()
        return [
            {
                "proxy": _redact(e.url),
                "available": e.available(now),
                "cooling_down_s": max(0.0, round(e.cooldown_until - now, 1)),
                "successes": e.successes,
                "failures": e.failures,
            }
            for e in self._entries
        ]

    async def aclose(self) -> None:
        for entry in self._entries:
            await entry.transport.aclose()
        if self._direct is not None:
            await self._direct.aclose()


def _redact(url: str) -> str:
    """Strip user:pass from a proxy URL so stats/logs never carry credentials."""
    try:
        parsed = httpx.URL(url)
    except Exception:  # noqa: BLE001 — never let redaction raise
        return "<unparseable>"
    if parsed.username or parsed.password:
        return str(parsed.copy_with(username="***", password="***"))
    return str(parsed)


def build(
    raw: str,
    transport_factory: Callable[[str | None], httpx.AsyncBaseTransport],
    *,
    cooldown_s: float,
    max_tries: int,
    fallback_direct: bool,
) -> RotatingProxyTransport | None:
    """Build the pool, or None when nothing is configured (the default)."""
    urls = parse_pool(raw)
    if not urls:
        return None
    entries = [_Entry(url, transport_factory(url)) for url in urls]
    log.info(
        "upstream proxy pool: %d configured (%s), fallback_direct=%s",
        len(entries),
        ", ".join(_redact(u) for u in urls),
        fallback_direct,
    )
    return RotatingProxyTransport(
        entries,
        direct=transport_factory(None) if fallback_direct else None,
        cooldown_s=cooldown_s,
        max_tries=max_tries,
    )
