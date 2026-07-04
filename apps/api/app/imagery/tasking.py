"""On-demand satellite tasking adapters (ICEYE / Umbra / Planet) — B5.

This is the *interface* for commissioning a NEW collection (point a SAR or
optical satellite at an AOI and pay for the pass), as opposed to the keyless
ARCHIVE chips the rest of the imagery layer serves. Tasking is a paid,
contractual capability: every provider here requires a customer account and an
API token, and the actual orders cost money and take hours-to-days to deliver.

Honesty contract (CLAUDE.md): with NO paid credentials set this module never
fakes a tasking order, never claims a collection, and never 500s. It returns an
explicit ``degraded`` response that names exactly which credential is missing
and what the operator must wire to enable it. The route layer gates this behind
the EXISTING ``commercial_request`` dependency (paid tier only) on top.

No secrets are hardcoded. Credentials are read at call time from the deployment
``Settings`` via ``getattr`` (so a deploy that has not yet declared the fields
simply reports the capability unconfigured rather than importing-erroring):

    iceye_api_token   ICEYE_API_TOKEN    (ICEYE STAPI tasking)
    umbra_api_token   UMBRA_API_TOKEN    (Umbra Canopy STAPI tasking)
    planet_api_key    PLANET_API_KEY     (Planet Tasking API)

When/if the operator wires real creds, the ``_submit_*`` adapters are where the
provider STAPI / Tasking POST goes (each provider's order schema differs); they
are intentionally left as the single honest "not yet wired" path so a future
turn implements one provider at a time without touching the route or the gate.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.config import Settings, get_settings
from app.intel.geo import BBox

# Provider id -> (human label, settings attribute carrying the token, sensor).
# `sensor` is honest about what the bird collects so the operator never expects
# optical from a SAR tasking or vice-versa.
_PROVIDERS: dict[str, dict[str, str]] = {
    "iceye": {
        "label": "ICEYE",
        "cred_attr": "iceye_api_token",
        "cred_env": "ICEYE_API_TOKEN",
        "sensor": "SAR (X-band)",
        "docs": "https://www.iceye.com/ — STAPI tasking, customer account required",
    },
    "umbra": {
        "label": "Umbra",
        "cred_attr": "umbra_api_token",
        "cred_env": "UMBRA_API_TOKEN",
        "sensor": "SAR (X-band)",
        "docs": "https://docs.canopy.umbra.space/ — Canopy STAPI, customer account required",
    },
    "planet": {
        "label": "Planet",
        "cred_attr": "planet_api_key",
        "cred_env": "PLANET_API_KEY",
        "sensor": "Optical (SkySat ~0.5 m)",
        "docs": "https://developers.planet.com/docs/tasking/ — Tasking API, account required",
    },
}

PROVIDERS: tuple[str, ...] = tuple(_PROVIDERS)


@dataclass(frozen=True)
class TaskingProvider:
    """One tasking provider's static descriptor + live configured-state."""

    id: str
    label: str
    sensor: str
    cred_env: str
    docs: str
    configured: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "sensor": self.sensor,
            "configured": self.configured,
            # Surface the env var the operator must set, NEVER its value.
            "credential_env": self.cred_env,
            "docs": self.docs,
        }


def _token(settings: Settings, attr: str) -> str:
    """The provider token from Settings via getattr (empty when the deployment
    has not declared/!set the field). Never raises — a missing attr is just an
    unconfigured provider."""
    val = getattr(settings, attr, "")
    return val.strip() if isinstance(val, str) else ""


def provider(provider_id: str, settings: Settings | None = None) -> TaskingProvider:
    spec = _PROVIDERS[provider_id]
    s = settings or get_settings()
    return TaskingProvider(
        id=provider_id,
        label=spec["label"],
        sensor=spec["sensor"],
        cred_env=spec["cred_env"],
        docs=spec["docs"],
        configured=bool(_token(s, spec["cred_attr"])),
    )


def providers(settings: Settings | None = None) -> list[TaskingProvider]:
    s = settings or get_settings()
    return [provider(pid, s) for pid in PROVIDERS]


def any_configured(settings: Settings | None = None) -> bool:
    return any(p.configured for p in providers(settings))


def _degraded(prov: TaskingProvider, aoi: BBox, reason: str) -> dict[str, Any]:
    """The honest 'cannot task' response. ``status='degraded'`` (never an order
    id, never a fake 'submitted'), names the missing credential + what to wire."""
    return {
        "status": "degraded",
        "provider": prov.id,
        "label": prov.label,
        "sensor": prov.sensor,
        "configured": prov.configured,
        "aoi": aoi.as_dict(),
        "order_id": None,
        "reason": reason,
        # Concrete next step for the operator — no secret, just the env var name.
        "remediation": (
            f"Set {prov.cred_env} (a paid {prov.label} customer token) on the "
            f"backend to enable on-demand {prov.sensor} tasking."
        ),
        "docs": prov.docs,
    }


async def _submit_iceye(prov, aoi, window_hours, settings):  # noqa: ANN001, ARG001
    # Real ICEYE STAPI order goes here once a customer token is wired. Until
    # then this path is never reached (configured=False short-circuits in
    # submit_task), so we keep the single honest degraded source of truth.
    return _degraded(prov, aoi, "ICEYE tasking adapter not yet wired")


async def _submit_umbra(prov, aoi, window_hours, settings):  # noqa: ANN001, ARG001
    return _degraded(prov, aoi, "Umbra Canopy tasking adapter not yet wired")


async def _submit_planet(prov, aoi, window_hours, settings):  # noqa: ANN001, ARG001
    return _degraded(prov, aoi, "Planet tasking adapter not yet wired")


_SUBMIT = {
    "iceye": _submit_iceye,
    "umbra": _submit_umbra,
    "planet": _submit_planet,
}


async def submit_task(
    provider_id: str,
    aoi: BBox,
    *,
    window_hours: int = 72,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Attempt to commission a new collection over *aoi*.

    With no credential for *provider_id* this returns a ``degraded`` dict (no
    network, no fake order) explaining exactly what to wire. With a credential
    set it would dispatch to the provider's STAPI/Tasking adapter (left as the
    honest 'not yet wired' degraded path so a future turn implements one
    provider at a time). Never raises for an unconfigured provider; raises
    ``KeyError`` only for an unknown provider id (the route validates first)."""
    s = settings or get_settings()
    prov = provider(provider_id, s)  # KeyError on unknown id (route validates)
    if not prov.configured:
        return _degraded(
            prov, aoi, f"{prov.cred_env} is not set (no paid {prov.label} account)"
        )
    return await _SUBMIT[provider_id](prov, aoi, window_hours, s)
