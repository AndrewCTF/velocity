"""Unit tests for app/osint/sources/corp.py — no live network, per-URL fakes."""

from __future__ import annotations

from typing import Any

import app.osint.sources.corp as corp


def _patch_fetch(monkeypatch, table: dict[str, Any]) -> None:
    """Monkeypatch fetch_json with an async fake keyed by url-prefix match."""

    async def fake_fetch_json(url: str, ttl: float, *, headers=None, browser_ua=False):
        for prefix, value in table.items():
            if url.startswith(prefix):
                return value
        return None

    monkeypatch.setattr(corp, "fetch_json", fake_fetch_json)


# ── sec_edgar_company ────────────────────────────────────────────────────────

async def test_sec_edgar_company_happy_path(monkeypatch) -> None:
    table = {
        "https://efts.sec.gov/LATEST/search-index": {
            "hits": {"hits": [
                {"_id": "0000320193", "_source": {"cik": "0000320193", "display_names": ["Apple Inc."]}}
            ]}
        },
        "https://data.sec.gov/submissions/CIK0000320193.json": {
            "name": "Apple Inc.",
            "tickers": ["AAPL"],
            "sicDescription": "Electronic Computers",
            "filings": {"recent": {
                "form": ["10-K", "8-K"],
                "filingDate": ["2024-11-01", "2024-08-01"],
                "accessionNumber": ["0000320193-24-000123", "0000320193-24-000099"],
            }},
        },
    }
    _patch_fetch(monkeypatch, table)

    out = await corp.sec_edgar_company("Apple")

    assert out["name"] == "Apple Inc."
    assert out["cik"] == "320193"
    assert out["ticker"] == "AAPL"
    assert out["sic"] == "Electronic Computers"
    assert out["count"] == 2
    assert out["filings"][0] == {
        "form": "10-K", "date": "2024-11-01", "accession": "0000320193-24-000123"
    }
    assert "note" not in out


async def test_sec_edgar_company_degrades_to_note_when_search_fails(monkeypatch) -> None:
    async def fake_fetch_json(url, ttl, *, headers=None, browser_ua=False):
        return None

    monkeypatch.setattr(corp, "fetch_json", fake_fetch_json)

    out = await corp.sec_edgar_company("Some Obscure Co")

    assert out["cik"] == ""
    assert out["filings"] == []
    assert out["count"] == 0
    assert "note" in out


async def test_sec_edgar_company_empty_name_short_circuits(monkeypatch) -> None:
    async def boom(*a, **kw):  # should never be called
        raise AssertionError("fetch_json should not be called for an empty name")

    monkeypatch.setattr(corp, "fetch_json", boom)

    out = await corp.sec_edgar_company("   ")
    assert out["count"] == 0
    assert out["note"] == "empty name"


# ── opensanctions_search ─────────────────────────────────────────────────────

async def test_opensanctions_search_normalises_matches(monkeypatch) -> None:
    table = {
        "https://api.opensanctions.org/search/default": {
            "results": [
                {
                    "id": "Q123",
                    "caption": "Jane Doe",
                    "schema": "Person",
                    "properties": {"topics": ["sanction", "pep"]},
                    "datasets": ["us_ofac_sdn", "eu_fsf"],
                },
                {"id": "not-a-dict-safe"},
            ]
        }
    }
    _patch_fetch(monkeypatch, table)

    out = await corp.opensanctions_search("Jane Doe")

    assert out["query"] == "Jane Doe"
    assert out["count"] == 2
    first = out["matches"][0]
    assert first == {
        "id": "Q123",
        "name": "Jane Doe",
        "schema": "Person",
        "topics": ["sanction", "pep"],
        "datasets": ["us_ofac_sdn", "eu_fsf"],
    }


async def test_opensanctions_search_degrades_on_bad_shape(monkeypatch) -> None:
    _patch_fetch(monkeypatch, {"https://api.opensanctions.org/search/default": {"oops": True}})

    out = await corp.opensanctions_search("Nobody")

    assert out["matches"] == []
    assert out["count"] == 0
    assert out["note"] == "opensanctions unavailable"


