"""Process-global local-engine override — mirrors ``app.llm``'s
``prefer_local`` idiom (module-global, ``None`` defers to Settings). Right for
the single-operator/desktop case this exists for, same as the LLM ladder.
"""

from __future__ import annotations

from app.config import get_settings

_engine_override: str | None = None


def set_engine(engine: str | None) -> None:
    """Set the runtime engine override. ``None`` clears it (back to Settings)."""
    global _engine_override
    _engine_override = engine


def get_engine() -> str:
    if _engine_override is not None:
        return _engine_override
    return get_settings().llm_local_engine
