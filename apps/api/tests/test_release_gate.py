"""Guard: no release image is pushed without booting the shipped stack.

2026-09-13 (docs/decisions.md#release-gate-2026-09-13): unit tests were green
while the map sat on "loading config…" through the whole backend boot, and
docker-compose.prod.yml served "Welcome to nginx!" because nginx seeded the
shared web_dist volume with root-owned files the uid-10001 web build could not
replace. Both only show when the real images boot and a browser loads the
page, which is what .github/workflows/release-gate.yml does. These checks keep
that gate wired in, and keep the compose fix it found.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[3]
WF = REPO / ".github" / "workflows"


def _load(p: Path) -> dict:
    return yaml.safe_load(p.read_text())


def _on(doc: dict) -> dict:
    # YAML 1.1 reads a bare `on:` key as boolean True.
    return doc.get("on", doc.get(True)) or {}


def test_publish_needs_unit_and_release_gates() -> None:
    doc = _load(WF / "publish.yml")
    jobs = doc["jobs"]
    assert jobs["ci"]["uses"] == "./.github/workflows/ci.yml"
    assert jobs["release-gate"]["uses"] == "./.github/workflows/release-gate.yml"
    # Every job that can push must wait for both gates.
    for name, job in jobs.items():
        if "steps" in job:
            assert {"ci", "release-gate"} <= set(job.get("needs", [])), name


def test_gated_workflows_are_callable() -> None:
    for f in ("ci.yml", "release-gate.yml"):
        assert "workflow_call" in _on(_load(WF / f)), f


def test_release_gate_boots_prod_compose_and_runs_browser_smoke() -> None:
    doc = _load(WF / "release-gate.yml")
    assert "pull_request" in _on(doc)
    job = doc["jobs"]["compose-smoke"]
    assert job["env"]["COMPOSE_FILE"] == "docker-compose.prod.yml"
    runs = "\n".join(s.get("run", "") for s in job["steps"])
    assert "docker compose build" in runs
    assert "docker compose up -d" in runs
    assert "scripts/smoke-release.cjs" in runs
    assert (REPO / "scripts" / "smoke-release.cjs").is_file()


def test_release_gate_compiles_the_desktop_shell() -> None:
    job = _load(WF / "release-gate.yml")["jobs"]["desktop"]
    runs = "\n".join(s.get("run", "") for s in job["steps"])
    assert "pnpm --filter @osint/web build" in runs
    assert "cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml" in runs


def test_smoke_exercises_backend_down_boot() -> None:
    src = (REPO / "scripts" / "smoke-release.cjs").read_text()
    # Non-vacuous: the page must load while the api is stopped, then recover.
    assert "compose('stop', 'api')" in src
    assert "compose('start', 'api')" in src
    assert "web-build completed successfully" in src


def test_prod_nginx_waits_for_web_build_and_never_seeds_the_volume() -> None:
    nginx = _load(REPO / "docker-compose.prod.yml")["services"]["nginx"]
    assert nginx["depends_on"]["web-build"]["condition"] == "service_completed_successfully"
    mount = next(
        v for v in nginx["volumes"]
        if isinstance(v, dict) and v.get("target") == "/usr/share/nginx/html"
    )
    assert mount["source"] == "web_dist"
    assert mount["volume"]["nocopy"] is True
