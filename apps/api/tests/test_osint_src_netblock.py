"""IP/ASN routing + reputation connectors — no live network, all fetch_json mocked."""

from __future__ import annotations

from typing import Any

import app.osint.sources.netblock as N


def _patch(monkeypatch, table: dict[str, Any]) -> None:
    """Monkeypatch fetch_json with a fake keyed by exact URL prefix match."""

    async def fake_fetch_json(url: str, ttl: float, **kwargs: Any) -> Any:
        for prefix, payload in table.items():
            if url.startswith(prefix):
                return payload
        return None

    monkeypatch.setattr(N, "fetch_json", fake_fetch_json)


# ── bgpview_ip ───────────────────────────────────────────────────────────────


async def test_bgpview_ip_shape(monkeypatch) -> None:
    _patch(monkeypatch, {
        "https://api.bgpview.io/ip/8.8.8.8": {
            "data": {
                "prefixes": [
                    {
                        "prefix": "8.8.8.0/24",
                        "asn": {"asn": 15169, "name": "GOOGLE", "country_code": "US"},
                    }
                ]
            }
        },
    })
    out = await N.bgpview_ip("8.8.8.8")
    assert out["ip"] == "8.8.8.8"
    assert out["prefixes"] == ["8.8.8.0/24"]
    assert out["asns"] == [{"asn": "AS15169", "name": "GOOGLE", "country": "US"}]


async def test_bgpview_ip_invalid() -> None:
    out = await N.bgpview_ip("not-an-ip")
    assert out["prefixes"] == []
    assert out["asns"] == []
    assert "note" in out


async def test_bgpview_ip_upstream_down(monkeypatch) -> None:
    _patch(monkeypatch, {})
    out = await N.bgpview_ip("8.8.8.8")
    assert out["note"] == "bgpview unavailable"


# ── bgpview_asn ──────────────────────────────────────────────────────────────


async def test_bgpview_asn_shape(monkeypatch) -> None:
    _patch(monkeypatch, {
        "https://api.bgpview.io/asn/15169/prefixes": {
            "data": {"ipv4_prefixes": [{"prefix": "8.8.8.0/24"}], "ipv6_prefixes": []}
        },
        "https://api.bgpview.io/asn/15169/peers": {
            "data": {"ipv4_peers": [{"asn": 3356}], "ipv6_peers": []}
        },
        "https://api.bgpview.io/asn/15169": {
            "data": {
                "name": "GOOGLE",
                "description_short": "Google LLC",
                "country_code": "US",
            }
        },
    })
    out = await N.bgpview_asn("AS15169")
    assert out["asn"] == "AS15169"
    assert out["name"] == "GOOGLE"
    assert out["description"] == "Google LLC"
    assert out["country"] == "US"
    assert out["prefixes"] == ["8.8.8.0/24"]
    assert out["peers"] == ["AS3356"]
    assert out["upstreams"] == []


async def test_bgpview_asn_accepts_bare_number(monkeypatch) -> None:
    _patch(monkeypatch, {
        "https://api.bgpview.io/asn/15169/prefixes": {"data": {}},
        "https://api.bgpview.io/asn/15169/peers": {"data": {}},
        "https://api.bgpview.io/asn/15169": {"data": {"name": "GOOGLE"}},
    })
    out = await N.bgpview_asn("15169")
    assert out["asn"] == "AS15169"


async def test_bgpview_asn_invalid() -> None:
    out = await N.bgpview_asn("not-an-asn")
    assert out["prefixes"] == []
    assert "note" in out


# ── ripestat_network ─────────────────────────────────────────────────────────


async def test_ripestat_network_shape(monkeypatch) -> None:
    _patch(monkeypatch, {
        "https://stat.ripe.net/data/network-info/data.json": {
            "data": {"asns": [15169], "prefix": "8.8.8.0/24"}
        },
        "https://stat.ripe.net/data/abuse-contact-finder/data.json": {
            "data": {"abuse_contacts": ["abuse@google.com"]}
        },
    })
    out = await N.ripestat_network("8.8.8.8")
    assert out == {
        "ip": "8.8.8.8",
        "asns": ["AS15169"],
        "prefix": "8.8.8.0/24",
        "abuse_email": "abuse@google.com",
    }


