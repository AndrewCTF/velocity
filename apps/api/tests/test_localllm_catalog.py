"""Unit tests for app.localllm.catalog — pure data + fit-helper logic."""

from __future__ import annotations

import pytest

from app.localllm import catalog


def test_catalog_has_seven_tiers_in_ascending_order() -> None:
    assert catalog.TIER_ORDER == ("8b", "30b", "70b", "120b", "200b", "300b", "700b")
    assert len(catalog.CATALOG) == 7
    assert [e.tier for e in catalog.CATALOG] == list(catalog.TIER_ORDER)


def test_every_entry_carries_its_recommended_quant() -> None:
    for entry in catalog.CATALOG:
        rec = entry.recommended
        assert rec.q == entry.recommended_quant
        assert rec.size_gb > 0


def test_all_repo_ids_are_unsloth_org() -> None:
    for entry in catalog.CATALOG:
        assert entry.repo_id.startswith("unsloth/")
        if entry.runner_up:
            assert entry.runner_up.repo_id.startswith("unsloth/")


def test_tier_for_repo_id() -> None:
    assert catalog.tier_for_repo_id("unsloth/Qwen3.5-9B-GGUF") == "8b"
    assert catalog.tier_for_repo_id("unsloth/qwen3.5-9b-gguf") == "8b"  # case-insensitive
    assert catalog.tier_for_repo_id("unsloth/some-custom-repo-GGUF") is None


def test_fits_now_uses_combined_vram_ram_budget() -> None:
    # 32GB VRAM (30GB usable after headroom) + 8GB RAM handily covers 6GB.
    assert catalog.fits_now(6.0, 32 * 1024, 8 * 1024) is True
    # No GPU, no RAM -> even the smallest quant doesn't fit.
    assert catalog.fits_now(6.0, None, 0) is False


def test_catalog_payload_shape_and_ordering() -> None:
    payload = catalog.catalog_payload(vram_mb=32 * 1024, ram_mb=121 * 1024)
    assert [p["tier"] for p in payload] == list(catalog.TIER_ORDER)
    entry = payload[0]
    assert entry["repo_id"] == "unsloth/Qwen3.5-9B-GGUF"
    assert entry["recommended_quant"] == "UD-Q4_K_XL"
    assert all({"q", "size_gb", "fits_now"} <= q.keys() for q in entry["quants"])
    # 8B tier's quants easily fit this generous hardware.
    assert all(q["fits_now"] for q in entry["quants"])
    # 700B tier's runner_up shape.
    tier_700 = payload[-1]
    assert tier_700["runner_up"] == {
        "repo_id": "unsloth/Kimi-K2.6-GGUF",
        "label": "Kimi K2.6 (1T/32B)",
        "is_reasoning": False,
    }


def test_catalog_payload_no_gpu_no_ram_nothing_fits() -> None:
    payload = catalog.catalog_payload(vram_mb=None, ram_mb=0)
    for entry in payload:
        assert all(q["fits_now"] is False for q in entry["quants"])


# ── is_reasoning flag ────────────────────────────────────────────────────────


def test_8b_tier_top_pick_is_reasoning_but_runner_up_is_not() -> None:
    entry = catalog.BY_TIER["8b"]
    assert entry.repo_id == "unsloth/Qwen3.5-9B-GGUF"
    assert entry.is_reasoning is True
    assert entry.runner_up is not None
    assert entry.runner_up.repo_id == "unsloth/granite-4.1-8b-GGUF"
    assert entry.runner_up.is_reasoning is False


def test_catalog_payload_carries_is_reasoning_for_entry_and_runner_up() -> None:
    payload = catalog.catalog_payload(vram_mb=None, ram_mb=0)
    tier_8b = next(p for p in payload if p["tier"] == "8b")
    assert tier_8b["is_reasoning"] is True
    assert tier_8b["runner_up"]["is_reasoning"] is False


# ── selection_default_repo_id() ──────────────────────────────────────────────


def test_selection_default_prefers_non_reasoning_runner_up() -> None:
    # The 8b tier's top pick (Qwen3.5-9B) is a reasoning model whose thinking
    # preamble eats the selection-brief's small max_tokens budget; its
    # runner-up (granite-4.1-8b) is verified non-reasoning, so it should win
    # as the selection-role recommendation.
    assert catalog.selection_default_repo_id() == "unsloth/granite-4.1-8b-GGUF"
    # The main-tier pick is untouched.
    assert catalog.BY_TIER[catalog.SELECTION_DEFAULT_TIER].repo_id == "unsloth/Qwen3.5-9B-GGUF"


def test_selection_default_falls_back_to_top_pick_without_a_non_reasoning_runner_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # If the tier's top pick isn't a reasoning model, or has no non-reasoning
    # runner-up, selection_default_repo_id() must fall back to the top pick
    # rather than recommend a reasoning runner-up (or crash on a None one).
    non_reasoning_entry = catalog.CatalogEntry(
        tier="8b",
        label="test",
        repo_id="unsloth/some-non-reasoning-8b-GGUF",
        params="8B dense",
        active_params="8B",
        ctx=8192,
        license="Apache-2.0",
        recommended_quant="Q4",
        quants=(catalog.Quant("Q4", 4.0),),
        is_reasoning=False,
        runner_up=None,
    )
    monkeypatch.setitem(catalog.BY_TIER, "8b", non_reasoning_entry)
    assert catalog.selection_default_repo_id() == "unsloth/some-non-reasoning-8b-GGUF"
