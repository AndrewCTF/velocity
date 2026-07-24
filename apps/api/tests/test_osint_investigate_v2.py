"""Phase B integration: new connectors mint+link into the shared ontology graph.

Mirrors ``test_osint_person.py``'s pattern — monkeypatch the connector modules
imported into ``routes/osint.py`` (``O.infra`` / ``O.netblock`` / ``O.threat_feeds``
/ ``O.crypto`` / ``O.corp`` / ``O.social``), build a bare ``O._Graph``, call the
``_investigate_*`` orchestrator directly, and assert the expected nodes/links
land in ``g.objs`` / ``g.links``. No live network.
"""

from __future__ import annotations

import time

from app.routes import osint as O


def _noop_async(result):
    async def f(*_args, **_kwargs):
        return result
    return f


# ── domain enrichment: new subdomain sources + certs + contacted ips ────────────

async def test_investigate_domain_mints_extra_subdomains_and_contacted_ip(monkeypatch) -> None:
    monkeypatch.setattr(O.C, "lookup_dns", _noop_async({"ips": [], "records": {}}))
    monkeypatch.setattr(O.C, "lookup_whois", _noop_async({}))
    monkeypatch.setattr(O.C, "lookup_certs", _noop_async({"subdomains": [], "subdomain_count": 0}))
    monkeypatch.setattr(O.C, "lookup_threat", _noop_async({}))

    monkeypatch.setattr(
        O.infra, "wayback_urls",
        _noop_async({"subdomains": ["a.example.com"], "urls": [], "url_count": 0, "subdomain_count": 1}),
    )
    monkeypatch.setattr(
        O.infra, "hackertarget_hosts",
        _noop_async({"hosts": [{"host": "b.example.com", "ip": "1.2.3.4"}], "count": 1}),
    )
    monkeypatch.setattr(O.infra, "anubis_subdomains", _noop_async({"subdomains": [], "count": 0}))
    monkeypatch.setattr(O.infra, "columbus_subdomains", _noop_async({"subdomains": [], "count": 0}))
    monkeypatch.setattr(
        O.infra, "certspotter_issuances",
        _noop_async({
            "subdomains": ["c.example.com"],
            "certs": [{"issuer": "Let's Encrypt", "not_before": "2026-01-01", "not_after": "2026-04-01"}],
            "count": 1,
        }),
    )
    monkeypatch.setattr(
        O.infra, "urlscan_domain",
        _noop_async({"scans": [], "ips": ["9.9.9.9"], "count": 0}),
    )

    g = O._Graph(ts=time.time())
    summary = await O._investigate_domain(g, "example.com")

    assert "domain:a.example.com" in g.objs
    assert "domain:b.example.com" in g.objs
    assert "domain:c.example.com" in g.objs
    assert any(
        lk.src == "domain:example.com" and lk.dst == "domain:a.example.com" and lk.rel == "has_subdomain"
        for lk in g.links.values()
    )
    cert_ids = [oid for oid in g.objs if oid.startswith("cert:")]
    assert cert_ids
    assert any(
        lk.src == "domain:example.com" and lk.dst == cert_ids[0] and lk.rel == "secured_by"
        for lk in g.links.values()
    )
    assert "ip:9.9.9.9" in g.objs
    assert any(
        lk.src == "domain:example.com" and lk.dst == "ip:9.9.9.9" and lk.rel == "contacted"
        for lk in g.links.values()
    )
    assert summary["extra_subdomains_persisted"] == 3


# ── ip enrichment: asn + tor/feodo threat flags ──────────────────────────────────