async def test_ripestat_network_invalid() -> None:
    out = await N.ripestat_network("garbage")
    assert out["asns"] == []
    assert "note" in out


# ── greynoise_community ───────────────────────────────────────────────────────


async def test_greynoise_community_seen(monkeypatch) -> None:
    _patch(monkeypatch, {
        "https://api.greynoise.io/v3/community/1.2.3.4": {
            "classification": "malicious",
            "name": "Mirai",
            "noise": True,
            "last_seen": "2026-07-01",
            "tags": ["Mirai"],
        },
    })
    out = await N.greynoise_community("1.2.3.4")
    assert out["classification"] == "malicious"
    assert out["noise"] is True
    assert out["tags"] == ["Mirai"]


async def test_greynoise_community_unseen_is_normal(monkeypatch) -> None:
    _patch(monkeypatch, {})  # fetch_json returns None (404 / not observed)
    out = await N.greynoise_community("9.9.9.9")
    assert out == {
        "ip": "9.9.9.9",
        "classification": "unknown",
        "noise": False,
        "note": "not observed",
    }


# ── onionoo_exit ───────────────────────────────────────────────────────────────


async def test_onionoo_exit_true(monkeypatch) -> None:
    _patch(monkeypatch, {
        "https://onionoo.torproject.org/details": {
            "relays": [
                {"nickname": "relay1", "country": "de", "flags": ["Running"]},
                {"nickname": "exitnode", "country": "nl", "flags": ["Exit", "Running"]},
            ]
        },
    })
    out = await N.onionoo_exit("1.2.3.4")
    assert out["is_tor_exit"] is True
    assert out["nickname"] == "exitnode"
    assert out["country"] == "nl"


async def test_onionoo_exit_false_no_relays(monkeypatch) -> None:
    _patch(monkeypatch, {"https://onionoo.torproject.org/details": {"relays": []}})
    out = await N.onionoo_exit("1.2.3.4")
    assert out["is_tor_exit"] is False
    assert out["nickname"] == ""


async def test_onionoo_exit_relay_not_exit(monkeypatch) -> None:
    _patch(monkeypatch, {
        "https://onionoo.torproject.org/details": {
            "relays": [{"nickname": "relay1", "country": "de", "flags": ["Running"]}]
        },
    })
    out = await N.onionoo_exit("1.2.3.4")
    assert out["is_tor_exit"] is False
    assert out["nickname"] == "relay1"


# ── feodo_listed ──────────────────────────────────────────────────────────────


async def test_feodo_listed_true(monkeypatch) -> None:
    _patch(monkeypatch, {
        "https://feodotracker.abuse.ch/downloads/ipblocklist.json": [
            {"ip_address": "5.6.7.8", "malware": "Dridex", "first_seen": "2026-01-01"},
            {"ip_address": "1.1.1.1", "malware": "Other", "first_seen": "2026-02-02"},
        ],
    })
    out = await N.feodo_listed("5.6.7.8")
    assert out == {
        "ip": "5.6.7.8",
        "listed": True,
        "malware": "Dridex",
        "first_seen": "2026-01-01",
    }


async def test_feodo_listed_false(monkeypatch) -> None:
    _patch(monkeypatch, {
        "https://feodotracker.abuse.ch/downloads/ipblocklist.json": [
            {"ip_address": "1.1.1.1", "malware": "Other", "first_seen": "2026-02-02"},
        ],
    })
    out = await N.feodo_listed("5.6.7.8")
    assert out == {"ip": "5.6.7.8", "listed": False, "malware": "", "first_seen": ""}


async def test_feodo_listed_invalid_ip() -> None:
    out = await N.feodo_listed("garbage")
    assert out["listed"] is False
    assert "note" in out


async def test_feodo_listed_upstream_down(monkeypatch) -> None:
    _patch(monkeypatch, {})
    out = await N.feodo_listed("5.6.7.8")
    assert out["listed"] is False
    assert out["note"] == "feodo unavailable"
