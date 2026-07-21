"""Deterministic-first brief assembly over a Velocity News edition (Track A3).

:func:`build_brief` picks the top story of each category straight from an
already-built edition dict (:func:`app.news.analyze.analyze_edition`'s
output) — no LLM required for the structure, same "the wall must be full even
when the model is throttled" principle the edition builder itself follows.
On top of that deterministic skeleton it makes ONE best-effort LLM call for a
short synthesis paragraph; a model failure never blocks the brief, it just
leaves ``synthesis`` empty and records why in ``synthesis_error``.
"""

from __future__ import annotations

import datetime as _dt
import json
from typing import Any

from app import llm
from app.news.analyze import _INJECTION_GUARD, _fence

_SYNTHESIS_SYSTEM = """\
You are a rigorous, non-partisan news desk editor writing a short morning \
brief. You are given a JSON list of the day's lead stories (title, category, \
and a short summary for each). Write ONE short paragraph (3-5 sentences) that \
ties the leads together for a reader who has not seen the news yet. Reason \
ONLY over the provided titles and summaries, never invent facts, sources, \
quotes, or numbers. Output plain prose, no markdown, no headings, no bullet \
points, no JSON."""


def _now_iso() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def _top_story_per_category(edition: dict[str, Any]) -> list[dict[str, Any]]:
    """One entry per category, in the edition's own story order (first hit
    per category wins, mirroring the wall's own corroboration-led sort)."""
    stories = edition.get("stories") or []
    categories = edition.get("categories") or []
    picked: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for story in stories:
        category = story.get("category")
        if not category or category in picked:
            continue
        picked[category] = story
        order.append(category)
    # Prefer the edition's declared category order where a pick exists, then
    # append any picked category the edition didn't declare (never invented,
    # just not dropped).
    ordered_categories = [c for c in categories if c in picked] + [
        c for c in order if c not in categories
    ]
    out: list[dict[str, Any]] = []
    for category in ordered_categories:
        out.append(_entry_for(picked[category]))
    return out


def _entry_for(story: dict[str, Any]) -> dict[str, Any]:
    """Build one top-story entry, passing through fields that exist on the
    source story and never inventing ones that don't."""
    link = story.get("link")
    if link is None:
        proofs = story.get("proofs") or []
        if proofs and isinstance(proofs[0], dict):
            link = proofs[0].get("url")

    entry: dict[str, Any] = {
        "title": story.get("title"),
        "link": link,
        "category": story.get("category"),
    }
    for key in (
        "attributed_claims",
        "verified_facts",
        "rhetoric_flags",
        "propaganda_techniques",
        "whats_wrong",
    ):
        if key in story:
            entry[key] = story[key]
    if "corroboration" in story:
        entry["corroboration"] = story["corroboration"]
    if "confidence" in story:
        entry["confidence"] = story["confidence"]
    return entry


async def _synthesize(top: list[dict[str, Any]]) -> tuple[str, str]:
    """Best-effort synthesis paragraph. Returns ``(synthesis, error)`` — at
    most one of the two is non-empty."""
    if not top:
        return "", ""
    headlines = [
        {
            "title": t.get("title"),
            "category": t.get("category"),
        }
        for t in top
    ]
    system = llm.with_prose_style(_SYNTHESIS_SYSTEM) + _INJECTION_GUARD
    user = _fence(json.dumps(headlines, ensure_ascii=False))
    result = await llm.complete(system, user, tier="fast")
    if not result.ok or not result.text:
        return "", (result.error or "model unavailable")
    return result.text.strip(), ""


async def build_brief(edition: dict[str, Any]) -> dict[str, Any]:
    """Assemble a short brief from an already-built edition dict.

    Deterministic top-story-per-category assembly always runs; the LLM
    synthesis paragraph is best-effort on top and never blocks the result.
    """
    categories = list(edition.get("categories") or [])
    top = _top_story_per_category(edition)
    synthesis, synthesis_error = await _synthesize(top)

    freshness = {
        "articles_age_s": edition.get("articles_age_s"),
        "feeds_fetched": edition.get("feeds_fetched"),
        "feeds_total": edition.get("feeds_total"),
        "verified_count": edition.get("verified_count"),
    }

    return {
        "generated_utc": _now_iso(),
        "categories": categories,
        "top": top,
        "synthesis": synthesis,
        "synthesis_error": synthesis_error,
        "freshness": freshness,
    }