async def test_enrich_ip_mints_asn_and_tor_feodo_threat(monkeypatch) -> None:
    monkeypatch.setattr(O.C, "lookup_ip", _noop_async({"asn": "", "org": "", "note": "no geo"}))
    monkeypatch.setattr(O.C, "lookup_shodan", _noop_async({"ports": []}))
    monkeypatch.setattr(
        O.netblock, "bgpview_ip",
        _noop_async({"prefixes": [], "asns": [{"asn": "AS9999", "name": "Evil Net", "country": "XX"}]}),
    )
    monkeypatch.setattr(
        O.netblock, "ripestat_network",
        _noop_async({"asns": [], "prefix": "", "abuse_email": ""}),
    )
    monkeypatch.setattr(
        O.netblock, "bgpview_asn",
        _noop_async({"asn": "AS9999", "name": "Evil Net", "peers": ["AS111"], "prefixes": []}),
    )
    monkeypatch.setattr(
        O.netblock, "greynoise_community",
        _noop_async({"classification": "unknown", "noise": False}),
    )
    monkeypatch.setattr(
        O.netblock, "onionoo_exit",
        _noop_async({"is_tor_exit": True, "nickname": "exitnode1", "country": "XX"}),
    )
    monkeypatch.setattr(
        O.netblock, "feodo_listed",
        _noop_async({"listed": True, "malware": "Dridex", "first_seen": "2026-01-01"}),
    )

    g = O._Graph(ts=time.time())
    g.obj("ip:6.6.6.6", "IPAddress", "test", {"address": "6.6.6.6"})
    await O._enrich_ip(g, "6.6.6.6")

    assert "asn:AS9999" in g.objs
    assert any(
        lk.src == "asn:AS9999" and lk.dst == "ip:6.6.6.6" and lk.rel == "announces"
        for lk in g.links.values()
    )
    assert "asn:AS111" in g.objs  # peer of the primary asn
    assert any(
        lk.src == "asn:AS9999" and lk.dst == "asn:AS111" and lk.rel == "peers_with"
        for lk in g.links.values()
    )
    assert "threat:6.6.6.6" in g.objs
    assert any(
        lk.src == "ip:6.6.6.6" and lk.dst == "threat:6.6.6.6" and lk.rel == "listed_by"
        for lk in g.links.values()
    )
    assert any(
        lk.src == "ip:6.6.6.6" and lk.dst == "threat:6.6.6.6" and lk.rel == "tor_exit"
        for lk in g.links.values()
    )


# ── email: emailrep + libravatar ─────────────────────────────────────────────────

async def test_investigate_email_mints_threat_on_emailrep_malicious(monkeypatch) -> None:
    monkeypatch.setattr(O.C, "lookup_gravatar", _noop_async({"found": False}))
    monkeypatch.setattr(O.C, "lookup_hibp", _noop_async({"checked": False}))
    monkeypatch.setattr(
        O.threat_feeds, "emailrep",
        _noop_async({"reputation": "low", "suspicious": True, "malicious": True, "breach": False, "profiles": []}),
    )
    monkeypatch.setattr(O.social, "libravatar_exists", _noop_async({"has_avatar": True}))

    g = O._Graph(ts=time.time())
    summary = await O._investigate_email(g, "bad@example.com")

    assert g.objs["email:bad@example.com"].props["has_avatar"] is True
    assert "threat:bad@example.com" in g.objs
    assert any(
        lk.src == "threat:bad@example.com" and lk.dst == "email:bad@example.com" and lk.rel == "indicates_threat"
        for lk in g.links.values()
    )
    assert summary["emailrep_malicious"] is True


# ── url: threat + distributed file ────────────────────────────────────────────────

async def test_investigate_url_mints_threat_and_file(monkeypatch) -> None:
    monkeypatch.setattr(
        O.threat_feeds, "urlhaus_url",
        _noop_async({
            "threat": "malware_download", "tags": ["exe"],
            "payloads": ["a" * 64], "status": "online",
        }),
    )
    monkeypatch.setattr(
        O.threat_feeds, "phishstats_url",
        _noop_async({"score": 7.5, "tld": "test", "ip": "", "count": 1}),
    )
    monkeypatch.setattr(O.infra, "urlscan_domain", _noop_async({"scans": [], "ips": [], "count": 0}))

    g = O._Graph(ts=time.time())
    url = "http://evil.test/x"
    summary = await O._investigate_url(g, url)

    assert f"url:{url}" in g.objs
    assert f"threat:{url}" in g.objs
    assert any(
        lk.src == f"threat:{url}" and lk.dst == f"url:{url}" and lk.rel == "indicates_threat"
        for lk in g.links.values()
    )
    fid = "file:" + "a" * 64
    assert fid in g.objs
    assert any(
        lk.src == f"url:{url}" and lk.dst == fid and lk.rel == "distributes"
        for lk in g.links.values()
    )
    assert summary["payload_count"] == 1


# ── hash: malware family threat ───────────────────────────────────────────────────

