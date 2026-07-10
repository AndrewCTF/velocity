"""Unit tests for `app/osint/sources/infra.py` — no live network.

Monkeypatches `fetch_json` / `_fetch_text` with async fakes returning
representative upstream payloads and asserts the normalised dict shape,
including the empty+note degrade path on a dead upstream.
"""

from __future__ import annotations

from app.osint.sources import infra as I

# ── wayback_urls ──────────────────────────────────────────────────────────

async def test_wayback_urls_derives_subdomains(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return [
            ["original"],
            ["http://example.com/a"],
            ["http://sub.example.com/b?x=1"],
            ["https://example.com/c"],
        ]

    monkeypatch.setattr(I, "fetch_json", fake)
    out = await I.wayback_urls("example.com")
    assert out["domain"] == "example.com"
    assert out["url_count"] == 3
    assert "http://sub.example.com/b?x=1" in out["urls"]
    assert out["subdomains"] == ["sub.example.com"]
    assert out["subdomain_count"] == 1


async def test_wayback_urls_invalid_domain() -> None:
    out = await I.wayback_urls("!!!")
    assert out["urls"] == [] and out["subdomains"] == []
    assert out["url_count"] == 0
    assert "note" in out


async def test_wayback_urls_upstream_down(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return None

    monkeypatch.setattr(I, "fetch_json", fake)
    out = await I.wayback_urls("example.com")
    assert out["urls"] == [] and out["url_count"] == 0
    assert "note" in out


# ── hackertarget_hosts ────────────────────────────────────────────────────

async def test_hackertarget_hosts_parses_plaintext(monkeypatch) -> None:
    async def fake_text(url, **kw):
        return "www.example.com,1.2.3.4\nmail.example.com,1.2.3.5\n"

    monkeypatch.setattr(I, "_fetch_text", fake_text)
    out = await I.hackertarget_hosts("example.com")
    assert out["count"] == 2
    assert {"host": "www.example.com", "ip": "1.2.3.4"} in out["hosts"]
    assert "note" not in out


async def test_hackertarget_hosts_rate_limited(monkeypatch) -> None:
    async def fake_text(url, **kw):
        return "error check your search parameter API count exceeded - Increase Quota"

    monkeypatch.setattr(I, "_fetch_text", fake_text)
    out = await I.hackertarget_hosts("example.com")
    assert out["hosts"] == [] and out["count"] == 0
    assert "note" in out


async def test_hackertarget_hosts_upstream_down(monkeypatch) -> None:
    async def fake_text(url, **kw):
        return None

    monkeypatch.setattr(I, "_fetch_text", fake_text)
    out = await I.hackertarget_hosts("example.com")
    assert out["hosts"] == [] and out["count"] == 0
    assert "note" in out


async def test_hackertarget_hosts_invalid_domain() -> None:
    out = await I.hackertarget_hosts("not a domain")
    assert out["hosts"] == [] and "note" in out


# ── anubis_subdomains ─────────────────────────────────────────────────────

async def test_anubis_subdomains(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return ["www.example.com", "Mail.Example.com", "www.example.com"]

    monkeypatch.setattr(I, "fetch_json", fake)
    out = await I.anubis_subdomains("example.com")
    assert out["count"] == 2
    assert out["subdomains"] == ["mail.example.com", "www.example.com"]


async def test_anubis_subdomains_upstream_down(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return None

    monkeypatch.setattr(I, "fetch_json", fake)
    out = await I.anubis_subdomains("example.com")
    assert out["subdomains"] == [] and out["count"] == 0
    assert "note" in out


# ── columbus_subdomains ───────────────────────────────────────────────────

async def test_columbus_subdomains_prepends_labels(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return ["www", "mail.example.com"]

    monkeypatch.setattr(I, "fetch_json", fake)
    out = await I.columbus_subdomains("example.com")
    assert out["count"] == 2
    assert "www.example.com" in out["subdomains"]
    assert "mail.example.com" in out["subdomains"]


async def test_columbus_subdomains_upstream_down(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return None

    monkeypatch.setattr(I, "fetch_json", fake)
    out = await I.columbus_subdomains("example.com")
    assert out["subdomains"] == [] and out["count"] == 0
    assert "note" in out


# ── certspotter_issuances ─────────────────────────────────────────────────

async def test_certspotter_issuances(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return [
            {
                "dns_names": ["example.com", "www.example.com"],
                "issuer": {"name": "Let's Encrypt"},
                "not_before": "2026-01-01T00:00:00Z",
                "not_after": "2026-04-01T00:00:00Z",
            },
        ]

    monkeypatch.setattr(I, "fetch_json", fake)
    out = await I.certspotter_issuances("example.com")
    assert out["subdomains"] == ["www.example.com"]
    assert out["count"] == 1
    assert out["certs"][0]["issuer"] == "Let's Encrypt"


async def test_certspotter_issuances_no_key_degrades(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return None

    monkeypatch.setattr(I, "fetch_json", fake)
    out = await I.certspotter_issuances("example.com")
    assert out["subdomains"] == [] and out["certs"] == []
    assert out["count"] == 0
    assert "note" in out


async def test_certspotter_issuances_invalid_domain() -> None:
    out = await I.certspotter_issuances("!!!")
    assert out["subdomains"] == [] and "note" in out


# ── urlscan_domain ────────────────────────────────────────────────────────

async def test_urlscan_domain(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return {
            "results": [
                {
                    "page": {"url": "https://example.com/", "ip": "1.2.3.4", "asn": "AS15169"},
                    "task": {"time": "2026-01-01T00:00:00.000Z"},
                },
                {
                    "page": {"url": "https://example.com/x", "ip": "1.2.3.4", "asn": "AS15169"},
                    "task": {"time": "2026-01-02T00:00:00.000Z"},
                },
            ],
        }

    monkeypatch.setattr(I, "fetch_json", fake)
    out = await I.urlscan_domain("example.com")
    assert out["count"] == 2
    assert out["ips"] == ["1.2.3.4"]
    assert out["scans"][0]["url"] == "https://example.com/"


async def test_urlscan_domain_upstream_down(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return None

    monkeypatch.setattr(I, "fetch_json", fake)
    out = await I.urlscan_domain("example.com")
    assert out["scans"] == [] and out["count"] == 0
    assert "note" in out


async def test_urlscan_domain_invalid_domain() -> None:
    out = await I.urlscan_domain("!!!")
    assert out["scans"] == [] and "note" in out
