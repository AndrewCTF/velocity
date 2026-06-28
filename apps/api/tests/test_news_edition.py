import asyncio
import app.news.analyze as analyze
from app.news.analyze import analyze_edition, EDITION_CATEGORIES
from app.news.sources import Article


def _arts():
    return [
        Article("Iran and Israel trade strikes near Hormuz", "s1",
                "https://bbc.com/1", "BBC World", "center", "2026-06-28T10:00:00Z",
                image="https://img/1.jpg"),
        Article("IDF says Tehran targets hit overnight", "s2",
                "https://reuters.com/2", "Reuters", "wire", "2026-06-28T09:00:00Z"),
        Article("Markets fall as oil spikes on Gulf tension", "s3",
                "https://cnbc.com/3", "CNBC", "center", "2026-06-28T08:00:00Z"),
    ]


class _FakeRes:
    ok = True
    backend = "minimaxai/minimax-m3"
    error = None


async def _fake_chat_json(messages, **kw):
    sys = messages[0]["content"]
    if "Cluster" in sys or "cluster" in sys:
        return ({"events": [
            {"title": "Gulf strikes", "sources": ["BBC World", "Reuters"],
             "neutral_summary": "Strikes reported near Hormuz."},
            {"title": "Oil and markets", "sources": ["CNBC"],
             "neutral_summary": "Oil prices rose."},
        ]}, _FakeRes())
    # per-event edition refine
    return ({
        "title": "Gulf strikes",
        "category": "Conflict",
        "neutral_summary": "Strikes were reported near the Strait of Hormuz.",
        "neutral_rewrite": "Para one.\n\nPara two.",
        "recommended_actions": ["Verify casualty figures against ICRC."],
        "corroboration": {"source_count": 2, "sources": ["BBC World", "Reuters"]},
        "verified_facts": ["Explosions were reported in the area."],
        "attributed_claims": [],
        "bias_flags": [{"source": "BBC World", "technique": "name-calling",
                        "evidence": "the regime"}],
        "propaganda_techniques": ["name-calling"],
        "rhetoric_flags": [],
        "confidence": 0.8,
    }, _FakeRes())


async def _no_brief():
    return {}


def test_analyze_edition_shape(monkeypatch):
    monkeypatch.setattr(analyze.llm, "chat_json", _fake_chat_json)
    # Isolate from the live intel brief (network/snapshot) — Task 4 wired
    # attach_supporting_docs into the success path; the fixture story is Conflict.
    monkeypatch.setattr(analyze, "_incident_brief", _no_brief)
    ed = asyncio.run(analyze_edition(_arts()))
    assert ed["stories"], "expected stories"
    s = ed["stories"][0]
    assert s["category"] in EDITION_CATEGORIES
    assert s["neutral_rewrite"]
    assert isinstance(s["recommended_actions"], list)
    assert isinstance(s["whats_wrong"], list) and s["whats_wrong"][0]["quote"] == "the regime"
    assert any(p["url"] for p in s["proofs"]), "proofs carry article URLs"
    assert s["id"]
    assert ed["lead"] is not None
    assert ed["backend"] == "minimaxai/minimax-m3"


def test_analyze_edition_empty():
    ed = asyncio.run(analyze_edition([]))
    assert ed["stories"] == [] and ed["method"]
    # Empty path must still carry the full edition shape (route/frontend rely on it).
    for k in ("generated", "categories", "lead", "article_count", "source_count", "backend"):
        assert k in ed
