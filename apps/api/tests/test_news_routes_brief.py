# apps/api/tests/test_news_routes_brief.py
"""Tests for the news brief/history routes and the refresher's verify → image
→ history → brief write-through added in Track A5.

Follows the TestClient + monkeypatch conventions of
``test_news_edition_route.py`` / ``test_news_history.py``: real SQLite via
``history_local.override_db_path(tmp_path)`` rather than mocking the DB layer,
and monkeypatching ``app.routes.news``'s module-level references (functions
are looked up on the module at call time, so patching the imported name there
is enough — no need to touch the underlying module).
"""

from __future__ import annotations

import asyncio
import copy

import pytest
from fastapi.testclient import TestClient

import app.routes.news as news_routes
from app.main import create_app
from app.news import history_local, images
from app.news import store as news_store

# ── fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    history_local.override_db_path(str(tmp_path / "news_history.db"))
    news_store.reset()
    yield
    history_local.override_db_path(None)
    news_store.reset()


# ── /api/news/brief ──────────────────────────────────────────────────────────


def test_brief_route_404_when_empty():
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/brief")
    assert r.status_code == 404
    assert r.json() == {"error": "no brief yet"}


def test_brief_route_200_with_canned_payload():
    canned = {
        "generated_utc": "2026-07-20T00:00:00+00:00",
        "categories": ["World"],
        "top": [{"title": "Story", "category": "World", "link": "https://ex.com/a"}],
        "synthesis": "A calm synthesis.",
        "synthesis_error": "",
        "freshness": {"articles_age_s": 1.0},
    }
    asyncio.run(history_local.append_snapshot("brief", canned))

    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/brief")
    assert r.status_code == 200
    assert r.json() == canned


# ── /api/news/history ────────────────────────────────────────────────────────


def test_history_route_rejects_invalid_kind():
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/history", params={"kind": "bogus"})
    assert r.status_code == 400
    assert "invalid kind" in r.json()["error"]


def test_history_route_returns_light_items():
    asyncio.run(
        history_local.append_snapshot(
            "edition", {"stories": [{"title": "a"}]}, article_count=5, verified_count=2
        )
    )
    asyncio.run(
        history_local.append_snapshot(
            "edition", {"stories": [{"title": "b"}]}, article_count=7, verified_count=3
        )
    )

    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/history", params={"kind": "edition", "limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert "items" in body
    items = body["items"]
    assert len(items) == 2
    # newest first
    assert items[0]["article_count"] == 7
    assert items[1]["article_count"] == 5
    for item in items:
        assert set(item.keys()) == {"id", "kind", "created_utc", "article_count", "verified_count"}
        assert item["kind"] == "edition"
        assert "payload" not in item


def test_history_route_caps_limit_at_50():
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/history", params={"kind": "edition", "limit": 500})
    assert r.status_code == 422  # FastAPI Query(le=50) validation


# ── images.enrich_images (batch helper) ─────────────────────────────────────


def test_enrich_images_fills_missing_and_respects_limit(monkeypatch):
    calls: list[str] = []

    async def _fake_fetch(url: str, timeout_s: float = 6.0) -> str:
        calls.append(url)
        return f"{url}.jpg"

    monkeypatch.setattr(images, "fetch_og_image", _fake_fetch)

    stories = [
        {"id": "1", "link": "https://ex.com/1"},
        {"id": "2", "image": "already-has-one.jpg", "link": "https://ex.com/2"},
        {"id": "3", "proofs": [{"url": "https://ex.com/3"}]},
        {"id": "4"},  # no link, no proofs — skipped
    ]
    filled = asyncio.run(images.enrich_images(stories, limit=60))

    assert filled == 2
    assert stories[0]["image"] == "https://ex.com/1.jpg"
    assert stories[1]["image"] == "already-has-one.jpg"  # untouched
    assert stories[2]["image"] == "https://ex.com/3.jpg"
    assert "image" not in stories[3]
    assert sorted(calls) == ["https://ex.com/1", "https://ex.com/3"]


def test_enrich_images_bounded_by_limit(monkeypatch):
    async def _fake_fetch(url: str, timeout_s: float = 6.0) -> str:
        return f"{url}.jpg"

    monkeypatch.setattr(images, "fetch_og_image", _fake_fetch)

    stories = [{"id": str(i), "link": f"https://ex.com/{i}"} for i in range(10)]
    filled = asyncio.run(images.enrich_images(stories, limit=3))

    assert filled == 3
    assert sum(1 for s in stories if "image" in s) == 3


# ── refresh_once integration ─────────────────────────────────────────────────


def _canned_edition() -> dict:
    return {
        "generated": "now",
        "categories": ["World"],
        "lead": None,
        "stories": [
            {"id": "s1", "category": "World", "title": "Story 1", "link": "https://ex.com/1"},
            {"id": "s2", "category": "World", "title": "Story 2", "link": "https://ex.com/2"},
        ],
        "method": "wall",
        "backend": "test",
        "article_count": 10,
        "source_count": 3,
    }


