"""Person/identity OSINT: target classification + graph minting."""

from __future__ import annotations

import time

from app.osint.fetch import classify_target, normalise_email, normalise_username
from app.routes import osint as O


def test_classify_target_kinds() -> None:
    assert classify_target("1.2.3.4") == ("ip", "1.2.3.4")
    assert classify_target("Alice@Example.COM") == ("email", "alice@example.com")
    assert classify_target("example.com") == ("domain", "example.com")
    assert classify_target("torvalds") == ("username", "torvalds")
    assert classify_target("@torvalds") == ("username", "torvalds")
    assert classify_target("!!!") is None


def test_normalise_edge_cases() -> None:
    assert normalise_email("a@b.co") == "a@b.co"
    assert normalise_email("no-at-sign") is None
    assert normalise_username("has.dot") is None  # a dot means domain, not handle
    assert normalise_username("a" * 40) is None  # over GitHub's 39-char ceiling


async def test_investigate_username_mints_person(monkeypatch) -> None:
    async def fake_gh(u):
        return {"username": u, "found": True, "name": "Linus Torvalds",
                "email": "linus@example.org", "company": "Linux",
                "profile_url": "https://github.com/torvalds"}

    async def fake_gl(u):
        return {"username": u, "found": False}

    async def fake_sites(u):
        return {"username": u, "sites": {"github": True}, "present_on": ["github"]}

    monkeypatch.setattr(O.C, "lookup_github_user", fake_gh)
    monkeypatch.setattr(O.C, "lookup_gitlab_user", fake_gl)
    monkeypatch.setattr(O.C, "lookup_username_sites", fake_sites)

    g = O._Graph(ts=time.time())
    summary = await O._investigate_username(g, "torvalds")

    assert "username:torvalds" in g.objs
    assert "person:linus-torvalds" in g.objs
    assert "email:linus@example.org" in g.objs  # verified GH email bridges in
    assert summary["github"] is True
    assert summary["present_on"] == ["github"]
    # person → username link exists
    assert any(lk.src == "person:linus-torvalds" and lk.rel == "has_account"
               for lk in g.links.values())


async def test_investigate_email_links_gravatar_accounts(monkeypatch) -> None:
    async def fake_grav(e):
        return {"email": e, "found": True, "display_name": "Jane Roe",
                "accounts": [{"service": "github", "username": "janer", "url": "x"}]}

    async def fake_hibp(e):
        return {"email": e, "checked": False, "note": "no key"}

    monkeypatch.setattr(O.C, "lookup_gravatar", fake_grav)
    monkeypatch.setattr(O.C, "lookup_hibp", fake_hibp)

    g = O._Graph(ts=time.time())
    summary = await O._investigate_email(g, "jane@example.com")

    assert "email:jane@example.com" in g.objs
    assert "person:jane-roe" in g.objs
    assert "username:janer" in g.objs
    assert summary["linked_accounts"] == 1
