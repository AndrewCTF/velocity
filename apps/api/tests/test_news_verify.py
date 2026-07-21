"""Tests for the multi-local-LLM bias-verification stage (app.news.verify)."""

from __future__ import annotations

import asyncio
import copy

import app.news.verify as verify
from app.config import Settings


def _patched_settings(monkeypatch, **overrides) -> Settings:
    """``get_settings()`` builds a FRESH Settings() every call (no caching),
    so tests must replace the function itself, not mutate a throwaway
    instance."""
    s = Settings()
    for key, value in overrides.items():
        setattr(s, key, value)
    monkeypatch.setattr(verify, "get_settings", lambda: s)
    return s


def _installed(*keys_and_families: tuple[str, str | None]) -> list[dict]:
    """Build a fake manager.list_installed() payload from (key, unused) pairs."""
    return [{"key": k} for k, _ in keys_and_families]


def _story(
    story_id: str,
    *,
    title: str = "Storm hits coast",
    summary: str = "A storm made landfall overnight.",
    sources: list[str] | None = None,
) -> dict:
    sources = sources if sources is not None else ["Reuters", "BBC World"]
    return {
        "id": story_id,
        "category": "World",
        "title": title,
        "neutral_summary": summary,
        "neutral_rewrite": "",
        "recommended_actions": [],
        "whats_wrong": [],
        "propaganda_techniques": [],
        "verified_facts": [],
        "attributed_claims": [],
        "rhetoric_flags": [],
        "corroboration": {"source_count": len(sources), "sources": sources},
        "proofs": [{"source": s, "url": f"https://{s.lower().replace(' ', '')}.example/x", "published": ""}
                   for s in sources],
        "image": "",
        "supporting_docs": [],
        "confidence": 0.5,
    }


def _edition(*stories: dict) -> dict:
    return {
        "generated": "2026-07-21T00:00:00Z",
        "categories": ["World", "Conflict"],
        "lead": stories[0] if stories else None,
        "stories": list(stories),
        "method": "test",
        "backend": "test",
        "article_count": len(stories),
        "source_count": 2,
    }


def _all_links(edition: dict) -> set[str]:
    out: set[str] = set()
    for s in edition.get("stories") or []:
        for p in s.get("proofs") or []:
            if p.get("url"):
                out.add(p["url"])
    return out


# ── resolve_verifiers ────────────────────────────────────────────────────────


def test_resolve_verifiers_explicit_setting_filters_to_installed(monkeypatch):
    _patched_settings(monkeypatch, news_verify_models="qwen3-30b,ghost-key,glm4-9b")
    monkeypatch.setattr(verify.manager, "list_installed", lambda: _installed(("qwen3-30b", None), ("glm4-9b", None)))
    monkeypatch.setattr(verify.manager, "get_active", lambda: {"main": None, "selection": None})
    assert verify.resolve_verifiers() == ["qwen3-30b", "glm4-9b"]


def test_resolve_verifiers_auto_pick_prefers_distinct_families_and_excludes_main(monkeypatch):
    _patched_settings(monkeypatch, news_verify_models="")
    monkeypatch.setattr(
        verify.manager,
        "list_installed",
        lambda: _installed(("deepseek-r1-8b", None), ("qwen3-30b", None), ("qwen3-8b", None), ("glm4-9b", None)),
    )
    monkeypatch.setattr(verify.manager, "get_active", lambda: {"main": "deepseek-r1-8b", "selection": None})
    picked = verify.resolve_verifiers()
    assert "deepseek-r1-8b" not in picked
    assert len(picked) == 2
    families = {verify._family(k) for k in picked}
    assert len(families) == 2  # distinct families, not qwen3-30b + qwen3-8b


def test_resolve_verifiers_auto_pick_fills_with_same_family_if_needed(monkeypatch):
    _patched_settings(monkeypatch, news_verify_models="")
    monkeypatch.setattr(
        verify.manager, "list_installed", lambda: _installed(("qwen3-30b", None), ("qwen3-8b", None))
    )
    monkeypatch.setattr(verify.manager, "get_active", lambda: {"main": None, "selection": None})
    picked = verify.resolve_verifiers()
    assert picked == ["qwen3-30b", "qwen3-8b"]


