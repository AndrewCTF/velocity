"""Guard: bundled reference data carries no contact addresses.

Upstream operator/owner free-text (WRI GPPD `owner`, SatNOGS station `name`)
ships named individuals' work emails. We redistribute these files, so
`scripts/build_places_data.py::_scrub_pii` strips addresses at build time.
This asserts the committed artifacts stay scrubbed and that the helper the
generator uses actually works.
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT / "apps" / "api" / "app" / "data"
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def _load_builder():
    path = ROOT / "scripts" / "build_places_data.py"
    spec = importlib.util.spec_from_file_location("build_places_data", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("name", ["infrastructure.json"])
def test_bundled_data_has_no_email_addresses(name: str) -> None:
    path = DATA_DIR / name
    if not path.exists():
        pytest.skip(f"{name} not built in this checkout")
    found = sorted(set(EMAIL_RE.findall(path.read_text(encoding="utf-8"))))
    assert found == [], f"{name} exposes contact addresses: {found}"


def test_infrastructure_rows_still_intact() -> None:
    """The scrub must redact fields, not drop records."""
    path = DATA_DIR / "infrastructure.json"
    if not path.exists():
        pytest.skip("infrastructure.json not built in this checkout")
    rows = json.loads(path.read_text(encoding="utf-8"))
    assert len(rows) > 120_000, f"row count collapsed to {len(rows)}"


def test_scrub_pii_strips_address_but_keeps_the_org() -> None:
    scrub = _load_builder()._scrub_pii
    assert (
        scrub("GEUK Direct LTD - Daniel Corcoran - daniel@geukdirect.com")
        == "GEUK Direct LTD - Daniel Corcoran"
    )
    assert scrub("Innogy (Wai-Kit Cheung <waikit.cheung@belectric.co.uk>)") == "Innogy (Wai-Kit Cheung)"
    assert scrub("Smarter Energy Solutions -  info@smarterenergysolutions.co.uk") == "Smarter Energy Solutions"
    # a field that is nothing but an address collapses, so callers can default it
    assert scrub("shiggy@iprimus.com.au") is None
    assert scrub("") is None
    assert scrub(None) is None
    # untouched when there is no address
    assert scrub("Kajaki Hydroelectric Power Plant") == "Kajaki Hydroelectric Power Plant"


def test_no_real_user_uuid_in_beta_sql_doc() -> None:
    """The tier-grant runbook must use placeholders, not a live auth user id."""
    doc = ROOT / "docs" / "beta-sql-commands.md"
    if not doc.exists():
        pytest.skip("beta-sql-commands.md absent")
    text = doc.read_text(encoding="utf-8")
    uuids = re.findall(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", text)
    assert uuids == [], f"live user uuid in a committed doc: {uuids}"
    real = [e for e in EMAIL_RE.findall(text) if not e.endswith("@example.com")]
    assert real == [], f"real address in a committed doc: {real}"


# The maintainer's own account and the prod Supabase project id kept getting
# pasted into dogfood/stress-test writeups. Docs are the leak site, not code.
_OPERATOR_PII = re.compile(r"andrewyong\.dev|xryong|dagqceedkxxvvbhmewca", re.I)


def test_docs_carry_no_operator_account_or_prod_project_id() -> None:
    docs = ROOT / "docs"
    if not docs.exists():
        pytest.skip("docs/ absent")
    hits = [
        f"{p.relative_to(ROOT)}:{i}"
        for p in docs.rglob("*.md")
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="ignore").splitlines(), 1)
        if _OPERATOR_PII.search(line)
    ]
    assert hits == [], f"operator account / prod project id in committed docs: {hits}"