def _wire_common_refresh_fakes(monkeypatch, call_order: list[str]):
    async def _fake_ensure_articles():
        return []

    async def _fake_analyze(articles):
        call_order.append("analyze")
        return {"events": [], "method": "ok"}

    async def _fake_analyze_edition(articles):
        call_order.append("analyze_edition")
        return _canned_edition()

    async def _fake_enrich_images(stories, *, limit=60, concurrency=6):
        call_order.append("enrich_images")
        return 0

    monkeypatch.setattr(news_routes, "_ensure_articles", _fake_ensure_articles)
    monkeypatch.setattr(news_routes.news_analyze, "analyze", _fake_analyze)
    monkeypatch.setattr(news_routes.news_analyze, "analyze_edition", _fake_analyze_edition)
    monkeypatch.setattr(news_routes.news_images, "enrich_images", _fake_enrich_images)

    orig_append = history_local.append_snapshot

    async def _tracking_append(kind, payload, **kwargs):
        call_order.append(f"append:{kind}")
        return await orig_append(kind, payload, **kwargs)

    monkeypatch.setattr(news_routes.history_local, "append_snapshot", _tracking_append)


def test_refresh_once_verifies_before_persist_and_computes_verified_count(monkeypatch):
    call_order: list[str] = []
    _wire_common_refresh_fakes(monkeypatch, call_order)

    async def _fake_verify_edition(edition):
        call_order.append("verify_edition")
        new_edition = copy.deepcopy(edition)
        new_edition["stories"][0]["verification"] = {"status": "verified-neutral"}
        new_edition["stories"][1]["verification"] = {"status": "contested"}
        new_edition["verification"] = {"models": ["fake"], "stories_verified": 2, "stories_flagged": 1}
        return new_edition

    async def _fake_build_brief(edition):
        call_order.append("build_brief")
        return {
            "generated_utc": "2026-07-20T00:00:00+00:00",
            "categories": ["World"],
            "top": [],
            "synthesis": "",
            "synthesis_error": "",
            "freshness": {},
        }

    monkeypatch.setattr(news_routes.news_verify, "verify_edition", _fake_verify_edition)
    monkeypatch.setattr(news_routes.news_brief, "build_brief", _fake_build_brief)

    asyncio.run(news_routes.refresh_once())

    # verify runs before either history append, and both persist calls happen
    # before the (first-time) brief build.
    assert call_order.index("verify_edition") < call_order.index("append:edition")
    assert call_order.index("verify_edition") < call_order.index("append:analysis")
    assert call_order.index("append:edition") < call_order.index("build_brief")
    assert "append:brief" in call_order

    edition_rows = asyncio.run(history_local.list_snapshots("edition", limit=10))
    assert len(edition_rows) == 1
    assert edition_rows[0]["verified_count"] == 1  # only one story reached verified-neutral
    assert edition_rows[0]["article_count"] == 10

    analysis_rows = asyncio.run(history_local.list_snapshots("analysis", limit=10))
    assert len(analysis_rows) == 1
    assert analysis_rows[0]["verified_count"] == 1

    # The served (in-memory) edition is the VERIFIED one, not the raw wall.
    served = news_store.get_edition()
    assert served["stories"][0]["verification"]["status"] == "verified-neutral"


def test_refresh_once_builds_brief_when_none_and_skips_when_fresh(monkeypatch):
    call_order: list[str] = []
    _wire_common_refresh_fakes(monkeypatch, call_order)

    async def _fake_verify_edition(edition):
        return copy.deepcopy(edition)

    build_calls = {"n": 0}

    async def _fake_build_brief(edition):
        build_calls["n"] += 1
        return {
            "generated_utc": "2026-07-20T00:00:00+00:00",
            "categories": [],
            "top": [],
            "synthesis": "",
            "synthesis_error": "",
            "freshness": {},
        }

    monkeypatch.setattr(news_routes.news_verify, "verify_edition", _fake_verify_edition)
    monkeypatch.setattr(news_routes.news_brief, "build_brief", _fake_build_brief)

    asyncio.run(news_routes.refresh_once())
    assert build_calls["n"] == 1
    assert len(asyncio.run(history_local.list_snapshots("brief", limit=10))) == 1

    # A second refresh right away must NOT rebuild the brief — it is fresh.
    news_store.reset()
    asyncio.run(news_routes.refresh_once())
    assert build_calls["n"] == 1
    assert len(asyncio.run(history_local.list_snapshots("brief", limit=10))) == 1


def test_refresh_once_verify_failure_still_stores_and_serves_edition(monkeypatch):
    call_order: list[str] = []
    _wire_common_refresh_fakes(monkeypatch, call_order)

    async def _boom(edition):
        raise RuntimeError("verifier ensemble exploded")

    async def _fake_build_brief(edition):
        return {
            "generated_utc": "2026-07-20T00:00:00+00:00",
            "categories": [],
            "top": [],
            "synthesis": "",
            "synthesis_error": "",
            "freshness": {},
        }

    monkeypatch.setattr(news_routes.news_verify, "verify_edition", _boom)
    monkeypatch.setattr(news_routes.news_brief, "build_brief", _fake_build_brief)

    result = asyncio.run(news_routes.refresh_once())
    assert result["method"] == "ok"  # analysis result still returned

    # The unverified edition is still served and persisted — a verify crash
    # must never drop the edition off the public page.
    served = news_store.get_edition()
    assert served is not None
    assert served["stories"][0]["id"] == "s1"
    assert "verification" not in served["stories"][0]

    edition_rows = asyncio.run(history_local.list_snapshots("edition", limit=10))
    assert len(edition_rows) == 1
    assert edition_rows[0]["verified_count"] == 0
