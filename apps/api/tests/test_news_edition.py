# apps/api/tests/test_news_edition.py
import asyncio

import app.news.analyze as analyze
from app.news.analyze import EDITION_CATEGORIES, analyze_edition
from app.news.sources import Article


def _arts():
    return [
        Article("Iran and Israel trade strikes near Hormuz", "Strikes reported.",
                "https://bbc.com/1", "BBC World", "center", "2026-06-28T10:00:00Z",
                image="https://img/1.jpg"),
        Article("IDF says Tehran targets hit overnight", "IDF statement.",
                "https://reuters.com/2", "Reuters", "wire", "2026-06-28T09:00:00Z"),
        Article("Markets fall as oil spikes on Gulf tension", "Oil rose.",
                "https://cnbc.com/3", "CNBC", "center", "2026-06-28T08:00:00Z"),
        Article("New AI chip from Nvidia speeds training", "Chip news.",
                "https://theverge.com/4", "Verge", "center", "2026-06-28T07:00:00Z"),
    ]


class _FakeRes:
    ok = True
    backend = "minimaxai/minimax-m3"
    error = None


async def _fake_batch(messages, **kw):
    """Stand in for the batched edition enrichment call."""
    sys = messages[0]["content"]
    assert "ONE PASS" in sys or "idx" in sys, "edition must use the batch prompt"
    # Echo an enrichment for idx 0..5 (the batch size).
    return ({"stories": [
        {
            "idx": i,
            "category": "Conflict",
            "neutral_rewrite": "Para one.\n\nPara two.",
            "recommended_actions": ["Cross-check casualty figures."],
            "verified_facts": ["Explosions were reported."],
            "attributed_claims": [],
            "bias_flags": [{"source": "BBC World", "technique": "name-calling",
                            "evidence": "the regime"}],
            "propaganda_techniques": ["name-calling"],
            "rhetoric_flags": [],
            "confidence": 0.8,
        }
        for i in range(6)
    ]}, _FakeRes())


async def _no_image(url, *a, **k):
    return ""


async def _no_brief():
    return {}


def test_edition_full_wall_and_enrichment(monkeypatch):
    monkeypatch.setattr(analyze.llm, "chat_json", _fake_batch)
    monkeypatch.setattr(analyze, "fetch_og_image", _no_image)
    monkeypatch.setattr(analyze, "_incident_brief", _no_brief)
    ed = asyncio.run(analyze_edition(_arts()))

    # Full wall: one story per cluster (4 distinct headlines -> 4 stories).
    assert len(ed["stories"]) >= 4, "wall must carry every clustered story"
    # Every story has a real category from the allowed set + proofs + an id.
    for s in ed["stories"]:
        assert s["category"] in EDITION_CATEGORIES
        assert s["id"]
        assert any(p["url"] for p in s["proofs"])
    # The lead (enriched) story carries depth from the batch.
    lead = ed["stories"][0]
    assert lead["neutral_rewrite"]
    assert lead["whats_wrong"][0]["quote"] == "the regime"
    assert lead["recommended_actions"]
    assert ed["lead"] is not None
    assert ed["backend"] == "minimaxai/minimax-m3"


def test_edition_wall_survives_llm_down(monkeypatch):
    """The core fix: a throttled/dead model thins DEPTH, never the story count."""
    async def _boom(*a, **k):
        raise RuntimeError("429 rate limited")
    monkeypatch.setattr(analyze.llm, "chat_json", _boom)
    monkeypatch.setattr(analyze, "fetch_og_image", _no_image)
    monkeypatch.setattr(analyze, "_incident_brief", _no_brief)
    ed = asyncio.run(analyze_edition(_arts()))

    assert len(ed["stories"]) >= 4, "wall must stand even with the LLM down"
    for s in ed["stories"]:
        assert s["category"] in EDITION_CATEGORIES
        assert s["title"] and any(p["url"] for p in s["proofs"])
    # No enrichment landed, but cards still render off the summary.
    assert all(s["neutral_rewrite"] == "" for s in ed["stories"])


def test_analyze_edition_empty():
    ed = asyncio.run(analyze_edition([]))
    assert ed["stories"] == [] and ed["method"]
    for k in ("generated", "categories", "lead", "article_count", "source_count", "backend"):
        assert k in ed


def test_classify_category():
    from app.news.analyze import _classify_category
    assert _classify_category("Israeli airstrike kills militants in Gaza") == "Conflict"
    assert _classify_category("Stocks rally as inflation cools, Fed holds rate") == "Economy"
    assert _classify_category("NASA telescope finds new exoplanet") == "Science"
    assert _classify_category("Local bakery wins regional award") == "World"
