"""The AI label says one thing, on both sides of the language boundary.

`case_export.AI_LABEL` guards the evidentiary document; `shell/aiLabel.tsx`
guards the panels an analyst reads all day. Two copies of a legal-ish marker in
two languages is exactly the shape that drifts — the README's test count and MCP
tool count both drifted for the same reason, and this string matters more than
either.

Same rule as test_readme_claims.py: one owner, and the copy must agree with it.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.intel.case_export import AI_LABEL

TSX = Path(__file__).resolve().parents[3] / "apps" / "web" / "src" / "shell" / "aiLabel.tsx"


def _ts_label() -> str:
    src = TSX.read_text(encoding="utf-8")
    # Anchor on the statement terminator `';`, not a bare `;` -- the label
    # itself contains one ("...as a drafting aid; a human must verify..."), and
    # a non-greedy match to the first semicolon silently truncated the string
    # to six words and compared that.
    m = re.search(r"export const AI_LABEL =\s*(.*?';)", src, re.S)
    assert m, "aiLabel.tsx lost its `export const AI_LABEL` declaration"
    # A '+'-joined run of single-quoted fragments.
    parts = re.findall(r"'([^']*)'", m.group(1))
    assert parts, "AI_LABEL is no longer a quoted string literal"
    return "".join(parts)


def test_the_two_copies_are_byte_identical() -> None:
    assert _ts_label() == AI_LABEL, (
        "The dashboard's AI label and the case export's have drifted.\n"
        f"  python: {AI_LABEL!r}\n"
        f"  tsx:    {_ts_label()!r}"
    )


def test_the_label_carries_both_load_bearing_clauses() -> None:
    """Wording may be revised; these two claims may not quietly vanish."""
    for clause in ("AI-DRAFTED", "UNVERIFIED", "Not itself evidence"):
        assert clause in AI_LABEL, f"the AI label stopped saying {clause!r}"


def test_the_label_carries_no_em_dash() -> None:
    """apps/web/CLAUDE.md: dashboard copy carries no em dashes, and this string
    is now dashboard copy as well as document copy."""
    assert "—" not in AI_LABEL
    assert "–" not in AI_LABEL
