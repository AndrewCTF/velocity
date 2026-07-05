"""New NL-query agent tools: graph_lookup, track_history, investigate_osint."""

from __future__ import annotations

from app.intel import agent
from app.routes import osint as O


async def test_graph_lookup_requires_signin() -> None:
    agent._agent_ctx.set(None)
    out = await agent._t_graph_lookup({"id": "vessel:123"}, None)
    assert "sign-in" in out["note"]


async def test_graph_lookup_missing_id() -> None:
    out = await agent._t_graph_lookup({}, None)
    assert "error" in out


async def test_track_history_shape() -> None:
    out = await agent._t_track_history({"hours": 2}, None)
    assert "tracks" in out and "track_count" in out
    assert out["hours"] == 2


async def test_investigate_osint_readonly_subgraph(monkeypatch) -> None:
    async def fake_gh(u):
        return {"username": u, "found": True, "name": "Linus Torvalds",
                "profile_url": "https://github.com/torvalds"}

    async def fake_gl(u):
        return {"username": u, "found": False}

    async def fake_sites(u):
        return {"username": u, "sites": {"github": True}, "present_on": ["github"]}

    monkeypatch.setattr(O.C, "lookup_github_user", fake_gh)
    monkeypatch.setattr(O.C, "lookup_gitlab_user", fake_gl)
    monkeypatch.setattr(O.C, "lookup_username_sites", fake_sites)

    out = await agent._t_investigate_osint({"target": "torvalds"}, None)
    assert out["root"] == "username:torvalds"
    ids = {o["id"] for o in out["objects"]}
    assert "username:torvalds" in ids
    assert "person:linus-torvalds" in ids
    assert any(lk["rel"] == "has_account" for lk in out["links"])


async def test_investigate_osint_bad_target() -> None:
    out = await agent._t_investigate_osint({"target": "!!!"}, None)
    assert "error" in out
