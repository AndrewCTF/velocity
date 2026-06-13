"""Unit tests for the news debias / fact-check engine — NO network.

Upstream RSS is exercised via canned bytes through ``parse_feed_bytes``; the
LLM is monkeypatched at ``llm.chat_json``. The route layer is tested through
FastAPI's TestClient with both feed fetch and the LLM stubbed.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import llm
from app.news import analyze as news_analyze
from app.news import sources as news_sources
from app.news import store
from app.news.sources import Article, Source, parse_feed_bytes, strip_html

# A minimal but realistic RSS document with HTML in the summary + entities.
_CANNED_RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test World</title>
    <item>
      <title>Leader says the war will end soon</title>
      <link>https://example.com/a</link>
      <description><![CDATA[<p>The leader <b>promised</b> peace &amp; calm.</p>]]></description>
      <pubDate>Tue, 10 Jun 2025 09:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Markets rally after summit</title>
      <link>https://example.com/b</link>
      <description>Stocks &lt;up&gt; sharply today.</description>
      <pubDate>Tue, 10 Jun 2025 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>"""

_SRC = Source("Test World", "https://example.com/rss", "center", "global")


@pytest.fixture(autouse=True)
def _reset_store() -> None:
    store.reset()


# ── parsing / normalization ─────────────────────────────────────────────────


def test_strip_html_removes_tags_and_entities() -> None:
    assert strip_html("<p>hello <b>world</b></p>") == "hello world"
    assert strip_html("a &amp; b &lt;c&gt;") == "a & b <c>"
    assert strip_html(None) == ""
    assert strip_html("   spaced   out  ") == "spaced out"


def test_parse_feed_bytes_normalizes_entries() -> None:
    arts = parse_feed_bytes(_CANNED_RSS, _SRC)
    assert len(arts) == 2
    first = arts[0]
    assert first.title == "Leader says the war will end soon"
    # HTML tags stripped from the summary, entities decoded.
    assert "<" not in first.summary and ">" not in first.summary
    assert "promised peace & calm" in first.summary
    assert first.source == "Test World"
    assert first.leaning == "center"
    assert first.link == "https://example.com/a"
    assert first.published_iso == "2025-06-10T09:00:00Z"


def test_parse_feed_bytes_tolerates_garbage() -> None:
    # Malformed feed must not raise — feedparser yields no usable entries.
    assert parse_feed_bytes(b"not xml at all <<<", _SRC) == []


def test_cluster_titles_groups_shared_tokens() -> None:
    arts = [
        Article("Ceasefire talks resume in capital", "", "l1", "A", "center", None),
        Article("Capital ceasefire talks collapse again", "", "l2", "B", "right", None),
        Article("Tech stocks surge on earnings", "", "l3", "C", "center", None),
    ]
    clusters = news_analyze.cluster_titles(arts, max_clusters=8)
    # The two ceasefire-talks headlines share >=2 significant tokens → one cluster.
    biggest = max(clusters, key=len)
    assert len(biggest) == 2
    assert {a.source for a in biggest} == {"A", "B"}


# ── analyze() degraded + happy paths ────────────────────────────────────────


def _arts() -> list[Article]:
    return parse_feed_bytes(_CANNED_RSS, _SRC)


async def test_analyze_degrades_on_llm_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fail(*_a: Any, **_k: Any) -> tuple[Any, llm.LlmResult]:
        return None, llm.LlmResult(text=None, error="x")

    monkeypatch.setattr(llm, "chat_json", _fail)
    out = await news_analyze.analyze(_arts())
    assert out["events"] == []
    assert out["method"] == "llm unavailable"
    assert out["error"] == "x"


async def test_analyze_empty_articles_short_circuits(monkeypatch: pytest.MonkeyPatch) -> None:
    called = {"n": 0}

    async def _spy(*_a: Any, **_k: Any) -> tuple[Any, llm.LlmResult]:
        called["n"] += 1
        return {}, llm.LlmResult(text="{}")

    monkeypatch.setattr(llm, "chat_json", _spy)
    out = await news_analyze.analyze([])
    assert out["events"] == []
    assert out["method"] == "no articles"
    assert called["n"] == 0  # never hits the model with nothing to analyze