def test_resolve_verifiers_empty_when_nothing_installed(monkeypatch):
    _patched_settings(monkeypatch, news_verify_models="")
    monkeypatch.setattr(verify.manager, "list_installed", lambda: [])
    monkeypatch.setattr(verify.manager, "get_active", lambda: {"main": None, "selection": None})
    assert verify.resolve_verifiers() == []


# ── diversity_of ─────────────────────────────────────────────────────────────


def test_diversity_of_counts_outlets_and_leaning_buckets():
    # Reuters (wire) + BBC World (center) -> 2 outlets, 2 buckets.
    d = verify.diversity_of(_story("s1", sources=["Reuters", "BBC World"]))
    assert d["outlets"] == 2
    assert len(d["buckets"]) == 2


def test_diversity_of_single_bucket_sources():
    # Reuters + AP are both "wire" -> 2 outlets but only 1 bucket.
    d = verify.diversity_of(_story("s1", sources=["Reuters", "AP"]))
    assert d["outlets"] == 2
    assert d["buckets"] == ["wire"]


# ── verify_edition: no verifiers ────────────────────────────────────────────


def test_verify_edition_no_verifiers_skips_everything(monkeypatch):
    monkeypatch.setattr(verify, "resolve_verifiers", lambda: [])
    ed = _edition(_story("s1"))
    out = asyncio.run(verify.verify_edition(ed))
    assert out["verification"] == {"models": [], "skipped": True}
    assert out["stories"][0]["verification"] == {"skipped": "no verifier models installed"}


# ── verify_edition: aggregation paths ───────────────────────────────────────


def _fake_ensure_hot(monkeypatch):
    async def _noop(key):
        return None

    monkeypatch.setattr(verify.llamacpp_sidecar, "ensure_hot", _noop)


def _pass_verdict(story_id: str) -> dict:
    return {
        "story_id": story_id, "verdict": "pass", "loaded_language": [], "one_sided": False,
        "unsupported_claims": [], "missing_perspective": "", "confidence": 0.9,
    }


def _flag_verdict(story_id: str, *, phrase: str = "regime") -> dict:
    return {
        "story_id": story_id, "verdict": "flag", "loaded_language": [phrase], "one_sided": True,
        "unsupported_claims": ["unverified death toll"], "missing_perspective": "official response",
        "confidence": 0.7,
    }


def test_all_pass_and_diverse_sources_is_verified_neutral(monkeypatch):
    monkeypatch.setattr(verify, "resolve_verifiers", lambda: ["model-a", "model-b"])
    _fake_ensure_hot(monkeypatch)

    async def _fake_chat_json(messages, *, tier, local_model_key=None, label="", **kw):
        assert local_model_key in ("model-a", "model-b")
        return [_pass_verdict("s1")], type("R", (), {"ok": True})()

    monkeypatch.setattr(verify, "chat_json", _fake_chat_json)
    ed = _edition(_story("s1", sources=["Reuters", "BBC World"]))
    before = copy.deepcopy(ed)
    out = asyncio.run(verify.verify_edition(ed))

    assert ed == before, "input edition must not be mutated"
    v = out["stories"][0]["verification"]
    assert v["status"] == "verified-neutral"
    assert v["verdicts"] == 2
    assert out["verification"]["stories_verified"] == 1
    assert out["verification"]["stories_flagged"] == 0
    assert _all_links(out) <= _all_links(before)


def test_all_pass_but_single_bucket_sources_not_verified_neutral(monkeypatch):
    monkeypatch.setattr(verify, "resolve_verifiers", lambda: ["model-a", "model-b"])
    _fake_ensure_hot(monkeypatch)

    async def _fake_chat_json(messages, *, tier, local_model_key=None, label="", **kw):
        return [_pass_verdict("s1")], type("R", (), {"ok": True})()

    monkeypatch.setattr(verify, "chat_json", _fake_chat_json)
    ed = _edition(_story("s1", sources=["Reuters", "AP"]))  # both wire
    out = asyncio.run(verify.verify_edition(ed))
    v = out["stories"][0]["verification"]
    assert v["status"] != "verified-neutral"


