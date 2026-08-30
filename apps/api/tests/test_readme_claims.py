"""The countable claims in README.md must match the thing they count.

README.md:50 advertised 2255 passing tests against a real baseline of 2559, and
README.md:407 advertised 84 MCP tools against a registry of 85. Both drifted
silently because nothing connected the prose to the source, and a stale badge is
the first thing a reader checks on a project whose whole pitch is that it tells
you the truth about its data.

These are cheap structural checks, not a substitute for running the suite: a
test cannot know its own total pass count. So the rule is that every number has
exactly one owner and the copies must agree with it.

  MCP tool count  -> the registry itself (same source test_mcp_http_mount uses)
  app count       -> state/appView.ts APP_IDS
  test baseline   -> /CLAUDE.md, which is where the operator records it

Adding a countable claim to the README means adding it here.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "README.md"
CLAUDE_MD = ROOT / "CLAUDE.md"
APP_VIEW = ROOT / "apps" / "web" / "src" / "state" / "appView.ts"

WORD_NUMBERS = {
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
}


@pytest.fixture(scope="module")
def readme() -> str:
    return README.read_text(encoding="utf-8")


def test_the_mcp_tool_count_matches_the_registry(readme: str) -> None:
    """README.md:407 vs the tools actually registered on the server."""
    from app import mcp_server

    registered = len(mcp_server.mcp._tool_manager._tools)  # noqa: SLF001
    claimed = re.search(r"It exposes (\d+) tools over `app\.mcp_server`", readme)
    assert claimed, "README lost its 'It exposes N tools over `app.mcp_server`' line"
    assert int(claimed.group(1)) == registered, (
        f"README claims {claimed.group(1)} MCP tools, the registry has {registered}. "
        "Update README.md and test_mcp_http_mount.py's exact-count assertion together."
    )


def test_the_app_count_matches_the_registry(readme: str) -> None:
    """README.md:164 vs APP_IDS, the single source of truth for the launcher."""
    src = APP_VIEW.read_text(encoding="utf-8")
    block = re.search(r"export const APP_IDS[^=]*=\s*\[(.*?)\]", src, re.S)
    assert block, "APP_IDS array not found in state/appView.ts"
    real = len(re.findall(r"'[a-z0-9]+'", block.group(1)))
    claimed = re.search(r"workspace of ([a-z]+) apps", readme)
    assert claimed, "README lost its 'workspace of N apps' line"
    word = claimed.group(1)
    assert word in WORD_NUMBERS, f"unhandled number word in README: {word!r}"
    assert WORD_NUMBERS[word] == real, (
        f"README says {word} ({WORD_NUMBERS[word]}) apps, APP_IDS has {real}"
    )


def test_the_test_baseline_agrees_with_claude_md(readme: str) -> None:
    """The badge, the Tests section, and /CLAUDE.md must all say one number.

    CLAUDE.md owns the baseline - it is where the operator records it and where
    the rule 'never commit below the baseline you inherited' lives. The README
    carries two copies of it and both drifted 304 tests behind.
    """
    owner = re.search(r"Baseline:\s*\*\*(\d+) passed \+ (\d+) skipped", CLAUDE_MD.read_text(encoding="utf-8"))
    assert owner, "CLAUDE.md lost its 'Baseline: **N passed + M skipped**' line"
    passed, skipped = owner.group(1), owner.group(2)

    badge = re.search(r"tests-(\d+)%20passing", readme)
    assert badge, "README lost its tests badge"
    assert badge.group(1) == passed, (
        f"README badge says {badge.group(1)} passing, CLAUDE.md baseline says {passed}"
    )

    prose = re.search(r"pytest apps/api -q\s*#\s*(\d+) passed \+ (\d+) skipped", readme)
    assert prose, "README lost the pytest line in its Tests section"
    assert (prose.group(1), prose.group(2)) == (passed, skipped), (
        f"README Tests section says {prose.group(1)}+{prose.group(2)}, "
        f"CLAUDE.md baseline says {passed}+{skipped}"
    )