async def test_analyze_parses_good_json(monkeypatch: pytest.MonkeyPatch) -> None:
    good: dict[str, Any] = {
        "generated": "2025-06-10T11:00:00Z",
        "events": [
            {
                "title": "Conflict diplomacy",
                "neutral_summary": "Officials made statements about ending the war.",
                "corroboration": {"source_count": 2, "sources": ["Reuters", "AP"]},
                "verified_facts": ["A summit took place."],
                "attributed_claims": [
                    {"who": "Leader", "claim": "the war will end soon", "status": "unverified"}
                ],
                "bias_flags": [
                    {"source": "Fox World", "technique": "loaded language", "evidence": "..."}
                ],
                "propaganda_techniques": ["appeal to fear"],
                "rhetoric_flags": [
                    {"who": "Leader", "claim": "war will end soon",
                     "note": "repeated promise, not a fact"}
                ],
                "confidence": 0.6,
            }
        ],
        "method": "cross-source",
    }

    async def _ok(*_a: Any, **_k: Any) -> tuple[Any, llm.LlmResult]:
        return good, llm.LlmResult(text="{...}", backend="deepseek")

    monkeypatch.setattr(llm, "chat_json", _ok)
    out = await news_analyze.analyze(_arts())
    assert len(out["events"]) == 1
    ev = out["events"][0]
    assert ev["verified_facts"] == ["A summit took place."]
    assert ev["rhetoric_flags"][0]["note"] == "repeated promise, not a fact"
    # The promise is an attributed claim / rhetoric — never a verified fact.
    assert "the war will end soon" not in ev["verified_facts"]
    assert out["article_count"] == 2
    assert out["source_count"] == 1


async def test_analyze_coerces_bad_events_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _weird(*_a: Any, **_k: Any) -> tuple[Any, llm.LlmResult]:
        return {"events": "oops not a list"}, llm.LlmResult(text="{...}")

    monkeypatch.setattr(llm, "chat_json", _weird)
    out = await news_analyze.analyze(_arts())
    assert out["events"] == []  # coerced to a list
    assert "generated" in out


# ── factcheck() ──────────────────────────────────────────────────────────────


async def test_factcheck_shape_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    verdict = {
        "claim": "the war will end soon",
        "verdict": "unverified",
        "reasoning": "A promise by an official is not corroborated fact.",
        "supporting_sources": ["Reuters"],
        "confidence": 0.7,
    }

    async def _ok(*_a: Any, **_k: Any) -> tuple[Any, llm.LlmResult]:
        return verdict, llm.LlmResult(text="{...}")

    monkeypatch.setattr(llm, "chat_json", _ok)
    out = await news_analyze.factcheck("the war will end soon", ["Leader says war will end"])
    assert out["verdict"] == "unverified"
    assert out["supporting_sources"] == ["Reuters"]
    assert out["confidence"] == 0.7


async def test_factcheck_degrades_on_llm_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fail(*_a: Any, **_k: Any) -> tuple[Any, llm.LlmResult]:
        return None, llm.LlmResult(text=None, error="boom")

    monkeypatch.setattr(llm, "chat_json", _fail)
    out = await news_analyze.factcheck("some claim")
    assert out["verdict"] == "unverified"
    assert out["reasoning"] == "llm unavailable"
    assert out["error"] == "boom"


async def test_factcheck_normalizes_bad_verdict(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _bad(*_a: Any, **_k: Any) -> tuple[Any, llm.LlmResult]:
        return {"verdict": "definitely-true", "confidence": "high"}, llm.LlmResult(text="{...}")

    monkeypatch.setattr(llm, "chat_json", _bad)
    out = await news_analyze.factcheck("x")
    assert out["verdict"] == "unverified"  # unknown verdict coerced
    assert out["confidence"] == 0.0  # non-numeric coerced
    assert out["supporting_sources"] == []


async def test_factcheck_empty_claim() -> None:
    out = await news_analyze.factcheck("   ")
    assert out["verdict"] == "unverified"
    assert out["reasoning"] == "empty claim"


# ── routes ───────────────────────────────────────────────────────────────────


def _build_client() -> TestClient:
    # The news router is wired into app.main by the orchestrator (an
    # include_router line we must not add ourselves). To keep these route
    # tests self-contained and independent of that wiring, mount the router on
    # a bare FastAPI app — no lifespan, no background loops, no network.
    from fastapi import FastAPI

    from app.routes import news as news_route

    app = FastAPI()
    app.include_router(news_route.router)
    return TestClient(app)


def test_feed_route_returns_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_fetch(*_a: Any, **_k: Any) -> list[Article]:
        return _arts()

    monkeypatch.setattr(news_sources, "fetch_all", _fake_fetch)
    with _build_client() as client:
        r = client.get("/api/news/feed")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    assert body["articles"][0]["source"] == "Test World"


def test_factcheck_route(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _ok(*_a: Any, **_k: Any) -> tuple[Any, llm.LlmResult]:
        return (
            {"claim": "c", "verdict": "misleading", "reasoning": "r",
             "supporting_sources": [], "confidence": 0.4},
            llm.LlmResult(text="{...}"),
        )

    monkeypatch.setattr(llm, "chat_json", _ok)
    with _build_client() as client:
        r = client.get("/api/news/factcheck", params={"claim": "is this true"})
    assert r.status_code == 200
    assert r.json()["verdict"] == "misleading"
