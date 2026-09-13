"""The ONE non-public-address classifier behind every SSRF guard.

``workflows/control.py``, ``intel/evidence.py`` and ``news/images.py`` each keep
their own resolver (their tests patch different seams), but they all ask this
function whether an address may be reached. IPv4-in-IPv6 encodings (mapped,
6to4, Teredo) are unwrapped first because older CPython does not delegate a
mapped literal like ``::ffff:127.0.0.1`` to the ``is_*`` flags. CGNAT
(100.64.0.0/10) is listed explicitly: ``is_private`` never covers it.
"""

from __future__ import annotations

import ipaddress
import logging

_sec = logging.getLogger("app.security")


def log_refusal(where: str, host: str, reason: str) -> None:
    """One WARNING line per refused outbound fetch (ASVS V16.3.3). ``host`` only,
    never the full URL: a sink URL is itself a credential (Discord webhooks)."""
    _sec.warning("ssrf refused where=%s host=%s reason=%s", where, host, reason[:160])


_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def is_non_public_ip(ip: str) -> bool:
    """True for loopback / private / link-local / reserved / multicast /
    unspecified / CGNAT, in either family. Unparseable → True (unsafe)."""
    try:
        addr: ipaddress.IPv4Address | ipaddress.IPv6Address = ipaddress.ip_address(ip)
    except ValueError:
        return True
    if isinstance(addr, ipaddress.IPv6Address):
        embedded = addr.ipv4_mapped or addr.sixtofour
        if embedded is None and addr.teredo is not None:
            embedded = addr.teredo[1]
        if embedded is not None:
            addr = embedded
    return bool(
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
        or (addr.version == 4 and addr in _CGNAT)
    )