async def test_investigate_hash_mints_file_and_threat(monkeypatch) -> None:
    h = "b" * 64
    monkeypatch.setattr(
        O.threat_feeds, "malwarebazaar_hash",
        _noop_async({
            "family": "Emotet", "file_type": "exe", "tags": ["trojan"],
            "first_seen": "2026-01-01", "signature": "Emotet",
        }),
    )
    monkeypatch.setattr(O.threat_feeds, "yaraify_hash", _noop_async({"yara": ["rule1"], "clamav": []}))

    g = O._Graph(ts=time.time())
    summary = await O._investigate_hash(g, h)

    assert f"file:{h}" in g.objs
    assert f"threat:{h}" in g.objs
    assert any(
        lk.src == f"threat:{h}" and lk.dst == f"file:{h}" and lk.rel == "indicates_threat"
        for lk in g.links.values()
    )
    assert summary["family"] == "Emotet"


# ── wallet: tx + counterparty ─────────────────────────────────────────────────────

async def test_investigate_wallet_mints_tx_and_counterparty(monkeypatch) -> None:
    addr = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
    monkeypatch.setattr(
        O.crypto, "mempool_btc_address",
        _noop_async({
            "address": addr, "chain": "btc", "funded": 100, "spent": 0, "balance": 100,
            "tx_count": 1,
            "txs": [{"txid": "deadbeef", "value": 100, "inputs": [addr], "outputs": ["counterparty1"]}],
        }),
    )
    monkeypatch.setattr(
        O.crypto, "blockstream_btc",
        _noop_async({"address": addr, "chain": "btc", "funded": 100, "spent": 0, "balance": 100, "tx_count": 1}),
    )

    g = O._Graph(ts=time.time())
    summary = await O._investigate_wallet(g, f"btc:{addr}")

    root = f"wallet:btc:{addr}"
    assert root in g.objs
    tx_id = "tx:btc:deadbeef"
    assert tx_id in g.objs
    assert any(lk.src == root and lk.dst == tx_id and lk.rel == "sends_to" for lk in g.links.values())
    cp_id = "wallet:btc:counterparty1"
    assert cp_id in g.objs
    assert any(
        lk.src == tx_id and lk.dst == cp_id and lk.rel == "receives_from"
        for lk in g.links.values()
    )
    assert summary["balance"] == 100
    assert summary["txs_persisted"] == 1


# ── asn: peers ─────────────────────────────────────────────────────────────────────

async def test_investigate_asn_mints_peers(monkeypatch) -> None:
    monkeypatch.setattr(
        O.netblock, "bgpview_asn",
        _noop_async({
            "asn": "AS15169", "name": "GOOGLE", "description": "Google LLC", "country": "US",
            "prefixes": ["8.8.8.0/24"], "peers": ["AS7018", "AS3356"], "upstreams": [],
        }),
    )

    g = O._Graph(ts=time.time())
    summary = await O._investigate_asn(g, "AS15169")

    assert "asn:AS15169" in g.objs
    assert "asn:AS7018" in g.objs
    assert "asn:AS3356" in g.objs
    assert any(
        lk.src == "asn:AS15169" and lk.dst == "asn:AS7018" and lk.rel == "peers_with"
        for lk in g.links.values()
    )
    assert summary["peer_count"] == 2


# ── company: org + officer + sanction ────────────────────────────────────────────

