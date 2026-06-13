"""Process-local cache for the news engine.

Holds the latest fetched articles and the latest analysis dict, each with a
monotonic timestamp of when it was produced. Single-writer (the background
refresher in :mod:`app.routes.news`) so no locking is needed.
"""

from __future__ import annotations

import time
from typing import Any

from app.news.sources import Article

# ── articles ────────────────────────────────────────────────────────────────

_articles: list[Article] = []
_articles_ts: float = 0.0

# ── analysis ────────────────────────────────────────────────────────────────

_analysis: dict[str, Any] | None = None
_analysis_ts: float = 0.0


def set_articles(articles: list[Article]) -> None:
    global _articles, _articles_ts
    _articles = list(articles)
    _articles_ts = time.monotonic()


def get_articles() -> list[Article]:
    return _articles


def articles_age_s() -> float | None:
    """Seconds since articles were last set, or ``None`` if never set."""
    if _articles_ts == 0.0:
        return None
    return time.monotonic() - _articles_ts


def has_articles() -> bool:
    return _articles_ts > 0.0 and bool(_articles)


def set_analysis(analysis: dict[str, Any]) -> None:
    global _analysis, _analysis_ts
    _analysis = analysis
    _analysis_ts = time.monotonic()


def get_analysis() -> dict[str, Any] | None:
    return _analysis


def analysis_age_s() -> float | None:
    """Seconds since analysis was last set, or ``None`` if never set."""
    if _analysis_ts == 0.0:
        return None
    return time.monotonic() - _analysis_ts


def is_analysis_stale(max_age_s: float) -> bool:
    """True when there is no analysis yet, or it is older than ``max_age_s``."""
    age = analysis_age_s()
    return age is None or age > max_age_s


def reset() -> None:
    """Clear all cached state — used by tests for isolation."""
    global _articles, _articles_ts, _analysis, _analysis_ts
    _articles = []
    _articles_ts = 0.0
    _analysis = None
    _analysis_ts = 0.0
