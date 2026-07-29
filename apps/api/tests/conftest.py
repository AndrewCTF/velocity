"""Pytest fixtures: isolate test settings from real .env / env vars."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# MUST be set before any TestClient lifespan runs: `with TestClient(app)`
# executes the app lifespan, which would otherwise start the correlate
# runner's background loops — several of which fire REAL upstream HTTP
# (OpenSky, airplanes.live) on their first tick. Unit tests must never
# touch the network.
os.environ.setdefault("OSINT_DISABLE_BACKGROUND", "1")
# Deployment profiles seed environment defaults at import (app/profile.py),
# and the shipping default is `lite`, which switches features OFF. The suite
# asserts the FULL feature set, so pin it here; profile behaviour itself is
# covered by tests/test_profile.py, which drives resolve()/apply() directly.
os.environ.setdefault("OSINT_PROFILE", "full")

# The suite runs auth-disabled (no API_KEY / Supabase). Issue #8 makes the
# cost/compute endpoints (LLM, recon, OSINT, imagery-detect) FAIL CLOSED on an
# unauthenticated box unless open mode is explicitly opted into. CI is a trusted
# context, so opt in here — otherwise every compute-endpoint test would 503.
# test_security_hardening.py re-checks the closed behavior with the flag forced
# off, so this default does not hide the guard.
os.environ.setdefault("ALLOW_UNAUTHENTICATED", "1")

from app.config import Settings, get_settings  # noqa: E402
from app.main import create_app  # noqa: E402

# One tile-cache dir per test session — _test_settings() is called per
# request via dependency_overrides, and a fresh mkdtemp per call would
# defeat the disk cache the tile tests assert on.
_TEST_TILE_DIR = tempfile.mkdtemp(prefix="osint-test-tiles-")


def _test_settings() -> Settings:
    return Settings(
        cesium_ion_token="test-ion-token",
        enable_google_3d=False,
        classification="UNCLAS",
        build_id="test",
        opensky_client_id="",
        opensky_client_secret="",
        aisstream_key="",
        firms_map_key="",
        gfw_token="",
        cdse_client_id="",
        cdse_client_secret="",
        gmaps_key="",
        database_url="postgresql+asyncpg://test:test@localhost:5432/test",
        redis_url="redis://localhost:6379/0",
        cors_origins="http://localhost:8080",
        tile_cache_dir=_TEST_TILE_DIR,
    )


@pytest.fixture(autouse=True)
def _neutralise_minimax(monkeypatch: pytest.MonkeyPatch) -> None:
    """MiniMax-M3 is the PRIMARY LLM backend, configured from env
    (NVIDIA_API_KEY) which the dev .env now carries. Unit tests must stay
    hermetic (no network) and were written for the DeepSeek→Ollama fallback
    chain, so default MiniMax to *unconfigured* here. A test that wants to
    exercise it can re-patch ``llm.minimax_config``.
    """
    from app import llm

    monkeypatch.setattr(
        llm,
        "minimax_config",
        lambda: (None, "https://integrate.api.nvidia.com/v1", "minimaxai/minimax-m3"),
    )


@pytest.fixture(autouse=True)
def _isolate_ontology_db(tmp_path: Path) -> Iterator[None]:
    """Point the local ontology store at a per-test temp file.

    Route handlers call ``get_settings()`` directly (not via Depends), so the
    ``dependency_overrides`` above never reach the DB path — without this hook
    every route test would write ``./data/ontology.db`` into the repo, and
    tests would see each other's graphs.
    """
    from app.intel import ontology_local

    ontology_local.override_db_path(str(tmp_path / "ontology.db"))
    yield
    ontology_local.override_db_path(None)


@pytest.fixture(autouse=True)
def _isolate_foundry_db(tmp_path: Path) -> Iterator[None]:
    """Point the Foundry store at a per-test temp file (mirrors ontology)."""
    from app.foundry import store as foundry_store

    foundry_store.override_db_path(str(tmp_path / "foundry.db"))
    yield
    foundry_store.override_db_path(None)


@pytest.fixture(autouse=True)
def _isolate_history_db(tmp_path: Path) -> Iterator[None]:
    """Point the history archive at a per-test temp file.

    This was the ONE store with no isolation fixture, and it is the one that can
    destroy real data. ``history.py`` exposes ``prune``, ``decimate``,
    ``enforce_size_cap`` and ``_vacuum``, and ``test_history.py`` drives all of
    them; its own per-test ``_reset_module`` sets an override and its ``finally``
    clears it back to ``None`` — which restores the REAL path,
    ``./data/history.db``, resolved against the repo root the suite runs from.
    Any later test in that worker that reaches a destructive helper without
    re-overriding hits the operator's live archive.

    Observed 2026-07-28: ``data/history.db`` went from 2.7 GB to 22 MB over a
    session in which the suite ran six times and the backend's own hourly
    maintenance pass never came due (``next_prune`` is start + 3600 s and no boot
    lasted an hour). Autouse isolation makes the whole class impossible rather
    than relying on every test remembering.

    ``HISTORY_ROOTS`` is cleared for the same reason: a developer with roots
    configured in their environment must not have the suite write into them.
    """
    from app import history

    prev_roots = os.environ.pop("HISTORY_ROOTS", None)
    get_settings.cache_clear()
    history.override_db_path(str(tmp_path / "history.db"))
    yield
    history.override_db_path(None)
    if prev_roots is not None:
        os.environ["HISTORY_ROOTS"] = prev_roots
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _isolate_workflows_db(tmp_path: Path) -> Iterator[None]:
    """Point the Workflows store at a per-test temp file (mirrors foundry)."""
    from app.workflows import store as workflows_store

    workflows_store.override_db_path(str(tmp_path / "workflows.db"))
    yield
    workflows_store.override_db_path(None)


@pytest.fixture(autouse=True)
def _isolate_alert_rules_db(tmp_path: Path) -> Iterator[None]:
    """Point the local alert-rules store at a per-test temp file (mirrors
    ontology/foundry/workflows) — without this every keyless-rule test would
    write ``./data/alert_rules.db`` into the repo and see other tests' rules."""
    from app.intel import alert_rules_local

    alert_rules_local.override_db_path(str(tmp_path / "alert_rules.db"))
    yield
    alert_rules_local.override_db_path(None)


@pytest.fixture(autouse=True)
def _isolate_audit_db(tmp_path: Path) -> Iterator[None]:
    """Point the local audit-log fallback at a per-test temp file (mirrors
    ontology/foundry/workflows/alert_rules) — without this, every test that
    exercises an audited route on this keyless (no-Supabase) test boot would
    write ``./data/audit_log.db`` into the repo."""
    from app import audit as audit_mod

    audit_mod.override_db_path(str(tmp_path / "audit_log.db"))
    yield
    audit_mod.override_db_path(None)


@pytest.fixture(autouse=True)
def _isolate_evidence_dir(tmp_path: Path) -> Iterator[None]:
    """Point the evidence-locker blob dir at a per-test temp dir (mirrors the
    ontology/foundry isolation) — route handlers resolve ``evidence_dir`` via
    the cached ``get_settings()``, so without this every capture test would
    write ``./data/evidence`` into the repo and see other tests' blobs."""
    from app.intel import evidence as evidence_mod

    evidence_mod.override_evidence_dir(str(tmp_path / "evidence"))
    yield
    evidence_mod.override_evidence_dir(None)


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = create_app()
    app.dependency_overrides[get_settings] = _test_settings
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.clear()
