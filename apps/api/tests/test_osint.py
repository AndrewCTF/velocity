"""Digital-OSINT connectors + investigate graph builder — hermetic (no network)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.osint import connectors as C
from app.osint.fetch import classify_target, normalise_domain, normalise_ip
from app.routes import osint as R

# ── pure target validation ──────────────────────────────────────────────────────

def test_normalise_domain() -> None:
    assert normalise_domain("Example.COM") == "example.com"
    assert normalise_domain("https://sub.example.com/path?x=1") == "sub.example.com"
    assert normalise_domain("example.com.") == "example.com"
    assert normalise_domain("8.8.8.8") is None            # an IP, not a domain
    assert normalise_domain("not a domain") is None
    assert normalise_domain("a..b") is None


def test_normalise_ip() -> None:
    assert normalise_ip("8.8.8.8") == "8.8.8.8"
    assert normalise_ip("2001:4860:4860::8888") == "2001:4860:4860::8888"
    assert normalise_ip("999.1.1.1") is None
    assert normalise_ip("example.com") is None


def test_classify_target() -> None:
    assert classify_target("8.8.8.8") == ("ip", "8.8.8.8")
    assert classify_target("example.com") == ("domain", "example.com")
    assert classify_target("http://evil/../") is None


# ── connector parsing (fetch_json mocked) ───────────────────────────────────────

def _mock_fetch(monkeypatch: pytest.MonkeyPatch, bodies: dict[str, Any]) -> None:
    """Route fetch_json by a substring match on the URL to a canned body."""
    async def fake(url: str, ttl: float, **kw: Any) -> Any:
        for needle, body in bodies.items():
            # DNS type params sit at the end of the URL and are prefixes of each
            # other ("type=1" ⊂ "type=15"), so match those by suffix; hosts by substring.
            if needle.startswith("type=") and url.endswith(needle):
                return body
            if not needle.startswith("type=") and needle in url:
                return body
        return None
    monkeypatch.setattr(C, "fetch_json", fake)


def test_lookup_dns_parses_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_fetch(monkeypatch, {
        "type=1": {"Answer": [{"type": 1, "data": "93.184.216.34"}]},
        "type=28": {"Answer": [{"type": 28, "data": "2606:2800:220:1:248:1893:25c8:1946"}]},
        "type=15": {"Answer": [{"type": 15, "data": "10 mail.example.com."}]},
    })
    out = asyncio.run(C.lookup_dns("example.com"))
    assert out["domain"] == "example.com"
    assert out["records"]["A"] == ["93.184.216.34"]
    assert "2606:2800:220:1:248:1893:25c8:1946" in out["ips"]
    assert out["records"]["MX"] == ["10 mail.example.com."]


def test_lookup_certs_extracts_subdomains(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_fetch(monkeypatch, {
        "crt.sh": [
            {"name_value": "www.example.com\n*.api.example.com", "issuer_name": "Let's Encrypt"},
            {"name_value": "example.com", "issuer_name": "Let's Encrypt"},  # apex, not a sub
        ],
    })
    out = asyncio.run(C.lookup_certs("example.com"))
    assert set(out["subdomains"]) == {"www.example.com", "api.example.com"}
    assert out["subdomain_count"] == 2
    assert out["truncated"] is False


def test_lookup_dns_invalid_domain_degrades() -> None:
    out = asyncio.run(C.lookup_dns("not valid"))
    assert out["ips"] == []
    assert out["note"] == "invalid domain"


# ── investigate graph builder ────────────────────────────────────────────────────

def test_investigate_domain_builds_objects_and_links(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_fetch(monkeypatch, {
        "type=1": {"Answer": [{"type": 1, "data": "1.2.3.4"}]},
        "rdap.org/domain": {
            "entities": [{
                "roles": ["registrant"],
                "vcardArray": ["vcard", [["fn", {}, "text", "Acme Corp"],
                                          ["email", {}, "text", "abuse@acme.test"]]],
            }],
            "events": [{"eventAction": "registration", "eventDate": "1995-08-14T04:00:00Z"}],
            "status": ["active"], "nameservers": [{"ldhName": "ns1.acme.test"}],
        },
        "crt.sh": [{"name_value": "vpn.example.com", "issuer_name": "CA"}],
        "internetdb": {"ports": [443, 22], "hostnames": [], "cpes": [], "tags": [], "vulns": []},
        "ip-api.com": {"status": "success", "as": "AS15169 Google LLC", "org": "Google",
                       "city": "Mountain View", "country": "US", "lat": 37.4, "lon": -122.0},
        "otx.alienvault.com": {"pulse_info": {"count": 3, "pulses": [{"name": "bad", "tags": ["c2"]}]}},
    })
    g = R._Graph(ts=1234.0)
    summary = asyncio.run(R._investigate_domain(g, "example.com"))

    assert "domain:example.com" in g.objs
    root = g.objs["domain:example.com"]
    assert root.kind == "domain"                      # first-class kind from prefix
    assert root.props["registrar"] == "Acme Corp"
    assert root.props["source"] == "rdap+dns"
    assert root.props["collected_at"] == 1234.0       # provenance stamped

    assert "ip:1.2.3.4" in g.objs
    assert ("domain:example.com", "ip:1.2.3.4", "resolves_to") in g.links
    assert "domain:vpn.example.com" in g.objs
    assert ("domain:example.com", "domain:vpn.example.com", "has_subdomain") in g.links
    assert "ext:organization:acme-corp" in g.objs  # unified with extract.py's scheme
    assert "email:abuse@acme.test" in g.objs
    assert "asn:AS15169" in g.objs                    # from IP enrichment
    assert "service:1.2.3.4:443" in g.objs
    assert ("threat:example.com", "domain:example.com", "indicates_threat") in g.links
    assert summary["threat_pulses"] == 3
    assert summary["subdomains"] == 1


# ── GET routes ───────────────────────────────────────────────────────────────────

def test_get_dns_route(client, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    _mock_fetch(monkeypatch, {"type=1": {"Answer": [{"type": 1, "data": "1.1.1.1"}]}})
    r = client.get("/api/osint/dns", params={"target": "example.com"})
    assert r.status_code == 200
    assert r.json()["records"]["A"] == ["1.1.1.1"]


def test_investigate_rejects_bad_target(client) -> None:  # type: ignore[no-untyped-def]
    # Bypass Supabase auth so we exercise the target-validation branch (400),
    # which runs before any persistence.
    from app.keys import UserCtx, current_user

    client.app.dependency_overrides[current_user] = lambda: UserCtx(user_id="t", token="t")
    r = client.post("/api/osint/investigate", json={"target": "not a target"})
    assert r.status_code == 400


def test_recon_requires_sidecar(client) -> None:  # type: ignore[no-untyped-def]
    # OSINT_RECON_SIDECAR_URL is unset in test settings → the GPL feature is off.
    from app.keys import UserCtx, current_user

    client.app.dependency_overrides[current_user] = lambda: UserCtx(user_id="t", token="t")
    r = client.post("/api/osint/recon", json={"target": "example.com", "tool": "amass"})
    assert r.status_code == 503
