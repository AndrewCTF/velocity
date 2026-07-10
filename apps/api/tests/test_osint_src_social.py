"""Unit tests for app/osint/sources/social.py — no live network."""

from __future__ import annotations

import app.osint.sources.social as social

# ── pullpush_reddit ──────────────────────────────────────────────────────────

async def test_pullpush_reddit_submissions(monkeypatch) -> None:
    async def fake_fetch_json(url, ttl, **kw):
        assert "author=torvalds" in url
        return {
            "data": [
                {"subreddit": "linux", "title": "hello world", "created_utc": 100},
                {"subreddit": "linux", "title": "another post", "created_utc": 200},
                {"subreddit": "git", "title": "git stuff", "created_utc": 300},
            ]
        }

    monkeypatch.setattr(social, "fetch_json", fake_fetch_json)

    result = await social.pullpush_reddit("torvalds")

    assert result["username"] == "torvalds"
    assert result["count"] == 3
    assert len(result["submissions"]) == 3
    assert result["submissions"][0] == {
        "subreddit": "linux", "title": "hello world", "created": 100,
    }
    assert result["subreddits"] == ["git", "linux"]  # unique + sorted


async def test_pullpush_reddit_bounds_to_25(monkeypatch) -> None:
    async def fake_fetch_json(url, ttl, **kw):
        return {"data": [{"subreddit": "s", "title": f"t{i}", "created_utc": i} for i in range(40)]}

    monkeypatch.setattr(social, "fetch_json", fake_fetch_json)

    result = await social.pullpush_reddit("someone")

    assert result["count"] == 25
    assert len(result["submissions"]) == 25


async def test_pullpush_reddit_empty_result(monkeypatch) -> None:
    async def fake_fetch_json(url, ttl, **kw):
        return None

    monkeypatch.setattr(social, "fetch_json", fake_fetch_json)

    result = await social.pullpush_reddit("nobody")

    assert result == {"username": "nobody", "submissions": [], "subreddits": [], "count": 0}


async def test_pullpush_reddit_invalid_username(monkeypatch) -> None:
    async def fake_fetch_json(url, ttl, **kw):
        raise AssertionError("must not call upstream for an invalid username")

    monkeypatch.setattr(social, "fetch_json", fake_fetch_json)

    result = await social.pullpush_reddit("has.dot")

    assert result["username"] == "has.dot"
    assert result["submissions"] == []
    assert result["subreddits"] == []
    assert result["count"] == 0
    assert "note" in result


# ── libravatar_exists ─────────────────────────────────────────────────────────

async def test_libravatar_exists_true(monkeypatch) -> None:
    async def fake_head_ok(url):
        assert "seccdn.libravatar.org/avatar/" in url
        return True

    monkeypatch.setattr(social, "_head_ok", fake_head_ok)

    result = await social.libravatar_exists("Alice@Example.COM")

    assert result["email"] == "alice@example.com"
    assert result["has_avatar"] is True


async def test_libravatar_exists_false(monkeypatch) -> None:
    async def fake_head_ok(url):
        return False

    monkeypatch.setattr(social, "_head_ok", fake_head_ok)

    result = await social.libravatar_exists("bob@example.com")

    assert result["email"] == "bob@example.com"
    assert result["has_avatar"] is False


async def test_libravatar_exists_invalid_email(monkeypatch) -> None:
    async def fake_head_ok(url):
        raise AssertionError("must not call upstream for an invalid email")

    monkeypatch.setattr(social, "_head_ok", fake_head_ok)

    result = await social.libravatar_exists("not-an-email")

    assert result["email"] == "not-an-email"
    assert result["has_avatar"] is False
    assert "note" in result
