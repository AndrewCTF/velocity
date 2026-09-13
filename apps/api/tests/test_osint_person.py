"""Person/identity OSINT: target classification + graph minting."""

from __future__ import annotations

import time

import pytest

from app.osint.fetch import (
    classify_target,
    normalise_coordinate,
    normalise_email,
    normalise_phone,
    normalise_username,
)
from app.routes import osint as O


@pytest.fixture(autouse=True)
def _offline_stealer(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the fan-out off the network.

    ``_investigate_email`` / ``_investigate_username`` gained a Hudson Rock call
    in the 2026-08-29 wave. Without this the tests in this file reach a live
    upstream, which makes them slow and makes them fail on a plane.
    """
    async def clean(indicator: str) -> dict:
        return {"indicator": indicator, "checked": True, "infected": False,
                "computer_count": 0, "computers": []}

    monkeypatch.setattr(O.stealer, "hudsonrock_email", clean)
    monkeypatch.setattr(O.stealer, "hudsonrock_username", clean)


def test_classify_target_kinds() -> None:
    assert classify_target("1.2.3.4") == ("ip", "1.2.3.4")
    assert classify_target("Alice@Example.COM") == ("email", "alice@example.com")
    assert classify_target("example.com") == ("domain", "example.com")
    assert classify_target("torvalds") == ("username", "torvalds")
    assert classify_target("@torvalds") == ("username", "torvalds")
    assert classify_target("!!!") is None


def test_normalise_edge_cases() -> None:
    assert normalise_email("a@b.co") == "a@b.co"
    assert normalise_email("no-at-sign") is None
    assert normalise_username("has.dot") is None  # a dot means domain, not handle
    assert normalise_username("a" * 40) is None  # over GitHub's 39-char ceiling


async def test_investigate_username_mints_person(monkeypatch) -> None:
    async def fake_gh(u):
        return {"username": u, "found": True, "name": "Linus Torvalds",
                "email": "linus@example.org", "company": "Linux",
                "profile_url": "https://github.com/torvalds"}

    async def fake_gl(u):
        return {"username": u, "found": False}

    async def fake_sites(u):
        return {"username": u, "sites": {"github": True}, "present_on": ["github"]}

    monkeypatch.setattr(O.C, "lookup_github_user", fake_gh)
    monkeypatch.setattr(O.C, "lookup_gitlab_user", fake_gl)
    monkeypatch.setattr(O.C, "lookup_username_sites", fake_sites)

    g = O._Graph(ts=time.time())
    summary = await O._investigate_username(g, "torvalds")

    assert "username:torvalds" in g.objs
    assert "person:linus-torvalds" in g.objs
    assert "email:linus@example.org" in g.objs  # verified GH email bridges in
    assert summary["github"] is True
    assert summary["present_on"] == ["github"]
    # person → username link exists
    assert any(lk.src == "person:linus-torvalds" and lk.rel == "has_account"
               for lk in g.links.values())


async def test_investigate_email_links_gravatar_accounts(monkeypatch) -> None:
    async def fake_grav(e):
        return {"email": e, "found": True, "display_name": "Jane Roe",
                "accounts": [{"service": "github", "username": "janer", "url": "x"}]}

    async def fake_hibp(e):
        return {"email": e, "checked": False, "note": "no key"}

    monkeypatch.setattr(O.C, "lookup_gravatar", fake_grav)
    monkeypatch.setattr(O.C, "lookup_hibp", fake_hibp)

    g = O._Graph(ts=time.time())
    summary = await O._investigate_email(g, "jane@example.com")

    assert "email:jane@example.com" in g.objs
    assert "person:jane-roe" in g.objs
    assert "username:janer" in g.objs
    assert summary["linked_accounts"] == 1


# ── phone: a selector the platform can classify but deliberately cannot fetch ──


def test_classify_phone_shapes() -> None:
    assert classify_target("618-462-0000") == ("phone", "6184620000")
    assert classify_target("(618) 462-0000") == ("phone", "6184620000")
    assert classify_target("618.462.0000") == ("phone", "6184620000")
    assert classify_target("6184620000") == ("phone", "6184620000")
    assert classify_target("+44 20 7946 0958") == ("phone", "+442079460958")


def test_phone_does_not_steal_the_other_kinds() -> None:
    # The collision that matters: a bare digit run also matches the ASN shape.
    assert classify_target("15169") == ("asn", "AS15169")
    assert classify_target("AS15169") == ("asn", "AS15169")
    assert classify_target("8.8.8.8") == ("ip", "8.8.8.8")
    assert classify_target("http://1-800-555-1212.com/x")[0] == "url"
    assert classify_target("torvalds") == ("username", "torvalds")


def test_normalise_phone_rejects_ambiguous_runs() -> None:
    assert normalise_phone("12345") is None        # too short, and an ASN shape
    assert normalise_phone("123456789012") is None  # 12 bare digits: ambiguous
    assert normalise_phone("+1234567") is None      # international under 8
    assert normalise_phone("(((((") is None
    assert normalise_phone("") is None


def test_investigate_rejects_a_phone_with_the_pivot_address() -> None:
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app()) as c:
        r = c.post("/api/osint/investigate", json={"target": "618-462-0000"})
    assert r.status_code == 400
    # The 400 has to say where the answer IS, or a classifiable target that
    # mints nothing reads as a broken route.
    assert "/api/osint/pivots" in r.json()["detail"]


# ── stealer logs wired into the fan-out ───────────────────────────────────────


async def test_email_mints_a_stealer_indicator(monkeypatch) -> None:
    async def infected(e):
        return {"indicator": e, "checked": True, "infected": True,
                "computer_count": 2, "stealer_families": ["Lumma"],
                "corporate_services": 1, "user_services": 9,
                "computers": [{"computer_name": "PC1", "stealer_family": "Lumma"}]}

    async def none_found(x):
        return {"found": False, "accounts": []}

    monkeypatch.setattr(O.stealer, "hudsonrock_email", infected)
    monkeypatch.setattr(O.C, "lookup_gravatar", none_found)

    g = O._Graph(ts=time.time())
    summary = await O._investigate_email(g, "victim@example.com")

    assert "threat:stealer:victim@example.com" in g.objs
    assert summary["stealer_machines"] == 2
    assert any(lk.rel == "compromised_in" and lk.dst == "email:victim@example.com"
               for lk in g.links.values())


async def test_clean_email_reports_checked_with_no_indicator(monkeypatch) -> None:
    async def none_found(x):
        return {"found": False, "accounts": []}

    monkeypatch.setattr(O.C, "lookup_gravatar", none_found)

    g = O._Graph(ts=time.time())
    summary = await O._investigate_email(g, "clean@example.com")

    # "checked, clean" is a finding and must be distinguishable from "not run".
    assert summary["stealer_checked"] is True
    assert summary["stealer_machines"] == 0
    assert not [o for o in g.objs if o.startswith("threat:stealer:")]


# ── _investigate_person ───────────────────────────────────────────────────────


def _person_stubs(monkeypatch, *, ls_name: str = "Jane Roe") -> None:
    async def fake_ls(name):
        return {"query": name, "count": 2, "entities": [
            {"id": "42", "name": ls_name, "kind": "Person",
             "blurb": "b", "url": "https://littlesis.org/entities/42"},
            {"id": "43", "name": "Someone Else", "kind": "Person"},
        ]}

    async def fake_rels(eid):
        return {"entity_id": eid, "count": 2, "relationships": [
            {"description": "Jane Roe  gave money to  Acme Corp",
             "role": "Campaign Contribution", "amount": 1000,
             "start_date": "2020-00-00", "end_date": "",
             "counterparty": {"id": "9", "kind": "Organization", "name": "Acme Corp"}},
            {"description": "Jane Roe  and  John Doe  are family",
             "role": "Family", "amount": None, "start_date": "", "end_date": "",
             "counterparty": {"id": "8", "kind": "Person", "name": "John Doe"}},
        ]}

    async def empty(name):
        return {"query": name, "count": 0, "entities": [], "matches": []}

    monkeypatch.setattr(O.corp, "littlesis_search", fake_ls)
    monkeypatch.setattr(O.corp, "littlesis_relationships", fake_rels)
    monkeypatch.setattr(O.corp, "opensanctions_search", empty)
    monkeypatch.setattr(O.corp, "aleph_search", empty)
    monkeypatch.setattr(O.corp, "wikidata_search", empty)


async def test_investigate_person_mints_affiliates(monkeypatch) -> None:
    _person_stubs(monkeypatch)

    g = O._Graph(ts=time.time())
    summary = await O._investigate_person(g, "Jane Roe")

    assert "person:jane-roe" in g.objs
    # An org counterparty reuses the ext:organization id scheme, which is the
    # bridge to registrant orgs and aircraft operators.
    assert "ext:organization:acme-corp" in g.objs
    assert "person:john-doe" in g.objs
    assert summary["affiliates"] == 2

    edge = next(lk for lk in g.links.values()
                if lk.dst == "ext:organization:acme-corp")
    assert edge.rel == "affiliated_with"
    # The upstream's own sentence survives the generalised verb.
    assert "gave money to" in edge.props["description"]
    assert edge.props["amount"] == 1000


async def test_investigate_person_ignores_a_namesake(monkeypatch) -> None:
    # LittleSis relevance is loose: a query returns better-known neighbours.
    # Attributing their edges to our subject would be a fabrication.
    _person_stubs(monkeypatch, ls_name="A Different Person")

    g = O._Graph(ts=time.time())
    summary = await O._investigate_person(g, "Jane Roe")

    assert summary["affiliates"] == 0
    assert "ext:organization:acme-corp" not in g.objs
    assert g.objs["person:jane-roe"].props.get("littlesis_id") is None


async def test_investigate_person_records_a_clean_screening(monkeypatch) -> None:
    _person_stubs(monkeypatch)

    g = O._Graph(ts=time.time())
    await O._investigate_person(g, "Jane Roe")

    # A 0 is "checked, clean" and has to survive onto the node, past g.obj()'s
    # drop-falsy filter, or the due-diligence record is worthless.
    props = g.objs["person:jane-roe"].props
    assert props["sanctions_matches"] == 0
    assert props["aleph_matches"] == 0


# ── ch. 27: coordinates, the selector a geospatial platform most needed ───────


def test_classify_coordinate_decimal_and_dms() -> None:
    assert classify_target("38.8977,-77.0365") == ("coordinate", "38.897700,-77.036500")
    assert classify_target("38.8977, -77.0365") == ("coordinate", "38.897700,-77.036500")
    assert classify_target("38.8977 -77.0365") == ("coordinate", "38.897700,-77.036500")
    assert classify_target("41°53'23.2\"N 12°29'32.2\"E") == ("coordinate", "41.889778,12.492278")
    # Half the sources write longitude first; the same point must resolve either way.
    assert classify_target("12°29'32.2\"E 41°53'23.2\"N") == ("coordinate", "41.889778,12.492278")
    assert classify_target("41°N 12°E") == ("coordinate", "41.0,12.0")


def test_coordinate_does_not_steal_the_other_kinds() -> None:
    # "38.8977 -77.0365" is digits, dots, a space and a hyphen: exactly the
    # phone shape, which is why coordinate is checked first.
    assert classify_target("618-462-0000") == ("phone", "6184620000")
    assert classify_target("8.8.8.8") == ("ip", "8.8.8.8")
    assert classify_target("1.2.3.4") == ("ip", "1.2.3.4")


def test_out_of_range_pairs_are_not_coordinates() -> None:
    assert normalise_coordinate("200.5,-77.0") is None      # latitude past the pole
    assert normalise_coordinate("38.9,-200.0") is None      # longitude past the wrap
    assert normalise_coordinate("1.2") is None              # one number is not a pair
    assert normalise_coordinate("") is None


def test_coordinate_rejects_whitespace_runs_in_linear_time() -> None:
    """The DMS regex used to let three adjacent ``\\s*`` share one whitespace run:
    "1" + 4 000 tabs took 55 s to reject (cubic), and the agent tool passes
    targets unbounded. The rewrite must reject it at once and still read the
    separators it always accepted."""
    for bad in ("1" + "\t" * 20_000 + "x", "1N" + " " * 20_000 + "x", "9" + "\t" * 20_000):
        t0 = time.perf_counter()
        assert normalise_coordinate(bad) is None
        assert time.perf_counter() - t0 < 0.5
    assert normalise_coordinate("41 53 23 N 12 29 32 E") == "41.889722,12.492222"
    assert normalise_coordinate("41°N,\t12°E") == "41.0,12.0"
    assert normalise_coordinate("38.8977 \t -77.0365") == "38.897700,-77.036500"


# ── ch. 43: ransomware leak-site claims in the domain fan-out ────────────────


async def test_domain_mints_a_ransomware_indicator(monkeypatch) -> None:
    async def claimed(d):
        return {"query": d, "checked": True, "count": 2,
                "groups": ["qilin", "incransom"],
                "country_counts": {"ID": 2},
                "victims": [{"victim": d, "group": "qilin", "domain": d, "country": "ID"}]}

    async def nothing(*a, **k):
        return {}

    monkeypatch.setattr(O.ransomware, "ransomware_domain", claimed)
    for name in ("lookup_dns", "lookup_whois", "lookup_certs", "lookup_threat"):
        monkeypatch.setattr(O.C, name, nothing)
    for name in ("wayback_urls", "hackertarget_hosts", "anubis_subdomains",
                 "columbus_subdomains", "certspotter_issuances", "urlscan_domain"):
        monkeypatch.setattr(O.infra, name, nothing)
    monkeypatch.setattr(O.stealer, "hudsonrock_domain", nothing)

    g = O._Graph(ts=time.time())
    summary = await O._investigate_domain(g, "victim.example")

    assert "threat:ransomware:victim.example" in g.objs
    assert summary["ransomware_posts"] == 2
    assert summary["ransomware_checked"] is True
    assert any(lk.rel == "indicates_threat" and lk.dst == "domain:victim.example"
               for lk in g.links.values())


async def test_a_rate_limited_ransomware_check_mints_nothing(monkeypatch) -> None:
    # checked:False means the question was not answered. Minting an indicator
    # would be inventing one; reporting 0 as clean would be an all-clear.
    async def limited(d):
        return {"query": d, "checked": False, "count": 0, "victims": [],
                "groups": [], "country_counts": {}, "note": "rate limited"}

    async def nothing(*a, **k):
        return {}

    monkeypatch.setattr(O.ransomware, "ransomware_domain", limited)
    for name in ("lookup_dns", "lookup_whois", "lookup_certs", "lookup_threat"):
        monkeypatch.setattr(O.C, name, nothing)
    for name in ("wayback_urls", "hackertarget_hosts", "anubis_subdomains",
                 "columbus_subdomains", "certspotter_issuances", "urlscan_domain"):
        monkeypatch.setattr(O.infra, name, nothing)
    monkeypatch.setattr(O.stealer, "hudsonrock_domain", nothing)

    g = O._Graph(ts=time.time())
    summary = await O._investigate_domain(g, "victim.example")

    assert not [o for o in g.objs if o.startswith("threat:ransomware:")]
    assert summary["ransomware_checked"] is False
