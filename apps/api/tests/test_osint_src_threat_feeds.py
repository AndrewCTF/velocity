"""Unit tests for app.osint.sources.threat_feeds — no live network."""

from __future__ import annotations

from app.osint.sources import threat_feeds as T


async def test_urlhaus_host_ok(monkeypatch) -> None:
    async def fake_post(url, ttl, *, data=None, json_body=None, headers=None, browser_ua=False):
        assert data == {"host": "evil.test"}
        return {
            "query_status": "ok",
            "urls": [
                {"url": "http://evil.test/a", "threat": "malware_download", "url_status": "online"},
                {"url": "http://evil.test/b", "threat": "malware_download", "url_status": "offline"},
            ],
        }

    monkeypatch.setattr(T, "fetch_json_post", fake_post)
    out = await T.urlhaus_host("evil.test")
    assert out["host"] == "evil.test"
    assert out["url_count"] == 2
    assert out["urls"][0] == {"url": "http://evil.test/a", "threat": "malware_download", "status": "online"}
    assert "note" not in out


async def test_urlhaus_host_no_results(monkeypatch) -> None:
    async def fake_post(url, ttl, *, data=None, json_body=None, headers=None, browser_ua=False):
        return {"query_status": "no_results"}

    monkeypatch.setattr(T, "fetch_json_post", fake_post)
    out = await T.urlhaus_host("benign.test")
    assert out["urls"] == []
    assert out["url_count"] == 0
    assert out["note"]


async def test_urlhaus_host_invalid() -> None:
    out = await T.urlhaus_host("!!! not a host")
    assert out["urls"] == []
    assert out["note"] == "invalid host"


async def test_urlhaus_url_ok(monkeypatch) -> None:
    async def fake_post(url, ttl, *, data=None, json_body=None, headers=None, browser_ua=False):
        assert data == {"url": "http://evil.test/a"}
        return {
            "query_status": "ok",
            "threat": "malware_download",
            "tags": ["elf", "mirai"],
            "payloads": [{"response_sha256": "a" * 64}],
            "url_status": "online",
        }

    monkeypatch.setattr(T, "fetch_json_post", fake_post)
    out = await T.urlhaus_url("http://evil.test/a")
    assert out["threat"] == "malware_download"
    assert out["tags"] == ["elf", "mirai"]
    assert out["payloads"] == ["a" * 64]
    assert out["status"] == "online"


async def test_malwarebazaar_hash_ok(monkeypatch) -> None:
    h = "b" * 64

    async def fake_post(url, ttl, *, data=None, json_body=None, headers=None, browser_ua=False):
        assert data == {"query": "get_info", "hash": h}
        return {
            "query_status": "ok",
            "data": [{
                "signature": "AgentTesla",
                "file_type": "exe",
                "tags": ["exe", "agenttesla"],
                "first_seen": "2026-01-01 00:00:00",
                "sha256_hash": h,
            }],
        }

    monkeypatch.setattr(T, "fetch_json_post", fake_post)
    out = await T.malwarebazaar_hash(h)
    assert out["family"] == "AgentTesla"
    assert out["signature"] == "AgentTesla"
    assert out["file_type"] == "exe"
    assert out["first_seen"] == "2026-01-01 00:00:00"
    assert "note" not in out


async def test_malwarebazaar_hash_not_found(monkeypatch) -> None:
    h = "c" * 64

    async def fake_post(url, ttl, *, data=None, json_body=None, headers=None, browser_ua=False):
        return {"query_status": "hash_not_found"}

    monkeypatch.setattr(T, "fetch_json_post", fake_post)
    out = await T.malwarebazaar_hash(h)
    assert out["family"] == ""
    assert out["tags"] == []
    assert out["note"]


async def test_malwarebazaar_hash_invalid() -> None:
    out = await T.malwarebazaar_hash("not-a-hash")
    assert out["family"] == ""
    assert out["note"] == "invalid hash"


async def test_yaraify_hash_ok(monkeypatch) -> None:
    h = "d" * 64

    async def fake_post(url, ttl, *, data=None, json_body=None, headers=None, browser_ua=False):
        assert json_body == {"query": "lookup_hash", "search_term": h}
        return {
            "query_status": "ok",
            "data": {
                "tasks": [{
                    "yara_matches": [{"rule_name": "win_agenttesla"}],
                    "clamav_matches": ["Win.Trojan.AgentTesla"],
                }],
            },
        }

    monkeypatch.setattr(T, "fetch_json_post", fake_post)
    out = await T.yaraify_hash(h)
    assert out["yara"] == ["win_agenttesla"]
    assert out["clamav"] == ["Win.Trojan.AgentTesla"]


async def test_yaraify_hash_no_results(monkeypatch) -> None:
    h = "e" * 64

    async def fake_post(url, ttl, *, data=None, json_body=None, headers=None, browser_ua=False):
        return {"query_status": "no_results"}

    monkeypatch.setattr(T, "fetch_json_post", fake_post)
    out = await T.yaraify_hash(h)
    assert out["yara"] == []
    assert out["clamav"] == []
    assert out["note"]


async def test_emailrep_malicious(monkeypatch) -> None:
    async def fake_get(url, ttl, *, headers=None, browser_ua=False):
        assert "bad@example.com" in url
        return {
            "reputation": "low",
            "suspicious": True,
            "details": {
                "malicious_activity": True,
                "credentials_leaked": True,
                "profiles": ["twitter", "github"],
            },
        }

    monkeypatch.setattr(T, "fetch_json", fake_get)
    out = await T.emailrep("Bad@Example.com")
    assert out["email"] == "bad@example.com"
    assert out["reputation"] == "low"
    assert out["suspicious"] is True
    assert out["malicious"] is True
    assert out["breach"] is True
    assert out["profiles"] == ["twitter", "github"]


async def test_emailrep_clean(monkeypatch) -> None:
    async def fake_get(url, ttl, *, headers=None, browser_ua=False):
        return {"reputation": "high", "suspicious": False, "details": {}}

    monkeypatch.setattr(T, "fetch_json", fake_get)
    out = await T.emailrep("good@example.com")
    assert out["malicious"] is False
    assert out["breach"] is False
    assert out["profiles"] == []


async def test_emailrep_invalid() -> None:
    out = await T.emailrep("not-an-email")
    assert out["note"] == "invalid email"


async def test_phishstats_url_ok(monkeypatch) -> None:
    async def fake_get(url, ttl, *, headers=None, browser_ua=False):
        assert "evil.test" in url
        return [{"score": 8, "tld": "test", "ip": "1.2.3.4"}]

    monkeypatch.setattr(T, "fetch_json", fake_get)
    out = await T.phishstats_url("http://evil.test/x")
    assert out["score"] == 8
    assert out["tld"] == "test"
    assert out["ip"] == "1.2.3.4"
    assert out["count"] == 1


async def test_phishstats_url_empty(monkeypatch) -> None:
    async def fake_get(url, ttl, *, headers=None, browser_ua=False):
        return []

    monkeypatch.setattr(T, "fetch_json", fake_get)
    out = await T.phishstats_url("http://benign.test/x")
    assert out["score"] is None
    assert out["count"] == 0
