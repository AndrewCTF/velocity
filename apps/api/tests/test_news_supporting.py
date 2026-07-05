# apps/api/tests/test_news_supporting.py
import asyncio

import app.news.analyze as analyze
from app.news.analyze import attach_supporting_docs


def test_attach_supporting_docs(monkeypatch):
    async def fake_brief(*a, **k):
        return {"incidents": [
            {"id": "inc1", "threat_level": "elevated", "narrative": "Vessel + jamming.",
             "domains": ["dark-vessel"], "centroid": {"lon": 56.3, "lat": 26.6}},
        ]}
    monkeypatch.setattr(analyze, "_incident_brief", fake_brief, raising=False)
    stories = [
        {"id": "a", "category": "Conflict", "title": "Gulf", "supporting_docs": []},
        {"id": "b", "category": "Tech", "title": "Chips", "supporting_docs": []},
    ]
    asyncio.run(attach_supporting_docs(stories))
    docs = stories[0]["supporting_docs"]
    kinds = {d["kind"] for d in docs}
    assert "incident" in kinds and "satellite" in kinds
    sat = next(d for d in docs if d["kind"] == "satellite")
    assert "lat=26.6" in sat["url"] and "lon=56.3" in sat["url"]
    assert stories[1]["supporting_docs"] == []  # non-conflict untouched
