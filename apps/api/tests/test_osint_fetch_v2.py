"""Phase 0 OSINT source expansion: new normalisers + classify_target routing.

Covers ``normalise_url`` / ``normalise_hash`` / ``normalise_wallet`` /
``normalise_asn`` and the extended ``classify_target`` order (docs/
osint-sources-plan.md, Phase 0). Pure functions — no network, no fixtures.
"""

from __future__ import annotations

from app.osint.fetch import (
    classify_target,
    normalise_asn,
    normalise_hash,
    normalise_url,
    normalise_wallet,
)

# ── normalise_url ──────────────────────────────────────────────────────────


def test_normalise_url_with_scheme() -> None:
    assert normalise_url("http://Evil.TEST/x") == "http://evil.test/x"
    assert normalise_url("HTTPS://Example.com/Path?Q=1") == "https://example.com/Path?Q=1"


def test_normalise_url_schemeless_with_path_or_query() -> None:
    assert normalise_url("example.com/foo") == "http://example.com/foo"
    assert normalise_url("example.com?q=1") == "http://example.com?q=1"


def test_normalise_url_bare_domain_is_none() -> None:
    # A bare domain has no scheme and no path/query — it must NOT classify as
    # a url (it belongs to normalise_domain / classify_target's domain arm).
    assert normalise_url("example.com") is None


def test_normalise_url_rejects_non_http_scheme_and_oversize() -> None:
    assert normalise_url("ftp://example.com/x") is None
    assert normalise_url("http://" + "a" * 2048 + ".com/x") is None
    assert normalise_url("") is None
    assert normalise_url("   ") is None


# ── normalise_hash ─────────────────────────────────────────────────────────


def test_normalise_hash_valid_lengths() -> None:
    import hashlib

    md5 = hashlib.md5(b"x").hexdigest()  # 32 hex chars
    sha1 = hashlib.sha1(b"x").hexdigest()  # 40 hex chars
    sha256 = hashlib.sha256(b"x").hexdigest()  # 64 hex chars
    assert normalise_hash(md5.upper()) == md5
    assert normalise_hash(sha1) == sha1
    assert normalise_hash(sha256) == sha256


def test_normalise_hash_invalid() -> None:
    assert normalise_hash("not-a-hash") is None
    assert normalise_hash("abc123") is None  # too short
    assert normalise_hash("g" * 32) is None  # non-hex char


# ── normalise_wallet ───────────────────────────────────────────────────────


def test_normalise_wallet_btc_base58() -> None:
    addr = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"  # real-looking BTC genesis addr
    assert normalise_wallet(addr) == f"btc:{addr}"


def test_normalise_wallet_btc_bech32() -> None:
    addr = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
    assert normalise_wallet(addr) == f"btc:{addr}"
    assert normalise_wallet(addr.upper()) == f"btc:{addr}"


def test_normalise_wallet_eth() -> None:
    addr = "0x" + "aB" * 20  # exactly 40 hex chars after 0x
    assert normalise_wallet(addr) == f"eth:{addr.lower()}"


def test_normalise_wallet_invalid() -> None:
    assert normalise_wallet("not-a-wallet") is None
    assert normalise_wallet("0x123") is None  # too short
    assert normalise_wallet("0x" + "g" * 40) is None  # non-hex
    assert normalise_wallet("torvalds") is None


# ── normalise_asn ──────────────────────────────────────────────────────────


def test_normalise_asn_valid() -> None:
    assert normalise_asn("AS15169") == "AS15169"
    assert normalise_asn("as15169") == "AS15169"
    assert normalise_asn("15169") == "AS15169"


def test_normalise_asn_invalid() -> None:
    assert normalise_asn("AS") is None
    assert normalise_asn("ASx123") is None
    assert normalise_asn("0") is None
    assert normalise_asn("AS" + "9" * 20) is None  # absurdly long


# ── classify_target: new kinds ─────────────────────────────────────────────


def test_classify_target_wallet_wins_over_username() -> None:
    # All-lowercase-alnum bech32 would otherwise satisfy the username regex;
    # wallet is earlier in the order so it must win.
    addr = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
    assert classify_target(addr) == ("wallet", f"btc:{addr}")


def test_classify_target_eth_wallet() -> None:
    addr = "0x" + "ab" * 20
    assert classify_target(addr) == ("wallet", f"eth:{addr}")


def test_classify_target_asn() -> None:
    assert classify_target("AS15169") == ("asn", "AS15169")


def test_classify_target_file_hash() -> None:
    import hashlib

    sha256 = hashlib.sha256(b"x").hexdigest()
    assert classify_target(sha256) == ("file", sha256)


def test_classify_target_url() -> None:
    assert classify_target("http://evil.test/x") == ("url", "http://evil.test/x")


def test_classify_target_bare_domain_not_url() -> None:
    # A bare domain must classify as "domain", never "url".
    assert classify_target("example.com") == ("domain", "example.com")


# ── classify_target: pre-existing kinds (regression) ───────────────────────


def test_classify_target_regression_existing_kinds() -> None:
    assert classify_target("1.2.3.4") == ("ip", "1.2.3.4")
    assert classify_target("Alice@Example.COM") == ("email", "alice@example.com")
    assert classify_target("example.com") == ("domain", "example.com")
    assert classify_target("torvalds") == ("username", "torvalds")
    assert classify_target("@torvalds") == ("username", "torvalds")
    assert classify_target("!!!") is None
