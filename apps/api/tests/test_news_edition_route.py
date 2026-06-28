# apps/api/tests/test_news_edition_route.py
from fastapi.testclient import TestClient
import app.routes.news as news_routes
from app.news import store
from app.main import create_app


def test_edition_endpoint_empty_state():
    store.reset()
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/edition")
    assert r.status_code == 200
    body = r.json()
    assert "stories" in body and isinstance(body["stories"], list)


def test_edition_served_from_cache(monkeypatch):
    store.reset()
    store.set_edition({"stories": [{"id": "x", "category": "World", "title": "t"}],
                       "categories": ["World"], "lead": None, "method": "test"})
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/edition")
    assert r.status_code == 200
    assert r.json()["stories"][0]["id"] == "x"