def test_one_flag_triggers_repair_with_drafting_model_and_keeps_original(monkeypatch):
    monkeypatch.setattr(verify, "resolve_verifiers", lambda: ["model-a", "model-b"])
    _fake_ensure_hot(monkeypatch)
    calls: list[dict] = []

    async def _fake_chat_json(messages, *, tier, local_model_key=None, label="", **kw):
        calls.append({"local_model_key": local_model_key, "label": label})
        if local_model_key == "model-a":
            return [_flag_verdict("s1")], type("R", (), {"ok": True})()
        if local_model_key == "model-b":
            return [_pass_verdict("s1")], type("R", (), {"ok": True})()
        # Repair call: no local_model_key at all.
        assert local_model_key is None
        return (
            {"title": "Storm makes landfall", "neutral_summary": "A storm made landfall overnight, per reports."},
            type("R", (), {"ok": True})(),
        )

    monkeypatch.setattr(verify, "chat_json", _fake_chat_json)
    ed = _edition(_story("s1", title="Storm hits coast, regime blamed"))
    before = copy.deepcopy(ed)
    out = asyncio.run(verify.verify_edition(ed))

    repair_calls = [c for c in calls if c["local_model_key"] is None]
    assert len(repair_calls) == 1, "exactly one repair call on the drafting model"
    story = out["stories"][0]
    assert story["verification"]["status"] == "reviewed-revised"
    assert story["title"] == "Storm makes landfall"
    assert story["bias_review"]["original"]["title"] == "Storm hits coast, regime blamed"
    assert story["bias_review"]["flags"]["loaded_language"] == ["regime"]
    assert _all_links(out) <= _all_links(before)


def test_majority_flag_is_contested_with_no_repair_call(monkeypatch):
    monkeypatch.setattr(verify, "resolve_verifiers", lambda: ["model-a", "model-b"])
    _fake_ensure_hot(monkeypatch)
    repair_calls = []

    async def _fake_chat_json(messages, *, tier, local_model_key=None, label="", **kw):
        if local_model_key is None:
            repair_calls.append(1)
        return [_flag_verdict("s1")], type("R", (), {"ok": True})()

    monkeypatch.setattr(verify, "chat_json", _fake_chat_json)
    ed = _edition(_story("s1"))
    original_title = ed["stories"][0]["title"]
    out = asyncio.run(verify.verify_edition(ed))

    assert repair_calls == []
    story = out["stories"][0]
    assert story["verification"]["status"] == "contested"
    assert len(story["verification"]["flags"]) == 2
    # No per-source headlines on this story shape, so title is left as is.
    assert story["title"] == original_title


def test_malformed_verifier_json_is_tolerated(monkeypatch):
    monkeypatch.setattr(verify, "resolve_verifiers", lambda: ["model-a", "model-b"])
    _fake_ensure_hot(monkeypatch)

    async def _fake_chat_json(messages, *, tier, local_model_key=None, label="", **kw):
        if local_model_key == "model-a":
            return None, type("R", (), {"ok": False})()  # unparseable
        return [_pass_verdict("s1")], type("R", (), {"ok": True})()

    monkeypatch.setattr(verify, "chat_json", _fake_chat_json)
    ed = _edition(_story("s1", sources=["Reuters", "BBC World"]))
    out = asyncio.run(verify.verify_edition(ed))

    v = out["stories"][0]["verification"]
    assert v["verdicts"] == 1
    assert v["status"] == "reviewed"
    assert v["note"] == "single-model review"
    assert out["verification"]["errors"], "the failing verifier must be recorded"


