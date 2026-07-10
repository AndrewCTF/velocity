"""Crypto wallet/tx OSINT connectors: balance math, tx shape, degrade-to-note."""

from __future__ import annotations

from typing import Any

from app.osint.sources import crypto as C

BTC_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
ETH_ADDR = "0x000000000000000000000000000000000000dEaD"


def _mempool_stats() -> dict[str, Any]:
    return {"chain_stats": {"funded_txo_sum": 5000, "spent_txo_sum": 2000, "tx_count": 3}}


def _mempool_txs() -> list[dict[str, Any]]:
    return [
        {
            "txid": "abc123",
            "vin": [{"prevout": {"scriptpubkey_address": "sender1"}}],
            "vout": [
                {"scriptpubkey_address": BTC_ADDR, "value": 1000},
                {"scriptpubkey_address": "recipient2", "value": 500},
            ],
        },
        {
            "txid": "def456",
            "vin": [{"prevout": {}}],  # no address on this input — must not crash
            "vout": [{"scriptpubkey_address": "recipient3", "value": 200}],
        },
    ]


async def test_mempool_btc_address_balance_and_txs(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        if url.endswith("/txs"):
            return _mempool_txs()
        return _mempool_stats()

    monkeypatch.setattr(C, "fetch_json", fake)

    out = await C.mempool_btc_address(BTC_ADDR)

    assert out["address"] == BTC_ADDR
    assert out["chain"] == "btc"
    assert out["funded"] == 5000
    assert out["spent"] == 2000
    assert out["balance"] == 3000  # funded - spent
    assert out["tx_count"] == 3
    assert len(out["txs"]) == 2
    first = out["txs"][0]
    assert first["txid"] == "abc123"
    assert first["value"] == 1500  # sum of vout values
    assert first["inputs"] == ["sender1"]
    assert first["outputs"] == [BTC_ADDR, "recipient2"]
    second = out["txs"][1]
    assert second["inputs"] == []  # missing prevout address handled gracefully
    assert second["outputs"] == ["recipient3"]


async def test_mempool_btc_address_caps_tx_list_at_25(monkeypatch) -> None:
    many_txs = [
        {"txid": f"tx{i}", "vin": [], "vout": [{"scriptpubkey_address": "x", "value": 1}]}
        for i in range(60)
    ]

    async def fake(url, ttl, **kw):
        if url.endswith("/txs"):
            return many_txs
        return _mempool_stats()

    monkeypatch.setattr(C, "fetch_json", fake)

    out = await C.mempool_btc_address(BTC_ADDR)
    assert len(out["txs"]) == 25
    assert out["tx_count"] == 3  # honest total from chain_stats, independent of list cap


async def test_mempool_btc_address_invalid_addr_degrades() -> None:
    out = await C.mempool_btc_address("not-a-wallet")
    assert out["txs"] == []
    assert "note" in out


async def test_mempool_btc_address_upstream_down_degrades(monkeypatch) -> None:
    async def fake_none(url, ttl, **kw):
        return None

    monkeypatch.setattr(C, "fetch_json", fake_none)
    out = await C.mempool_btc_address(BTC_ADDR)
    assert out["txs"] == []
    assert "note" in out


async def test_blockstream_btc_balance(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return {"chain_stats": {"funded_txo_sum": 900, "spent_txo_sum": 400, "tx_count": 5}}

    monkeypatch.setattr(C, "fetch_json", fake)
    out = await C.blockstream_btc(BTC_ADDR)
    assert out["chain"] == "btc"
    assert out["funded"] == 900
    assert out["spent"] == 400
    assert out["balance"] == 500
    assert out["tx_count"] == 5


async def test_blockstream_btc_rejects_eth_address() -> None:
    out = await C.blockstream_btc(ETH_ADDR)
    assert "note" in out


async def test_blockstream_btc_upstream_down_degrades(monkeypatch) -> None:
    async def fake_none(url, ttl, **kw):
        return None

    monkeypatch.setattr(C, "fetch_json", fake_none)
    out = await C.blockstream_btc(BTC_ADDR)
    assert "note" in out


async def test_blockchair_address_shape(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        return {
            "data": {
                BTC_ADDR: {
                    "address": {"balance": 12345, "transaction_count": 2},
                    "transactions": ["tx1", "tx2"],
                }
            }
        }

    monkeypatch.setattr(C, "fetch_json", fake)
    out = await C.blockchair_address("bitcoin", BTC_ADDR)
    assert out["chain"] == "bitcoin"
    assert out["balance"] == 12345
    assert out["tx_count"] == 2
    assert out["txs"] == ["tx1", "tx2"]


async def test_blockchair_address_unsupported_chain_degrades() -> None:
    out = await C.blockchair_address("dogecoinjs", BTC_ADDR)
    assert "note" in out


async def test_blockchair_address_upstream_down_degrades(monkeypatch) -> None:
    async def fake_none(url, ttl, **kw):
        return None

    monkeypatch.setattr(C, "fetch_json", fake_none)
    out = await C.blockchair_address("bitcoin", BTC_ADDR)
    assert out["balance"] == 0
    assert out["txs"] == []
    assert "note" in out


async def test_blockscout_evm_balance_and_tokens(monkeypatch) -> None:
    async def fake(url, ttl, **kw):
        if url.endswith("/token-balances"):
            return [
                {"token": {"name": "USD Coin", "symbol": "USDC", "address": "0xusdc"}, "value": "1000000"},
                {"token": {"name": "Wrapped Ether", "symbol": "WETH", "address": "0xweth"}, "value": "2000"},
            ]
        return {"coin_balance": "42000000000000000000", "hash": ETH_ADDR}

    monkeypatch.setattr(C, "fetch_json", fake)
    out = await C.blockscout_evm(ETH_ADDR)
    assert out["address"] == ETH_ADDR.lower()  # normalise_wallet lower-cases eth hex
    assert out["chain"] == "eth"
    assert out["balance"] == 42000000000000000000
    assert len(out["tokens"]) == 2
    assert out["tokens"][0] == {"name": "USD Coin", "symbol": "USDC", "address": "0xusdc"}


async def test_blockscout_evm_caps_tokens_at_25(monkeypatch) -> None:
    many_tokens = [
        {"token": {"name": f"Token{i}", "symbol": f"T{i}", "address": f"0x{i}"}, "value": "1"}
        for i in range(60)
    ]

    async def fake(url, ttl, **kw):
        if url.endswith("/token-balances"):
            return many_tokens
        return {"coin_balance": "0"}

    monkeypatch.setattr(C, "fetch_json", fake)
    out = await C.blockscout_evm(ETH_ADDR)
    assert len(out["tokens"]) == 25


async def test_blockscout_evm_rejects_btc_address() -> None:
    out = await C.blockscout_evm(BTC_ADDR)
    assert out["tokens"] == []
    assert "note" in out


async def test_blockscout_evm_upstream_down_degrades(monkeypatch) -> None:
    async def fake_none(url, ttl, **kw):
        return None

    monkeypatch.setattr(C, "fetch_json", fake_none)
    out = await C.blockscout_evm(ETH_ADDR)
    assert out["balance"] == 0
    assert out["tokens"] == []
    assert "note" in out
