"""Organisation resolution: attribution, partial failure, and the name trap."""

from __future__ import annotations

import pytest

from app.intel import orgs
from app.intel.sanctions import SanctionsIndex, parse_sdn_csv, search_names

SDN = (
    '1001,"JOINT STOCK COMPANY SOVCOMFLOT",-0- ,"[RUSSIA-EO14024]",-0- ,-0- ,-0- ,-0- ,-0- ,'
    '-0- ,-0- ,"State shipping company."\n'
    '1002,"PJSC SOVCOMFLOT",-0- ,"[UKRAINE-EO13662]",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n'
    '1003,"UNRELATED HOLDINGS",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n'
)


def test_an_organisation_search_is_substring_where_a_hull_search_is_not() -> None:
    # OFAC lists "PJSC SOVCOMFLOT"; an operator types "Sovcomflot". An exact fold
    # answers "not designated", which is both wrong and confident.
    idx = parse_sdn_csv(SDN)
    hits = search_names(idx, "Sovcomflot")
    assert {d.name for d in hits} == {
        "JOINT STOCK COMPANY SOVCOMFLOT",
        "PJSC SOVCOMFLOT",
    }
    assert search_names(idx, "UNRELATED")[0].name == "UNRELATED HOLDINGS"


def test_a_short_query_matches_nothing_rather_than_everything() -> None:
    # Two characters would substring-match a large share of 15k folded names and
    # return noise that looks like a finding.
    idx = parse_sdn_csv(SDN)
    assert search_names(idx, "PJ") == []
    assert search_names(idx, "") == []


def test_an_exact_fold_sorts_above_a_longer_substring_hit() -> None:
    idx = SanctionsIndex(fetched_at=0.0, rows=0)
    idx.merge(parse_sdn_csv(SDN))
    hits = search_names(idx, "PJSC SOVCOMFLOT")
    assert hits[0].name == "PJSC SOVCOMFLOT"


@pytest.mark.asyncio
async def test_a_dead_source_is_named_rather_than_read_as_an_empty_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The defect this guards: a resolution that silently drops EDGAR and returns
    # "no filings" is a CLAIM, not an absence, and a screening tool must never
    # make it.
    async def ok_lei(name: str, limit: int = 10) -> list[dict[str, object]]:
        return [{"lei": "X", "legal_name": name, "source": "GLEIF"}]

    async def dead(name: str, limit: int = 10) -> list[dict[str, object]]:
        raise RuntimeError("upstream 503")

    async def no_sanctions(name: str) -> None:
        return None

    monkeypatch.setattr(orgs, "gleif", ok_lei)
    monkeypatch.setattr(orgs, "edgar", dead)
    monkeypatch.setattr(orgs, "usaspending", dead)
    monkeypatch.setattr(orgs, "_sanctions", no_sanctions)

    out = await orgs._resolve("ACME", 10)
    assert out["reached"] == ["GLEIF", "sanctions"]
    assert set(out["failed"]) == {"SEC EDGAR", "USAspending"}
    assert out["filings"] == []
    assert out["awards"] == []
    # The point: the caller can tell those two empties apart from GLEIF's answer.
    assert len(out["lei"]) == 1


@pytest.mark.asyncio
async def test_every_source_answering_is_also_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    async def empty(name: str, limit: int = 10) -> list[dict[str, object]]:
        return []

    async def no_sanctions(name: str) -> None:
        return None

    monkeypatch.setattr(orgs, "gleif", empty)
    monkeypatch.setattr(orgs, "edgar", empty)
    monkeypatch.setattr(orgs, "usaspending", empty)
    monkeypatch.setattr(orgs, "_sanctions", no_sanctions)

    out = await orgs._resolve("NOBODY", 10)
    assert out["failed"] == {}
    assert len(out["reached"]) == 4
    # Four sources looked and none of them had anything. That is a result.
    assert out["lei"] == [] and out["filings"] == [] and out["awards"] == []
    assert out["sanctions"] is None
