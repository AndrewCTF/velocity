"""Per-request commercial-source gating.

The Velocity gateway Worker stamps every proxied request with an
``X-Velocity-Tier`` header (``paid`` for an entitled customer, ``free``
otherwise). This module turns that — together with the deployment-level
``commercial_mode`` / ``allow_nc_for_free`` settings — into a single boolean:
"serve only commercial-legally-licensed sources for this request?"

Truth table (commercial == "must use the commercial-legal source set"):

    tier    commercial_mode  allow_nc_for_free  -> commercial
    paid    *                *                  -> True   (paying customer, always legal)
    free    True             False              -> True   (commercial deploy, no NC opt-in)
    free    True             True               -> False  (operator opted free users into NC)
    free    False            *                  -> False  (non-commercial deploy)
    absent  *                *                  -> commercial_mode (deployment default)

See docs/commercial-licensing.md for which sources each side maps to.
"""

from __future__ import annotations

from fastapi import Header

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


def commercial_request(x_velocity_tier: str | None = Header(default=None)) -> bool:
    """FastAPI dependency: True → serve only commercial-legal sources."""
    return resolve_commercial(x_velocity_tier)
