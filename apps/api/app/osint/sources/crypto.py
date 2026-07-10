"""Keyless-first crypto wallet/tx OSINT connectors (BTC + EVM).

  mempool_btc_address  — mempool.space (balance + bounded tx list, primary BTC)
  blockstream_btc       — blockstream.info (cross-check/fallback BTC balance)
  blockchair_address     — Blockchair multi-chain dashboard (key-optional)
  blockscout_evm         — Blockscout (ETH balance + ERC-20 token holdings)

Each returns a plain, normalised dict and never raises on upstream failure —
a dead/rate-limited source degrades to an empty result + a ``note`` (same
contract as ``app/osint/connectors.py``). Callers pass a raw address string;
these connectors validate/parse the chain themselves (``normalise_wallet``
returns a canonical ``"chain:addr"`` pair which we split back apart, since the
upstream URLs need the bare address).
"""

from __future__ import annotations

from typing import Any

from app.osint.fetch import fetch_json, normalise_wallet

# Blockchair chain slugs we accept for `blockchair_address`. Mirrors the
# service's own dashboard slugs; anything else degrades to a note rather than
# a mangled request.
_BLOCKCHAIR_CHAINS = {"bitcoin", "ethereum", "litecoin", "dogecoin"}


def _split_wallet(addr: str, want_chain: str | None = None) -> str | None:
    """Validate ``addr`` via ``normalise_wallet`` and return the bare address.

    ``normalise_wallet`` returns ``"btc:<addr>"`` / ``"eth:0x…"``; the upstream
    URLs here need just the address. When ``want_chain`` is given, the parsed
    chain must match (e.g. a BTC-only connector rejects an ETH address).
    """
    canon = normalise_wallet(addr)
    if canon is None:
        return None
    chain, _, bare = canon.partition(":")
    if want_chain is not None and chain != want_chain:
        return None
    return bare


# ── mempool.space (primary BTC) ─────────────────────────────────────────────


async def mempool_btc_address(addr: str) -> dict[str, Any]:
    a = _split_wallet(addr, "btc")
    if a is None:
        return {"address": addr, "chain": "btc", "txs": [], "note": "invalid btc address"}

    stats = await fetch_json(f"https://mempool.space/api/address/{a}", 60.0)
    if not isinstance(stats, dict):
        return {"address": a, "chain": "btc", "txs": [], "note": "mempool.space unavailable"}

    chain_stats = stats.get("chain_stats") or {}
    funded = int(chain_stats.get("funded_txo_sum") or 0)
    spent = int(chain_stats.get("spent_txo_sum") or 0)
    tx_count = int(chain_stats.get("tx_count") or 0)

    txs_data = await fetch_json(f"https://mempool.space/api/address/{a}/txs", 60.0)
    txs: list[dict[str, Any]] = []
    if isinstance(txs_data, list):
        for tx in txs_data[:25]:
            if not isinstance(tx, dict):
                continue
            inputs = [
                str(vin["prevout"]["scriptpubkey_address"])
                for vin in (tx.get("vin") or [])
                if isinstance(vin, dict)
                and isinstance(vin.get("prevout"), dict)
                and vin["prevout"].get("scriptpubkey_address")
            ]
            outputs = [
                str(vout["scriptpubkey_address"])
                for vout in (tx.get("vout") or [])
                if isinstance(vout, dict) and vout.get("scriptpubkey_address")
            ]
            value = sum(
                int(vout.get("value") or 0)
                for vout in (tx.get("vout") or [])
                if isinstance(vout, dict)
            )
            txs.append(
                {
                    "txid": str(tx.get("txid", "")),
                    "value": value,
                    "inputs": inputs,
                    "outputs": outputs,
                }
            )

    return {
        "address": a,
        "chain": "btc",
        "funded": funded,
        "spent": spent,
        "balance": funded - spent,
        "tx_count": tx_count,
        "txs": txs,
    }


# ── blockstream.info (cross-check/fallback BTC) ─────────────────────────────


async def blockstream_btc(addr: str) -> dict[str, Any]:
    a = _split_wallet(addr, "btc")
    if a is None:
        return {"address": addr, "chain": "btc", "note": "invalid btc address"}

    data = await fetch_json(f"https://blockstream.info/api/address/{a}", 60.0)
    if not isinstance(data, dict):
        return {"address": a, "chain": "btc", "note": "blockstream.info unavailable"}

    chain_stats = data.get("chain_stats") or {}
    funded = int(chain_stats.get("funded_txo_sum") or 0)
    spent = int(chain_stats.get("spent_txo_sum") or 0)
    return {
        "address": a,
        "chain": "btc",
        "funded": funded,
        "spent": spent,
        "balance": funded - spent,
        "tx_count": int(chain_stats.get("tx_count") or 0),
    }


# ── Blockchair (multi-chain, key-optional) ──────────────────────────────────


async def blockchair_address(chain: str, addr: str) -> dict[str, Any]:
    c = (chain or "").strip().lower()
    if c not in _BLOCKCHAIR_CHAINS:
        return {"address": addr, "chain": chain, "note": "unsupported blockchair chain"}
    a = (addr or "").strip()
    if not a:
        return {"address": addr, "chain": c, "note": "invalid address"}

    from app.config import get_settings

    key = getattr(get_settings(), "blockchair_api_key", "") or ""
    url = f"https://api.blockchair.com/{c}/dashboards/address/{a}"
    if key:
        url += f"?key={key}"

    data = await fetch_json(url, 60.0)
    if not isinstance(data, dict):
        return {
            "address": a,
            "chain": c,
            "balance": 0,
            "tx_count": 0,
            "txs": [],
            "note": "blockchair unavailable",
        }

    entry = ((data.get("data") or {}).get(a)) or {}
    address_info = entry.get("address") or {}
    txs = [str(t) for t in (entry.get("transactions") or [])]
    return {
        "address": a,
        "chain": c,
        "balance": int(address_info.get("balance") or 0),
        "tx_count": int(address_info.get("transaction_count") or 0),
        "txs": txs[:25],
    }


# ── Blockscout (ETH balance + token holdings) ────────────────────────────────


async def blockscout_evm(addr: str) -> dict[str, Any]:
    a = _split_wallet(addr, "eth")
    if a is None:
        return {"address": addr, "chain": "eth", "tokens": [], "note": "invalid eth address"}

    data = await fetch_json(f"https://eth.blockscout.com/api/v2/addresses/{a}", 60.0)
    if not isinstance(data, dict):
        return {
            "address": a,
            "chain": "eth",
            "balance": 0,
            "tokens": [],
            "note": "blockscout unavailable",
        }

    balance = int(data.get("coin_balance") or 0)

    tokens_data = await fetch_json(
        f"https://eth.blockscout.com/api/v2/addresses/{a}/token-balances", 60.0
    )
    tokens: list[dict[str, Any]] = []
    if isinstance(tokens_data, list):
        for item in tokens_data[:25]:
            if not isinstance(item, dict):
                continue
            token = item.get("token") or {}
            if not isinstance(token, dict):
                continue
            tokens.append(
                {
                    "name": token.get("name"),
                    "symbol": token.get("symbol"),
                    "address": token.get("address"),
                }
            )

    return {
        "address": a,
        "chain": "eth",
        "balance": balance,
        "tokens": tokens,
    }
