"""Local SQLite news history sink + brief assembly (Track A3).

``history_local`` mirrors ``app/intel/action_log_local.py``'s idiom (WAL
SQLite, per-test ``override_db_path``); ``brief`` builds a top-story-per-
category brief deterministically and adds one best-effort LLM synthesis
paragraph on top.
"""

from __future__ import annotations

import asyncio

import pytest

from app import llm
from app.news import brief, history_local
from app.news.analyze import _INJECTION_GUARD

# ── fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolate_news_history_db(tmp_path):
    history_local.override_db_path(str(tmp_path / "news_history.db"))
    yield
    history_local.override_db_path(None)


# ── history_local: round-trip ───────────────────────────────────────────────


def test_append_and_list_round_trip_payload_fidelity() -> None:
    payload = {"stories": [{"title": "a"}], "nested": {"x": [1, 2, 3]}}
    row_id = asyncio.run(
        history_local.append_snapshot("edition", payload, article_count=5, verified_count=2)
    )
    assert isinstance(row_id, int) and row_id > 0

    rows = asyncio.run(history_local.list_snapshots("edition", limit=10))
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == row_id
    assert row["kind"] == "edition"
    assert row["article_count"] == 5
    assert row["verified_count"] == 2
    assert row["payload"] == payload
    assert isinstance(row["created_utc"], str) and row["created_utc"]


def test_latest_returns_most_recent_snapshot() -> None:
    asyncio.run(history_local.append_snapshot("analysis", {"n": 1}))
    asyncio.run(history_local.append_snapshot("analysis", {"n": 2}))
    latest = asyncio.run(history_local.latest("analysis"))
    assert latest is not None
    assert latest["payload"] == {"n": 2}


def test_latest_none_when_no_snapshots_of_kind() -> None:
    assert asyncio.run(history_local.latest("brief")) is None


def test_kinds_are_independent() -> None:
    asyncio.run(history_local.append_snapshot("edition", {"k": "e"}))
    asyncio.run(history_local.append_snapshot("brief", {"k": "b"}))
    edition_rows = asyncio.run(history_local.list_snapshots("edition"))
    brief_rows = asyncio.run(history_local.list_snapshots("brief"))
    assert len(edition_rows) == 1
    assert len(brief_rows) == 1
    assert edition_rows[0]["payload"] == {"k": "e"}
    assert brief_rows[0]["payload"] == {"k": "b"}


# ── history_local: prune to newest 200 per kind ─────────────────────────────


def test_prune_keeps_newest_200_rows_per_kind() -> None:
    ids = [
        asyncio.run(history_local.append_snapshot("edition", {"n": i}))
        for i in range(205)
    ]
    rows = asyncio.run(history_local.list_snapshots("edition", limit=1000))
    assert len(rows) == 200
    kept_ids = {r["id"] for r in rows}
    # The newest 200 (highest ids) survive; the oldest 5 are gone.
    assert kept_ids == set(ids[5:])
    assert max(r["payload"]["n"] for r in rows) == 204
    assert min(r["payload"]["n"] for r in rows) == 5


def test_prune_does_not_touch_other_kinds() -> None:
    for i in range(3):
        asyncio.run(history_local.append_snapshot("brief", {"n": i}))
    for i in range(205):
        asyncio.run(history_local.append_snapshot("edition", {"n": i}))
    brief_rows = asyncio.run(history_local.list_snapshots("brief", limit=1000))
    assert len(brief_rows) == 3


# ── history_local: kind validation ──────────────────────────────────────────


def test_append_snapshot_rejects_unknown_kind() -> None:
    with pytest.raises(ValueError):
        asyncio.run(history_local.append_snapshot("bogus", {}))


def test_list_snapshots_rejects_unknown_kind() -> None:
    with pytest.raises(ValueError):
        asyncio.run(history_local.list_snapshots("bogus"))


# ── brief: deterministic assembly (no LLM) ──────────────────────────────────