async def test_investigate_company_mints_org_officer_and_sanction(monkeypatch) -> None:
    monkeypatch.setattr(
        O.corp, "sec_edgar_company",
        _noop_async({"name": "Acme Corp", "cik": "123", "ticker": "ACME", "sic": "", "filings": [], "count": 0}),
    )
    monkeypatch.setattr(
        O.corp, "opensanctions_search",
        _noop_async({
            "query": "Acme Corp",
            "matches": [{"id": "os-1", "name": "Acme Corp", "schema": "Company",
                        "topics": ["sanction"], "datasets": ["us_ofac_sdn"]}],
            "count": 1,
        }),
    )
    monkeypatch.setattr(
        O.corp, "opencorporates_search",
        _noop_async({
            "query": "Acme Corp",
            "companies": [{"name": "Acme Corp", "number": "999", "jurisdiction": "us_de", "status": "active"}],
            "count": 1,
        }),
    )
    monkeypatch.setattr(
        O.corp, "openownership_search",
        _noop_async({"query": "Acme Corp", "owners": [{"name": "Jane Roe", "type": "person"}], "count": 1}),
    )
    monkeypatch.setattr(O.corp, "aleph_search", _noop_async({"query": "Acme Corp", "entities": [], "count": 0}))
    monkeypatch.setattr(
        O.corp, "wikidata_search",
        _noop_async({"query": "Acme Corp", "entities": [{"qid": "Q1", "label": "Acme Corp", "description": ""}], "count": 1}),
    )

    g = O._Graph(ts=time.time())
    summary = await O._investigate_company(g, "Acme Corp")

    root = "ext:organization:acme-corp"
    assert root in g.objs
    assert g.objs[root].props["wikidata_qid"] == "Q1"
    assert g.objs[root].props["company_number"] == "999"

    pid = "person:jane-roe"
    assert pid in g.objs
    assert any(lk.src == pid and lk.dst == root and lk.rel == "officer_of" for lk in g.links.values())

    threat_ids = [oid for oid in g.objs if oid.startswith("threat:")]
    assert threat_ids
    assert any(
        lk.src == root and lk.dst == threat_ids[0] and lk.rel == "sanctioned_as"
        for lk in g.links.values()
    )
    assert summary["sanctions_matches"] == 1
    assert summary["officers"] == 1

    # The screening result is not just returned in the response summary — it's
    # persisted onto the org root's props, so re-opening the case later shows
    # what was checked without re-running the fan-out.
    props = g.objs[root].props
    assert props["sanctions_matches"] == 1
    assert props["opencorporates_matches"] == 1
    assert props["officers"] == 1
    assert props["aleph_matches"] == 0
    assert props["wikidata_matches"] == 1


async def test_investigate_company_persists_zero_counts_as_screened(monkeypatch) -> None:
    """A clean screening (every connector finds 0) must still persist the counts
    onto the org object — a 0 is "checked, clean", not "never checked", and the
    props dict comprehension that drops falsy identity fields (cik/ticker/…)
    must NOT also drop these. Falsy identity fields still get dropped."""
    monkeypatch.setattr(
        O.corp, "sec_edgar_company",
        _noop_async({"name": "Nada Inc", "cik": "", "ticker": "", "sic": "", "filings": [], "count": 0}),
    )
    monkeypatch.setattr(
        O.corp, "opensanctions_search",
        _noop_async({"query": "Nada Inc", "matches": [], "count": 0}),
    )
    monkeypatch.setattr(
        O.corp, "opencorporates_search",
        _noop_async({"query": "Nada Inc", "companies": [], "count": 0}),
    )
    monkeypatch.setattr(
        O.corp, "openownership_search",
        _noop_async({"query": "Nada Inc", "owners": [], "count": 0}),
    )
    monkeypatch.setattr(O.corp, "aleph_search", _noop_async({"query": "Nada Inc", "entities": [], "count": 0}))
    monkeypatch.setattr(
        O.corp, "wikidata_search",
        _noop_async({"query": "Nada Inc", "entities": [], "count": 0}),
    )

    g = O._Graph(ts=time.time())
    summary = await O._investigate_company(g, "Nada Inc")

    root = "ext:organization:nada-inc"
    assert root in g.objs
    props = g.objs[root].props
    assert props["sanctions_matches"] == 0
    assert props["opencorporates_matches"] == 0
    assert props["officers"] == 0
    assert props["aleph_matches"] == 0
    assert props["wikidata_matches"] == 0
    # Falsy identity fields (no CIK found) still get dropped, not fabricated.
    assert "cik" not in props
    assert summary["sanctions_matches"] == 0
    assert summary["cik"] == ""

    # Readable back via the ontology registry, same as the route's persistence
    # step (get_registry(ctx, settings).upsert(obj) for every g.objs value).
    from app.config import get_settings
    from app.intel.ontology import get_registry
    from app.keys import UserCtx

    ctx = UserCtx("local", "")
    reg = get_registry(ctx, get_settings())
    await reg.upsert(g.objs[root])
    fetched = await reg.get(root)
    assert fetched is not None
    assert fetched.props["sanctions_matches"] == 0
    assert fetched.props["opencorporates_matches"] == 0
    assert fetched.props["officers"] == 0
    assert fetched.props["aleph_matches"] == 0
    assert fetched.props["wikidata_matches"] == 0
