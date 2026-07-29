"""Guards: the agent surface exposes the four new capabilities, with their caveats.

No competitor surveyed in docs/research-last30days-2026-07-29.md §1.1 exposes
anything an agent can drive, so this is differentiating surface rather than
parity work. But an MCP tool description IS the prompt the model reads, and
three of these return values that are easy to misreport:

  - an answer of "unknown" is a real answer, and a null `data_lag_s` means no
    evidence was observed, never "fresh";
  - an uncorroborated contact is not a confirmed one;
  - `recorded: false` on a history diff means an empty archive, not a quiet
    period;
  - a missing optional key is not a defect.

Each of those inversions would turn a careful backend into a confident wrong
answer at the last hop, so the descriptions are pinned here.
"""

from __future__ import annotations

import asyncio

from app.mcp_server import mcp

_NEW = {"answer", "contact_provenance", "history_diff", "system_doctor"}


def _tools() -> dict[str, str]:
    listed = asyncio.run(mcp.list_tools())
    return {t.name: (t.description or "") for t in listed}


def test_the_new_capabilities_are_registered() -> None:
    names = set(_tools())
    missing = _NEW - names
    assert not missing, f"MCP is missing {missing}"


def test_every_tool_has_a_description() -> None:
    """An undescribed tool is one the model will not choose correctly."""
    for name, desc in _tools().items():
        assert desc.strip(), f"{name} has no description"


def test_answer_tool_warns_against_reading_null_lag_as_fresh() -> None:
    d = _tools()["answer"]
    assert "unknown" in d
    assert "null" in d and "fresh" in d
    assert "stale" in d


def test_provenance_tool_warns_against_presenting_uncorroborated_as_confirmed() -> None:
    d = _tools()["contact_provenance"]
    assert "exclusive" in d
    assert "corroborated" in d
    assert "confirmed" in d


def test_history_diff_tool_distinguishes_empty_archive_from_no_change() -> None:
    d = _tools()["history_diff"]
    assert "recorded" in d
    assert "not the same as" in d or "NOT the same" in d


def test_doctor_tool_says_a_missing_optional_key_is_not_a_defect() -> None:
    d = _tools()["system_doctor"]
    assert "optional" in d
    assert "keyless" in d


def test_tool_count_only_grows() -> None:
    """A floor, not an exact count: adding tools is fine, silently losing one is
    the regression worth catching."""
    assert len(_tools()) >= 50
