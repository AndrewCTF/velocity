"""Guard: dependencies whose imports we do at module scope must have upper bounds.

On 2026-07-29 `mcp` 2.0.0 was published. pyproject asked for an unbounded
`mcp>=1.2.0`, and CI installs with `pip install -e ".[dev]"`, which ignores
uv.lock and resolves the newest match. 2.x moved `mcp.server.fastmcp`, which
app/mcp_server.py imports at module scope and app/main.py imports in turn, so
the entire suite died at conftest import with ModuleNotFoundError.

No commit caused it and none could be reverted to fix it: master carried the
same unbounded pin and would have failed on its next scheduled run. An unbounded
pin on a package we import at module scope is a scheduled outage, so it is worth
a test rather than a memory.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

# Packages this app imports at MODULE scope, where a major-version bump takes the
# whole process down at import rather than failing one feature at runtime.
_IMPORT_CRITICAL = {"mcp", "fastapi", "pydantic", "httpx"}

# Known-unbounded, deliberately NOT changed here.
#
# Writing the mcp guard surfaced three more of exactly the same shape. Pinning
# the web framework and validation layer is a real decision with real upgrade
# consequences, and it is well outside the change that was asked for, so it is
# recorded rather than done: CLAUDE.md's "change the minimum, name what you
# skipped". uv.lock already resolves all three, so a uv-based install is safe
# today and only the pip path in CI is exposed.
#
# To close this: pin each to its current major, or move CI to `uv sync --frozen`
# so the lockfile is what installs. The second is the better fix and it fixes all
# four at once.
_KNOWN_UNBOUNDED = {"fastapi", "pydantic", "httpx"}


def _deps() -> list[str]:
    root = Path(__file__).resolve().parents[1] / "pyproject.toml"
    data = tomllib.loads(root.read_text(encoding="utf-8"))
    return list(data.get("project", {}).get("dependencies", []))


def test_no_new_unbounded_import_critical_dep() -> None:
    """Ratchet, not a sweep.

    Fails when a module-scope import gains an unbounded pin that is not already
    on the recorded-debt list, so the mcp outage cannot recur quietly under a
    different package name. The existing three stay listed and untouched.
    """
    offenders: list[str] = []
    for spec in _deps():
        name = re.split(r"[\[<>=!~ ]", spec.strip(), maxsplit=1)[0].lower()
        if name not in _IMPORT_CRITICAL or name in _KNOWN_UNBOUNDED:
            continue
        if "<" not in spec:
            offenders.append(spec)
    assert not offenders, (
        "imported at module scope with no upper bound, so the next major release "
        f"breaks the suite with no commit to blame: {offenders}"
    )


def test_the_recorded_debt_list_stays_honest() -> None:
    """If someone pins one of the three, this fails and tells them to shorten the
    list, so the comment cannot rot into describing a problem that is fixed."""
    still_unbounded = set()
    for spec in _deps():
        name = re.split(r"[\[<>=!~ ]", spec.strip(), maxsplit=1)[0].lower()
        if name in _KNOWN_UNBOUNDED and "<" not in spec:
            still_unbounded.add(name)
    fixed = _KNOWN_UNBOUNDED - still_unbounded
    assert not fixed, f"now bounded, remove from _KNOWN_UNBOUNDED: {sorted(fixed)}"


def test_mcp_stays_below_the_2x_restructure() -> None:
    """Explicit, because this is the one that actually fired. Moving to 2.x means
    porting the FastMCP import and the tool registrations, not widening this."""
    spec = next((d for d in _deps() if d.strip().lower().startswith("mcp")), None)
    assert spec is not None, "mcp dependency disappeared from pyproject"
    assert "<2" in spec.replace(" ", ""), f"mcp must stay below 2.x, got {spec!r}"
