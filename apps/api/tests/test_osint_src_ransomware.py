"""Unit tests for `app/osint/sources/ransomware.py` — no live network.

The upstream answers three different things with a JSON body, and the whole
point of this connector is telling them apart: real rows, a genuine no-match,
and a 429 rate limit. Reporting the third as the second is an all-clear nobody
earned, so that is the first thing asserted here.

Payloads are trimmed from what api.ransomware.live actually returned on
2026-08-29, including the placeholder-domain records that its `killsec` posts
carry.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.osint.sources import ransomware as R


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    R._ANSWERS.clear()


class _Resp:
    def __init__(self, status: int, body: Any) -> None:
        self.status_code = status
        self._body = body
        self.content = b"x" if body is not None else b""

    def json(self) -> Any:
        if self._body is None:
            raise ValueError("no body")
        return self._body


def _client(resp: _Resp | Exception):  # type: ignore[no-untyped-def]
    class C:
        calls = 0

        async def get(self, url: str, **kw: object) -> _Resp:
            C.calls += 1
            if isinstance(resp, Exception):
                raise resp
            return resp

    return C()


def _patch(monkeypatch: pytest.MonkeyPatch, resp: _Resp | Exception):  # type: ignore[no-untyped-def]
    c = _client(resp)
    monkeypatch.setattr(R, "get_client", lambda: c)
    return c


_ROWS = [
    {"victim": "cnnindonesia.com", "group": "incransom", "domain": "cnnindonesia.com",
     "country": "ID", "activity": "Retail & E-Commerce",
     "attackdate": "2025-01-05T00:00:00+00:00",
     "discovered": "2025-01-28T12:40:08.723458+00:00",
     "claim_url": "http://incblog.onion/blog/x", "description": "a" * 900},
    {"victim": "Other Co", "group": "qilin", "domain": "other.example",
     "country": "US", "discovered": "2026-05-06T10:07:20.979408+00:00"},
    {"victim": "www variant", "group": "qilin", "domain": "www.cnnindonesia.com",
     "country": "ID", "discovered": "2024-01-01T00:00:00+00:00"},
]

_RATE_LIMIT = _Resp(429, {"message": "1 per 1 minute"})
_NO_MATCH = _Resp(200, {"error": "No victims found for keyword 'zzz.com'."})


# ── the distinction the module exists for ─────────────────────────────────


async def test_rate_limit_is_never_reported_as_clean(monkeypatch) -> None:
    _patch(monkeypatch, _RATE_LIMIT)
    out = await R.ransomware_domain("cnnindonesia.com")
    assert out["checked"] is False
    assert out["count"] == 0
    assert "rate limited" in out["note"]


async def test_no_match_is_reported_as_checked_and_clean(monkeypatch) -> None:
    _patch(monkeypatch, _NO_MATCH)
    out = await R.ransomware_domain("zzz.com")
    assert out["checked"] is True
    assert out["count"] == 0 and out["searched"] == 0
    assert "note" not in out


async def test_outage_is_not_clean_either(monkeypatch) -> None:
    _patch(monkeypatch, RuntimeError("connection reset"))
    out = await R.ransomware_domain("cnnindonesia.com")
    assert out["checked"] is False and out["note"]


# ── exact-domain filtering ────────────────────────────────────────────────


async def test_domain_filter_is_exact_and_accepts_www(monkeypatch) -> None:
    # The upstream search is fuzzy — it matches the crews' description text —
    # so the ranking is never trusted; the record's own domain field is.
    _patch(monkeypatch, _Resp(200, _ROWS))
    out = await R.ransomware_domain("cnnindonesia.com")
    assert out["checked"] is True
    assert out["searched"] == 3
    assert out["count"] == 2
    assert {v["victim"] for v in out["victims"]} == {"cnnindonesia.com", "www variant"}
    assert "Other Co" not in {v["victim"] for v in out["victims"]}


async def test_victims_are_newest_first(monkeypatch) -> None:
    _patch(monkeypatch, _Resp(200, _ROWS))
    out = await R.ransomware_search("anything")
    discovered = [v["discovered"] for v in out["victims"]]
    assert discovered == sorted(discovered, reverse=True)


async def test_placeholder_domain_is_refused_without_a_fetch(monkeypatch) -> None:
    # killsec files unattributed victims under literal example.com; an exact
    # match there returns records about somebody else entirely.
    c = _patch(monkeypatch, _Resp(200, _ROWS))
    out = await R.ransomware_domain("example.com")
    assert out["checked"] is False
    assert "placeholder" in out["note"]
    assert type(c).calls == 0


async def test_attacker_prose_is_truncated(monkeypatch) -> None:
    _patch(monkeypatch, _Resp(200, _ROWS))
    out = await R.ransomware_search("x")
    victim = next(v for v in out["victims"] if v["victim"] == "cnnindonesia.com")
    assert len(victim["description"]) == 400


async def test_groups_and_country_counts_are_derived(monkeypatch) -> None:
    _patch(monkeypatch, _Resp(200, _ROWS))
    out = await R.ransomware_search("x")
    assert out["groups"] == ["incransom", "qilin"]
    assert out["country_counts"] == {"ID": 2, "US": 1}


# ── caching ───────────────────────────────────────────────────────────────


async def test_an_answer_is_cached_but_a_rate_limit_is_not(monkeypatch) -> None:
    c = _patch(monkeypatch, _Resp(200, _ROWS))
    await R.ransomware_search("acme")
    await R.ransomware_search("acme")
    assert type(c).calls == 1, "an answer must be cached"

    c2 = _patch(monkeypatch, _RATE_LIMIT)
    await R.ransomware_search("other")
    await R.ransomware_search("other")
    # Caching a 429 for the answer TTL would blind that target for six hours.
    assert type(c2).calls == 2, "a rate limit must not be cached"


async def test_empty_query_never_fetches(monkeypatch) -> None:
    c = _patch(monkeypatch, _Resp(200, _ROWS))
    out = await R.ransomware_search("   ")
    assert out["note"] == "empty query"
    assert type(c).calls == 0


# ── group profile ─────────────────────────────────────────────────────────


async def test_group_profile_shape(monkeypatch) -> None:
    _patch(monkeypatch, _Resp(200, {
        "name": "qilin", "altname": "Agenda", "description": "d" * 900,
        "added_date": "2022-10-01",
        "locations": [{"fqdn": "http://x.onion", "available": True,
                       "lastscrape": "2026-08-28"}],
        "tools": ["cobaltstrike"], "ttps": ["T1486"],
    }))
    from app.osint import fetch as F

    async def fake_fetch(url: str, ttl: float, **kw: object) -> Any:
        return {
            "name": "qilin", "altname": "Agenda", "description": "d" * 900,
            "added_date": "2022-10-01",
            "locations": [{"fqdn": "http://x.onion", "available": True,
                           "lastscrape": "2026-08-28"}],
            "tools": ["cobaltstrike"], "ttps": ["T1486"],
        }

    monkeypatch.setattr(R, "fetch_json", fake_fetch)
    _ = F
    out = await R.ransomware_group("Qilin")
    assert out["found"] is True and out["group"] == "qilin"
    assert out["locations"][0]["url"] == "http://x.onion"
    assert out["ttps"] == ["T1486"]
    assert len(out["description"]) == 600


async def test_group_name_is_validated_before_it_reaches_a_url(monkeypatch) -> None:
    async def boom(*a: object, **k: object) -> None:
        raise AssertionError("must validate before fetching")

    monkeypatch.setattr(R, "fetch_json", boom)
    out = await R.ransomware_group("../../etc/passwd")
    assert out["found"] is False and "invalid" in out["note"]
