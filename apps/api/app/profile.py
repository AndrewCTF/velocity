"""Deployment profiles — what a fresh install actually runs.

The platform was built assuming it owns the machine. Measured on a 32-core /
121 GB / RTX 5090 box it still ran two headless Chromium tiers at 25 processes
and 4.4 GB, and pulled a 21 GB model into VRAM from a background loop, for a
default boot nobody had configured. On a 4-core / 8 GB / no-GPU box that is not
"slow", it is "does not start".

Three profiles, one env var:

    OSINT_PROFILE=lite          (default) — 4 cores / 8 GB / no GPU
    OSINT_PROFILE=workstation             — 8-16 cores / 32 GB
    OSINT_PROFILE=full                    — the previous behaviour, unchanged

A profile only ever supplies DEFAULTS. Anything set explicitly in the
environment or .env still wins, so an operator who has already tuned their box
is unaffected by the profile they land in.

What each profile turns off is a resource decision, never a correctness one:
every keyless data layer named in CLAUDE.md keeps working in `lite`. What goes
away is the browser scraper tier (aircraft breadth falls back to OpenSky, which
is the documented breadth source) and automatic model inference.
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

LITE = "lite"
WORKSTATION = "workstation"
FULL = "full"
_VALID = (LITE, WORKSTATION, FULL)

DEFAULT = LITE

# Per-profile environment defaults. Applied with setdefault semantics, so an
# explicit value in the environment or .env always wins.
_DEFAULTS: dict[str, dict[str, str]] = {
    LITE: {
        # The browser tier is the single largest cost on the box: 25 Chromium
        # processes, 4.4 GB RSS, and 113 % CPU even after the render fix. On an
        # edge box it is not affordable, and OpenSky is already the documented
        # breadth source, so aircraft coverage degrades rather than disappears.
        "ADSB_SIDECAR_ENABLED": "0",
        "AIS_MYSHIPTRACKING_SIDECAR_ENABLED": "0",
        "AIS_MARINETRAFFIC_SIDECAR_ENABLED": "0",
        "AIS_VESSELFINDER_SIDECAR_ENABLED": "0",
        # No automatic inference. A background loop that files briefs pulled a
        # 21 GB model into VRAM on a box whose own /api/ai/local said the
        # feature was disabled. Nothing here blocks a user ASKING for a brief —
        # it stops the machine deciding to on its own.
        "AI_BACKGROUND_ENABLED": "0",
        "NEWS_ENABLED": "0",
        # Release the card the moment an explicitly requested call finishes.
        "OLLAMA_KEEP_ALIVE": "0",
    },
    WORKSTATION: {
        "AIS_MYSHIPTRACKING_SIDECAR_ENABLED": "0",
        "AI_BACKGROUND_ENABLED": "0",
    },
    FULL: {},
}


def resolve() -> str:
    """The active profile name, defaulting to ``lite`` and never raising."""
    raw = (os.environ.get("OSINT_PROFILE") or "").strip().lower()
    if not raw:
        return DEFAULT
    if raw not in _VALID:
        log.warning(
            "OSINT_PROFILE=%r is not one of %s — using %r",
            raw, ", ".join(_VALID), DEFAULT,
        )
        return DEFAULT
    return raw


def _dotenv_keys() -> set[str]:
    """Keys the operator has already set in a ``.env`` this process will read.

    WHY THIS EXISTS: pydantic-settings ranks REAL ENVIRONMENT VARIABLES ABOVE
    ``.env`` (see ``Settings.model_config``). So seeding a profile default into
    ``os.environ`` does not lose to an ``.env`` entry — it silently OUTRANKS it,
    which is the exact opposite of this module's contract. Measured 2026-08-02:
    a box with ``ADSB_SIDECAR_ENABLED=1`` in ``.env`` still booted with the tier
    off, because `lite` had already put ``0`` in the environment. Treat a key
    present in either ``.env`` as set by the operator, and keep quiet about it.
    """
    keys: set[str] = set()
    # Same files, same order, as Settings.model_config.env_file.
    for name in (".env", "../../.env"):
        try:
            with open(name, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    keys.add(line.split("=", 1)[0].strip().upper())
        except OSError:  # absent / unreadable — nothing to honour
            continue
    return keys


def apply() -> str:
    """Seed this profile's defaults into ``os.environ`` and return its name.

    MUST run before the first ``get_settings()`` call, because pydantic-settings
    reads the environment once and the result is cached. ``main.py`` calls this
    at import time, ahead of the app and route imports, for the same reason the
    allocator setup lives there.

    ``setdefault`` is the whole contract: a profile expresses an opinion about
    an unconfigured box and has no opinion at all about a configured one — and
    ``.env`` counts as configured, which needs :func:`_dotenv_keys` to enforce.
    """
    name = resolve()
    configured = set(os.environ) | _dotenv_keys()
    seeded = []
    for key, value in _DEFAULTS[name].items():
        if key not in configured:
            os.environ[key] = value
            seeded.append(key)
    log.info(
        "profile: %s (%s)",
        name,
        f"seeded {', '.join(sorted(seeded))}" if seeded else "nothing to seed",
    )
    return name


def summary() -> dict[str, object]:
    """What the active profile decided, for ``/api/status`` and the docs."""
    name = resolve()
    return {
        "profile": name,
        "default": DEFAULT,
        "available": list(_VALID),
        "seeds": _DEFAULTS[name],
        # Which of this profile's opinions the operator has overridden.
        "overridden": sorted(
            k for k in _DEFAULTS[name] if os.environ.get(k) != _DEFAULTS[name][k]
        ),
    }