_EDITION = {
    "categories": ["World", "Conflict", "Tech"],
    "articles_age_s": 12.5,
    "verified_count": 3,
    "stories": [
        {
            "title": "Conflict lead",
            "category": "Conflict",
            "proofs": [{"source": "Reuters", "url": "https://reuters.example/1", "published": ""}],
            "verified_facts": [{"fact": "x", "sources": ["Reuters"]}],
            "corroboration": {"source_count": 2, "sources": ["Reuters", "AP"]},
            "confidence": 0.8,
        },
        {
            "title": "World lead",
            "category": "World",
            "link": "https://example.com/world",
            "proofs": [],
            "corroboration": {"source_count": 1, "sources": ["AP"]},
        },
        {
            "title": "Second conflict story (not picked, Conflict already has a lead)",
            "category": "Conflict",
            "proofs": [{"source": "AP", "url": "https://ap.example/2", "published": ""}],
        },
        {
            "title": "Tech lead",
            "category": "Tech",
            "proofs": [{"source": "Wire", "url": "https://wire.example/3", "published": ""}],
        },
    ],
}


def _mock_llm_error(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_complete(system: str, user: str, **kwargs):
        return llm.LlmResult(text=None, error="no backend configured")

    monkeypatch.setattr(llm, "complete", _fake_complete)


def test_build_brief_deterministic_shape_and_no_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_llm_error(monkeypatch)
    result = asyncio.run(brief.build_brief(_EDITION))

    assert result["categories"] == ["World", "Conflict", "Tech"]
    assert isinstance(result["generated_utc"], str) and result["generated_utc"]
    assert result["synthesis"] == ""
    assert result["synthesis_error"] == "no backend configured"

    top_titles = [t["title"] for t in result["top"]]
    # One entry per category, top story order follows the edition's own
    # categories list, and the second Conflict story is not picked.
    assert top_titles == ["World lead", "Conflict lead", "Tech lead"]

    world_entry = next(t for t in result["top"] if t["category"] == "World")
    assert world_entry["link"] == "https://example.com/world"

    conflict_entry = next(t for t in result["top"] if t["category"] == "Conflict")
    # link derived from proofs[0].url since the story itself has no "link" key
    assert conflict_entry["link"] == "https://reuters.example/1"
    assert conflict_entry["verified_facts"] == [{"fact": "x", "sources": ["Reuters"]}]
    assert conflict_entry["corroboration"] == {"source_count": 2, "sources": ["Reuters", "AP"]}
    assert conflict_entry["confidence"] == 0.8

    tech_entry = next(t for t in result["top"] if t["category"] == "Tech")
    assert "verified_facts" not in tech_entry  # never invented

    assert result["freshness"] == {
        "articles_age_s": 12.5,
        "feeds_fetched": None,
        "feeds_total": None,
        "verified_count": 3,
    }


def test_build_brief_empty_edition_never_blocks() -> None:
    result = asyncio.run(brief.build_brief({"categories": [], "stories": []}))
    assert result["top"] == []
    assert result["synthesis"] == ""
    assert result["synthesis_error"] == ""
    assert result["freshness"] == {
        "articles_age_s": None,
        "feeds_fetched": None,
        "feeds_total": None,
        "verified_count": None,
    }


# ── brief: LLM success path — injection guard ordering ──────────────────────


def test_build_brief_llm_success_system_prompt_ends_with_injection_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, str] = {}

    async def _fake_complete(system: str, user: str, **kwargs):
        captured["system"] = system
        captured["user"] = user
        return llm.LlmResult(text="A calm, factual synthesis paragraph.", backend="fake")

    monkeypatch.setattr(llm, "complete", _fake_complete)

    result = asyncio.run(brief.build_brief(_EDITION))

    assert result["synthesis"] == "A calm, factual synthesis paragraph."
    assert result["synthesis_error"] == ""
    assert captured["system"].endswith(_INJECTION_GUARD)
    # Style rider is stated before the guard, guard is the final word.
    assert captured["system"].index(llm.PROSE_STYLE) < captured["system"].index(_INJECTION_GUARD)
    # Headline titles reach the model only inside the untrusted-data fence.
    assert "<<<UNTRUSTED_DATA>>>" in captured["user"]
    assert "Conflict lead" in captured["user"]
