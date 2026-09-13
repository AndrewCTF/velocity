"""Per-request commercial-source gating.

Turns the deployment-level ``commercial_mode`` / ``allow_nc_for_free`` settings
into a single boolean: "serve only commercial-legally-licensed sources for this
request?"

Until 2026-09-13 the Velocity gateway Worker stamped proxied requests with an
``X-Velocity-Tier`` header (``paid`` / ``free``) and this module believed it from
a ``TRUSTED_PROXIES`` peer. The gateway was deleted that day, and the shipped
nginx is itself a trusted peer that forwards client headers unchanged, so the
header had become client-controlled: ``X-Velocity-Tier: paid`` passed the 402
gate on ``POST /api/imagery/task`` (ASVS V4.1.3). No component sets it any more,
so the request dependency no longer reads it; the DEPLOYMENT decides.

Truth table of :func:`resolve_commercial` (commercial == "must use the
commercial-legal source set"). The ``tier`` argument is kept for a future
entitlement source that the server itself derives (never a request header):

    tier    commercial_mode  allow_nc_for_free  -> commercial
    paid    *                *                  -> True   (paying customer, always legal)
    free    True             False              -> True   (commercial deploy, no NC opt-in)
    free    True             True               -> False  (operator opted free users into NC)
    free    False            *                  -> False  (non-commercial deploy)
    absent  *                *                  -> commercial_mode (deployment default)

See docs/commercial-licensing.md for which sources each side maps to.
"""

from __future__ import annotations

from app.config import get_settings


def resolve_commercial(tier: str | None) -> bool:
    """Return True when this request must be served commercial-legal sources."""
    s = get_settings()
    t = (tier or "").strip().lower()
    if t == "paid":
        return True
    if t == "free":
        return s.commercial_mode and not s.allow_nc_for_free
    return s.commercial_mode


def commercial_request() -> bool:
    """FastAPI dependency: True → serve only commercial-legal sources.

    The deployment default, always. ``X-Velocity-Tier`` is ignored from every
    peer (see the module docstring), so a client cannot choose its own licensing
    tier; a keyless box keeps ``commercial_mode=False`` and its fuller sources.
    """
    return resolve_commercial(None)
