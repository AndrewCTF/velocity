# apps/api/tests/test_news_edition_route.py
from fastapi.testclient import TestClient

import app.routes.news as news_routes
from app.main import create_app
from app.news import store


async def _no_articles():
    return []


def test_edition_endpoint_empty_state(monkeypatch):
    store.reset()
    # Avoid real RSS fetch + reason-tier LLM: an empty corpus degrades fast to a
    # well-formed empty edition (the path we want to assert is public + 200).
    monkeypatch.setattr(news_routes, "_ensure_articles", _no_articles)
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/edition")
    assert r.status_code == 200
    body = r.json()
    assert "stories" in body and isinstance(body["stories"], list)


async def _boom():
    raise RuntimeError("upstream RSS exploded")


def test_edition_endpoint_never_500_on_build_error(monkeypatch):
    # Any failure in the on-demand build must degrade to HTTP 200 empty edition,
    # not a 500 — the public page must never error or hang.
    store.reset()
    monkeypatch.setattr(news_routes, "_ensure_articles", _boom)
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/edition")
    assert r.status_code == 200
    assert r.json()["stories"] == []


def test_edition_served_from_cache(monkeypatch):
    store.reset()
    store.set_edition({"stories": [{"id": "x", "category": "World", "title": "t"}],
                       "categories": ["World"], "lead": None, "method": "test"})
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/edition")
    assert r.status_code == 200
    assert r.json()["stories"][0]["id"] == "x"
