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
