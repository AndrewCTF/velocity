"""Guard: the Claude Code plugin (plugin/osint-geoint) stays internally valid.

The plugin bundles the MCP server + skill + commands + agent. These are static
files that Claude Code loads, so nothing else exercises them — this test is the
runnable check that the manifests parse and every referenced path exists, so a
rename or a typo can't silently break the install.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
PLUGIN = REPO / "plugin" / "osint-geoint"


def _load(p: Path) -> dict:
    return json.loads(p.read_text())


def test_marketplace_lists_the_plugin() -> None:
    mkt = _load(REPO / ".claude-plugin" / "marketplace.json")
    assert mkt["name"] and mkt["owner"]["name"]
    entry = next(p for p in mkt["plugins"] if p["name"] == "osint-geoint")
    # marketplace `source` paths are relative to the marketplace ROOT (repo root).
    src = (REPO / entry["source"]).resolve()
    assert src == PLUGIN.resolve()
    assert (PLUGIN / ".claude-plugin" / "plugin.json").is_file()


def test_plugin_manifest_paths_resolve() -> None:
    man = _load(PLUGIN / ".claude-plugin" / "plugin.json")
    assert man["name"] == "osint-geoint"
    # mcpServers points at a real .mcp.json inside the plugin.
    assert man["mcpServers"] == "./.mcp.json"
    assert (PLUGIN / ".mcp.json").is_file()
    # Bundled component dirs exist and are non-empty.
    assert list((PLUGIN / "skills").glob("*/SKILL.md"))
    assert list((PLUGIN / "commands").glob("*.md"))
    assert list((PLUGIN / "agents").glob("*.md"))
    # Required user-config fields for the cross-platform python-direct launch.
    assert man["userConfig"]["repo_dir"]["required"] is True
    assert man["userConfig"]["python"]["required"] is True


def test_mcp_json_launches_python_module_cross_platform() -> None:
    """The plugin launches the venv Python directly (no shell launcher), so the
    same manifest works on Windows, macOS and Linux."""
    mcp = _load(PLUGIN / ".mcp.json")
    srv = mcp["mcpServers"]["osint-geoint"]
    assert srv["command"] == "${user_config.python}"
    assert srv["args"] == ["-m", "app.mcp_server"]
    assert srv["cwd"] == "${user_config.repo_dir}/apps/api"
    assert srv["env"]["PYTHONPATH"] == "${user_config.repo_dir}/apps/api"
    # No bash launcher is bundled (it wouldn't run on Windows).
    assert not (PLUGIN / "bin").exists()


def test_skill_frontmatter_present() -> None:
    skill = PLUGIN / "skills" / "osint-intel" / "SKILL.md"
    text = skill.read_text()
    assert text.startswith("---")
    head = text.split("---", 2)[1]
    assert "name:" in head and "description:" in head
    # Progressive-disclosure references exist.
    assert (skill.parent / "reference" / "tools.md").is_file()
    assert (skill.parent / "reference" / "workflows.md").is_file()
    # The short/long convention is taught in the skill.
    assert "detail='short'" in text or "detail=" in text


@pytest.mark.parametrize("cmd", ["osint-brief", "osint-watch", "osint-jamming"])
def test_commands_have_description(cmd: str) -> None:
    text = (PLUGIN / "commands" / f"{cmd}.md").read_text()
    assert text.startswith("---") and "description:" in text.split("---", 2)[1]


def test_cross_platform_installers() -> None:
    import os

    for f in ["install.sh", "install.ps1", "install.cmd", "install.command"]:
        assert (PLUGIN / f).is_file(), f"missing installer {f}"
    # POSIX shell installers must keep the exec bit (macOS .command double-click
    # silently fails without it — a real defect the review caught).
    for f in ["install.sh", "install.command"]:
        assert os.access(PLUGIN / f, os.X_OK), f"{f} must be executable"
    # A BOM-less .ps1 is parsed with the ANSI codepage on Windows PowerShell 5.1,
    # so any non-ASCII byte mojibakes at parse time — keep it pure ASCII.
    assert (PLUGIN / "install.ps1").read_bytes().isascii(), "install.ps1 must be ASCII"