# ── opencorporates_search ────────────────────────────────────────────────────

async def test_opencorporates_search_normalises_companies(monkeypatch) -> None:
    table = {
        "https://api.opencorporates.com/v0.4/companies/search": {
            "results": {"companies": [
                {"company": {
                    "name": "Acme Corp",
                    "company_number": "12345",
                    "jurisdiction_code": "us_de",
                    "current_status": "Active",
                }},
                {"company": None},
            ]}
        }
    }
    _patch_fetch(monkeypatch, table)

    out = await corp.opencorporates_search("Acme")

    assert out["count"] == 1
    assert out["companies"][0] == {
        "name": "Acme Corp", "number": "12345", "jurisdiction": "us_de", "status": "Active"
    }
    # No api_token configured -> keyless note present.
    assert out.get("note") == "keyless request, may be throttled"


async def test_opencorporates_search_degrades_when_unavailable(monkeypatch) -> None:
    _patch_fetch(monkeypatch, {})  # no match -> fetch_json returns None

    out = await corp.opencorporates_search("Ghost Inc")

    assert out["companies"] == []
    assert out["count"] == 0
    assert "note" in out


# ── openownership_search ─────────────────────────────────────────────────────

async def test_openownership_search_degrades_to_note_on_unusable_shape(monkeypatch) -> None:
    _patch_fetch(monkeypatch, {"https://api.openownership.org/v0.4.0/search": {"weird": "shape"}})

    out = await corp.openownership_search("Acme Trust")

    assert out == {"query": "Acme Trust", "owners": [], "count": 0, "note": "unavailable"}


async def test_openownership_search_pulls_name_type_defensively(monkeypatch) -> None:
    table = {
        "https://api.openownership.org/v0.4.0/search": {
            "statements": [
                {"entity": {"name": "Acme Holdings Ltd", "type": "legalEntity"}},
                {"name": "John Smith", "statementType": "personStatement"},
            ]
        }
    }
    _patch_fetch(monkeypatch, table)

    out = await corp.openownership_search("Acme")

    assert out["count"] == 2
    assert {"name": "Acme Holdings Ltd", "type": "legalEntity"} in out["owners"]
    assert {"name": "John Smith", "type": "personStatement"} in out["owners"]


# ── aleph_search ──────────────────────────────────────────────────────────────

async def test_aleph_search_normalises_entities(monkeypatch) -> None:
    table = {
        "https://aleph.occrp.org/api/2/entities": {
            "results": [
                {
                    "id": "abc123",
                    "schema": "Company",
                    "properties": {"name": ["Shell Co"]},
                    "collection": {"label": "Panama Papers"},
                }
            ]
        }
    }
    _patch_fetch(monkeypatch, table)

    out = await corp.aleph_search("Shell Co")

    assert out["count"] == 1
    assert out["entities"][0] == {
        "id": "abc123", "name": "Shell Co", "schema": "Company", "collection": "Panama Papers"
    }


# ── wikidata_search ───────────────────────────────────────────────────────────

async def test_wikidata_search_normalises_entities(monkeypatch) -> None:
    table = {
        "https://www.wikidata.org/w/api.php": {
            "search": [
                {"id": "Q95", "label": "Google", "description": "American technology company"}
            ]
        }
    }
    _patch_fetch(monkeypatch, table)

    out = await corp.wikidata_search("Google")

    assert out["count"] == 1
    assert out["entities"][0] == {
        "qid": "Q95", "label": "Google", "description": "American technology company"
    }


async def test_wikidata_search_degrades_when_unavailable(monkeypatch) -> None:
    _patch_fetch(monkeypatch, {})

    out = await corp.wikidata_search("Nonexistent Thing")

    assert out["entities"] == []
    assert out["count"] == 0
    assert out["note"] == "wikidata unavailable"