def test_budget_exhaustion_skips_remaining_stories(monkeypatch):
    monkeypatch.setattr(verify, "resolve_verifiers", lambda: ["model-a"])
    _fake_ensure_hot(monkeypatch)
    # Tiny budget: the first batch's monotonic reads already blow through it,
    # so the second batch of 6 stories must come back skipped:budget.
    _patched_settings(monkeypatch, news_verify_budget_s=2)

    t = {"n": 0.0}

    def _fake_monotonic():
        t["n"] += 1.0
        return t["n"]

    monkeypatch.setattr(verify.time, "monotonic", _fake_monotonic)

    async def _fake_chat_json(messages, *, tier, local_model_key=None, label="", **kw):
        return [_pass_verdict(sid) for sid in ["s0", "s1", "s2", "s3", "s4", "s5"]], type("R", (), {"ok": True})()

    monkeypatch.setattr(verify, "chat_json", _fake_chat_json)

    stories = [_story(f"s{i}") for i in range(12)]  # 2 batches of 6
    ed = _edition(*stories)
    out = asyncio.run(verify.verify_edition(ed))

    statuses = [s["verification"] for s in out["stories"]]
    skipped = [v for v in statuses if v.get("skipped") == "budget"]
    assert skipped, "some stories must be skipped once the budget is exhausted"
    assert out["verification"]["budget_exhausted"] is True


def test_single_verifier_caps_status_at_reviewed(monkeypatch):
    monkeypatch.setattr(verify, "resolve_verifiers", lambda: ["model-a"])
    _fake_ensure_hot(monkeypatch)

    async def _fake_chat_json(messages, *, tier, local_model_key=None, label="", **kw):
        return [_pass_verdict("s1")], type("R", (), {"ok": True})()

    monkeypatch.setattr(verify, "chat_json", _fake_chat_json)
    ed = _edition(_story("s1", sources=["Reuters", "BBC World"]))
    out = asyncio.run(verify.verify_edition(ed))

    v = out["stories"][0]["verification"]
    assert v["status"] == "reviewed"
    assert v["note"] == "single-model review"


def test_link_set_never_grows(monkeypatch):
    monkeypatch.setattr(verify, "resolve_verifiers", lambda: ["model-a", "model-b"])
    _fake_ensure_hot(monkeypatch)

    async def _fake_chat_json(messages, *, tier, local_model_key=None, label="", **kw):
        if local_model_key == "model-a":
            return [_flag_verdict("s1")], type("R", (), {"ok": True})()
        if local_model_key == "model-b":
            return [_pass_verdict("s1")], type("R", (), {"ok": True})()
        return (
            {"title": "Rewritten", "neutral_summary": "Rewritten summary."},
            type("R", (), {"ok": True})(),
        )

    monkeypatch.setattr(verify, "chat_json", _fake_chat_json)
    ed = _edition(_story("s1"))
    before_links = _all_links(ed)
    out = asyncio.run(verify.verify_edition(ed))
    assert _all_links(out) <= before_links


def test_input_edition_is_never_mutated(monkeypatch):
    monkeypatch.setattr(verify, "resolve_verifiers", lambda: ["model-a", "model-b"])
    _fake_ensure_hot(monkeypatch)

    async def _fake_chat_json(messages, *, tier, local_model_key=None, label="", **kw):
        if local_model_key == "model-a":
            return [_flag_verdict("s1")], type("R", (), {"ok": True})()
        if local_model_key == "model-b":
            return [_pass_verdict("s1")], type("R", (), {"ok": True})()
        return (
            {"title": "Rewritten", "neutral_summary": "Rewritten summary."},
            type("R", (), {"ok": True})(),
        )

    monkeypatch.setattr(verify, "chat_json", _fake_chat_json)
    ed = _edition(_story("s1", title="Original title"))
    snapshot = copy.deepcopy(ed)
    asyncio.run(verify.verify_edition(ed))
    assert ed == snapshot


# ── country_tags ─────────────────────────────────────────────────────────────


def test_country_tags_finds_mentioned_countries():
    story = _story("s1", title="Storm hits France and Germany", summary="Flooding reported across both countries.")
    tags = verify.country_tags(story)
    assert "FRA" in tags
    assert "DEU" in tags


def test_country_tags_empty_when_no_country_named():
    story = _story("s1", title="Quiet weekend", summary="Nothing much happened.")
    assert verify.country_tags(story) == []
