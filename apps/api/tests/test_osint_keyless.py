"""Guard: investigate/recon stay reachable on a keyless deployment, and the
SEC EDGAR connector returns a plain name + real CIK instead of a stringified
list.

Regression covered:
  - osint.py used ``Depends(current_user)`` (strict, 401s with no bearer
    token) on /api/osint/investigate and /api/osint/recon, the two routes this
    self-hosted keyless product markets as its flagship feature. Fixed to
    ``current_user_or_local`` (degrades to a shared local identity only when
    Supabase is entirely unconfigured — same contract as ontology/situations).
  - corp.py's sec_edgar_company() called str() on the EDGAR ``display_names``
    field BEFORE unwrapping it from a list, so a real hit produced a name like
    "['Tesla, Inc.  (TSLA)  (CIK 0001318605)']" and mined the CIK from the doc
    _id (an accession:file id) instead of the real ``ciks`` field.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

import app.osint.sources.corp as corp
from app.config import get_settings
from app.main import create_app
from tests.conftest import _test_settings


@pytest.fixture
def keyless_client() -> TestClient:
    """A client on the exact settings this product ships keyless: no API_KEY,
    no Supabase, ALLOW_UNAUTHENTICATED=1 (set process-wide by conftest.py so
    the compute-path gate in ApiKeyMiddleware doesn't 503 before the route)."""
    app = create_app()
    app.dependency_overrides[get_settings] = _test_settings
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_investigate_not_401_on_keyless_box(keyless_client: TestClient) -> None:
    # No Authorization header, no X-API-Key — a strict current_user dependency
    # would 401 here before validation ever runs. current_user_or_local
    # degrades to the shared "local" identity instead, so an invalid target
    # reaches target validation and reports 400, never 401.
    r = keyless_client.post("/api/osint/investigate", json={"target": "not a target"})
    assert r.status_code != 401
    assert r.status_code == 400


def test_recon_not_401_on_keyless_box(keyless_client: TestClient) -> None:
    # OSINT_RECON_SIDECAR_URL is unset in test settings, so a valid target
    # reaches the sidecar-configured check and reports 503 — never 401.
    r = keyless_client.post(
        "/api/osint/recon", json={"target": "example.com", "tool": "amass"}
    )
    assert r.status_code != 401
    assert r.status_code == 503


# ── sec_edgar_company name/CIK extraction ───────────────────────────────────

async def test_sec_edgar_unwraps_display_names_before_stringifying(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Real EDGAR full-text-search shape: display_names is a list, and the CIK
    lives in the plural "ciks" list (there is no singular "cik" field)."""

    async def fake_fetch_json(url: str, ttl: float, *, headers=None, browser_ua=False) -> Any:
        if "efts.sec.gov" in url:
            return {
                "hits": {
                    "hits": [
                        {
                            "_id": "0001628280-25-003063:tsla-2024x12x31xex211.htm",
                            "_source": {
                                "ciks": ["0001318605"],
                                "display_names": [
                                    "Tesla, Inc.  (TSLA)  (CIK 0001318605)"
                                ],
                            },
                        }
                    ]
                }
            }
        if "data.sec.gov/submissions" in url:
            # Simulate submissions lookup failing so the connector falls back
            # to the entity_name it parsed out of the search hit.
            return None
        return None

    monkeypatch.setattr(corp, "fetch_json", fake_fetch_json)

    out = await corp.sec_edgar_company("Tesla")

    # The bug produced "['Tesla, Inc.  (TSLA)  (CIK 0001318605)']" — a
    # stringified Python list — as the name.
    assert out["name"] == "Tesla, Inc.  (TSLA)  (CIK 0001318605)"
    assert not out["name"].startswith("[")
    # The bug mined "cik" from the doc _id (an accession:file id) since the
    # real payload has no singular "cik" field, producing digit garbage.
    assert out["cik"] == "1318605"
