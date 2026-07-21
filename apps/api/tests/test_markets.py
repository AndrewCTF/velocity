"""app.markets — keyless quotes/predictions + composite stress signal.

Stooq's quote endpoint 404s and its history endpoint serves a JS
proof-of-work challenge from this egress, so most of these exercise the
FRED fallback chain (see markets.py module docstring for the live probe
evidence) — every fixture below is canned, matching the documented
CSV/JSON shapes rather than live capture.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import httpx
import pytest

from app import markets, upstream

STOOQ_QUOTES_CSV = (
    "Symbol,Date,Time,Open,High,Low,Close,Volume\r\n"
    "^spx,2026-07-20,22:00:00,6300.0,6320.0,6290.0,6280.0,0\r\n"
    "^ndq,2026-07-20,22:00:00,22000.0,22100.0,21900.0,21850.0,0\r\n"
    "^dax,2026-07-20,22:00:00,18500.0,18600.0,18400.0,18550.0,0\r\n"
    "^nkx,2026-07-20,22:00:00,39000.0,39200.0,38900.0,39100.0,0\r\n"
    "cl.f,2026-07-20,22:00:00,80.0,82.0,79.5,81.0,0\r\n"
    "gc.f,2026-07-20,22:00:00,2400.0,2450.0,2395.0,2440.0,0\r\n"
    "ng.f,2026-07-20,22:00:00,3.0,3.1,2.9,3.05,0\r\n"
    "eurusd,2026-07-20,22:00:00,1.08,1.085,1.075,1.078,0\r\n"
    "usdjpy,2026-07-20,22:00:00,157.0,158.0,156.5,157.5,0\r\n"
)

def _fred_csv(series_id: str, rows: list[tuple[str, str]]) -> str:
    """Build a canned single-series fredgraph.csv body (oldest-first).

    `rows` is `(date, value)` pairs; pass `"."` (or `""`) as the value for a
    missing observation, matching FRED's own vintages (both forms appear in
    the wild — see markets.py module docstring).
    """
    lines = [f"observation_date,{series_id}"]
    lines.extend(f"{date},{value}" for date, value in rows)
    return "\r\n".join(lines)


# 26 daily rows (2026-06-01..26), one per FRED fallback series, shaped to
# match the equivalent stooq history fixtures further down so the two paths
# are directly comparable in the fallback-chain tests.
SP500_FRED_CSV = _fred_csv(
    "SP500", [(f"2026-06-{d:02d}", str(6000 + d)) for d in range(1, 26)]
)
NASDAQCOM_FRED_CSV = _fred_csv("NASDAQCOM", [("2026-07-16", "25881.95"), ("2026-07-17", "25520.24")])
DCOILWTICO_FRED_CSV = _fred_csv(
    "DCOILWTICO", [(f"2026-06-{d:02d}", str(80 - (d % 5))) for d in range(1, 26)]
)
DHHNGSP_FRED_CSV = _fred_csv("DHHNGSP", [("2026-07-09", "3.17"), ("2026-07-10", "2.73")])
DEXUSEU_FRED_CSV = _fred_csv(
    "DEXUSEU", [(f"2026-06-{d:02d}", f"{1.08 - d * 0.001:.4f}") for d in range(1, 26)]
)
DEXJPUS_FRED_CSV = _fred_csv(
    "DEXJPUS", [(f"2026-06-{d:02d}", f"{157 + d * 0.05:.2f}") for d in range(1, 26)]
)
# One missing observation (weekend) in the middle, exercising the "." drop path.
VIXCLS_FRED_CSV = _fred_csv(
    "VIXCLS",
    [(f"2026-06-{d:02d}", "." if d == 15 else f"{15.0 + d * 0.4:.2f}") for d in range(1, 26)],
)

COINGECKO_PRICE = {
    "bitcoin": {"usd": 66807.0, "usd_24h_change": 3.79},
    "ethereum": {"usd": 1939.53, "usd_24h_change": 4.14},
}

GAMMA_EVENTS = [
    {
        "title": "Iran leader end of 2026?",
        "slug": "iran-leader-end-of-2026",
        "tags": [{"label": "Middle East"}, {"label": "Geopolitics"}, {"label": "Iran"}],
        "volume24hr": 437956.56,
        "markets": [
            {
                "outcomes": json.dumps(["Yes", "No"]),
                "outcomePrices": json.dumps(["0.055", "0.945"]),
            }
        ],
    },
    {
        "title": "Will Trump be in the WC Champions Photo?",
        "slug": "will-trump-be-in-the-wc-champions-photo",
        "tags": [{"label": "Trump"}, {"label": "Soccer"}, {"label": "Sports"}, {"label": "Culture"}],
        "volume24hr": 5076260.9,
        "markets": [
            {
                "outcomes": json.dumps(["Yes", "No"]),
                "outcomePrices": json.dumps(["0.3", "0.7"]),
            }
        ],
    },
    {
        "title": "LoL: Gen.G vs T1 (BO1)",
        "slug": "lol-geng-vs-t1",
        "tags": [{"label": "Esports"}, {"label": "Games"}, {"label": "Sports"}],
        "volume24hr": 1428661.9,
        "markets": [
            {"outcomes": json.dumps(["Yes", "No"]), "outcomePrices": json.dumps(["0.5", "0.5"])}
        ],
    },
]


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


def _route(routes: dict[str, Any]):
    """Patch httpx.AsyncClient.get to dispatch on URL substring -> canned body.

    `routes` maps a URL substring to either a str (served as text/CSV) or a
    JSON-serialisable object (served as application/json); a substring absent
    from `routes` gets a 404 with an empty body, mimicking a dead upstream.
    """

    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        for needle, body in routes.items():
            if needle in url:
                if isinstance(body, str):
                    return httpx.Response(200, text=body, request=httpx.Request("GET", url))
                return httpx.Response(200, json=body, request=httpx.Request("GET", url))
        return httpx.Response(404, text="not found", request=httpx.Request("GET", url))

    return patch.object(httpx.AsyncClient, "get", new=fake_get)


# ---------------------------------------------------------------------------
# snapshot()
# ---------------------------------------------------------------------------


async def test_snapshot_happy_path() -> None:
    with _route({"stooq.com/q/l/": STOOQ_QUOTES_CSV, "coingecko.com": COINGECKO_PRICE}):
        snap = await markets.snapshot()

    assert snap["unavailable"] is False
    assert {r["symbol"] for r in snap["indices"]} == {"SPX", "NDQ", "DAX", "NKX"}
    assert {r["symbol"] for r in snap["commodities"]} == {"CL", "GC", "NG"}
    assert {r["symbol"] for r in snap["fx"]} == {"EURUSD", "USDJPY"}
    assert {r["symbol"] for r in snap["crypto"]} == {"BTC", "ETH"}

    spx = next(r for r in snap["indices"] if r["symbol"] == "SPX")
    assert spx["last"] == 6280.0
    # (6280 - 6300) / 6300 * 100
    assert spx["change_pct_24h"] == pytest.approx(-0.3175, abs=1e-3)
    assert spx["ts"] == "2026-07-20T22:00:00Z"

    btc = next(r for r in snap["crypto"] if r["symbol"] == "BTC")
    assert btc["last"] == 66807.0
    assert btc["change_pct_24h"] == pytest.approx(3.79)


async def test_snapshot_all_sources_down_is_unavailable() -> None:
    with _route({}):
        snap = await markets.snapshot()

    assert snap["unavailable"] is True
    assert snap["indices"] == []
    assert snap["commodities"] == []
    assert snap["fx"] == []
    assert snap["crypto"] == []


async def test_snapshot_partial_degrade_stays_available() -> None:
    # Stooq AND every FRED fallback dead, CoinGecko fine -> crypto populated,
    # other buckets empty, but `unavailable` stays False because SOMETHING
    # came back.
    with _route({"coingecko.com": COINGECKO_PRICE}):
        snap = await markets.snapshot()

    assert snap["unavailable"] is False
    assert snap["indices"] == []
    assert len(snap["crypto"]) == 2


async def test_snapshot_stooq_down_uses_fred_fallback() -> None:
    # Stooq's quote batch is dead (no "stooq.com/q/l/" route), but every
    # mapped symbol has a live FRED proxy plus VIX (FRED-only) — chain
    # fallback order is stooq first, FRED second, per symbol.
    with _route(
        {
            "id=SP500": SP500_FRED_CSV,
            "id=NASDAQCOM": NASDAQCOM_FRED_CSV,
            "id=DCOILWTICO": DCOILWTICO_FRED_CSV,
            "id=DHHNGSP": DHHNGSP_FRED_CSV,
            "id=DEXUSEU": DEXUSEU_FRED_CSV,
            "id=DEXJPUS": DEXJPUS_FRED_CSV,
            "id=VIXCLS": VIXCLS_FRED_CSV,
            "coingecko.com": COINGECKO_PRICE,
        }
    ):
        snap = await markets.snapshot()

    assert snap["unavailable"] is False
    index_symbols = {r["symbol"] for r in snap["indices"]}
    # DAX/Nikkei have no FRED proxy (see module docstring) and stay absent.
    assert index_symbols == {"SPX", "NDQ", "VIX"}
    ndq = next(r for r in snap["indices"] if r["symbol"] == "NDQ")
    assert ndq["name"] == "Nasdaq Composite"  # relabelled, not silently swapped
    vix = next(r for r in snap["indices"] if r["symbol"] == "VIX")
    assert vix["last"] == pytest.approx(25.0)
    assert vix["ts"] == "2026-06-25T00:00:00Z"

    commodity_symbols = {r["symbol"] for r in snap["commodities"]}
    # Gold has no FRED proxy (see module docstring) and stays absent.
    assert commodity_symbols == {"CL", "NG"}
    assert {r["symbol"] for r in snap["fx"]} == {"EURUSD", "USDJPY"}


async def test_snapshot_symbol_with_no_fred_fallback_stays_absent_when_stooq_down() -> None:
    # Only SP500's FRED proxy is live; DAX/Nikkei/gold have no FRED mapping
    # at all (see module docstring) so they never even attempt a fallback
    # fetch — they just stay out of their bucket.
    with _route({"id=SP500": SP500_FRED_CSV}):
        snap = await markets.snapshot()

    assert {r["symbol"] for r in snap["indices"]} == {"SPX"}
    assert snap["commodities"] == []


# ---------------------------------------------------------------------------
# predictions()
# ---------------------------------------------------------------------------


async def test_predictions_filters_geopolitical_from_sports_and_esports() -> None:
    with _route({"gamma-api.polymarket.com": GAMMA_EVENTS}):
        result = await markets.predictions()

    assert result["unavailable"] is False
    questions = {item["question"] for item in result["items"]}
    assert questions == {"Iran leader end of 2026?"}
    iran = result["items"][0]
    assert iran["prob"] == pytest.approx(0.055)
    assert iran["volume_24h"] == pytest.approx(437956.56)
    assert iran["url"] == "https://polymarket.com/event/iran-leader-end-of-2026"


async def test_predictions_upstream_down_is_unavailable() -> None:
    with _route({}):
        result = await markets.predictions()

    assert result == {"items": [], "unavailable": True}


# ---------------------------------------------------------------------------
# compute_stress() — pure math, hand-built inputs
# ---------------------------------------------------------------------------


def test_compute_stress_all_components_present_exact_score() -> None:
    inputs = {
        "spx_last": 5700.0,
        "spx_30d_high": 6000.0,  # 5% drawdown -> normalized 0.5
        "vix_last": 25.0,  # (25-15)/20 -> normalized 0.5
        "gold_5d_pct": 4.0,  # +4% -> normalized 0.5
        "oil_5d_pct": -5.0,  # |5%| -> normalized 0.5
        "usd_strength_eur_5d_pct": 2.5,  # avg 2.5 -> normalized 0.5
        "usd_strength_jpy_5d_pct": 2.5,
        "btc_last": 54000.0,
        "btc_30d_high": 60000.0,  # 10% drawdown -> normalized 0.5
    }
    result = markets.compute_stress(inputs)

    assert result["degraded"] is False
    # Every component normalizes to exactly 0.5 by construction -> score = 50.
    assert result["score"] == pytest.approx(50.0)
    assert len(result["components"]) == 6
    weights = {c["key"]: c["weight"] for c in result["components"]}
    assert weights == pytest.approx(
        {
            "equity_drawdown": 0.30,
            "vix_level": 0.25,
            "gold_move": 0.15,
            "oil_move": 0.15,
            "usd_flight": 0.10,
            "btc_drawdown": 0.05,
        }
    )
    equity = next(c for c in result["components"] if c["key"] == "equity_drawdown")
    assert equity["value"] == pytest.approx(5.0)
    assert equity["normalized"] == pytest.approx(0.5)
    assert equity["inputs"] == {"spx_last": 5700.0, "spx_30d_high": 6000.0}
    vix = next(c for c in result["components"] if c["key"] == "vix_level")
    assert vix["value"] == pytest.approx(25.0)
    assert vix["normalized"] == pytest.approx(0.5)
    assert vix["inputs"] == {"vix_last": 25.0}


def test_compute_stress_renormalizes_when_component_missing() -> None:
    # Drop btc entirely (source down) — remaining weights (.30/.25/.15/.15/.10)
    # renormalize over their own sum (0.95) rather than staying at face value.
    inputs = {
        "spx_last": 5700.0,
        "spx_30d_high": 6000.0,
        "vix_last": 25.0,
        "gold_5d_pct": 4.0,
        "oil_5d_pct": -5.0,
        "usd_strength_eur_5d_pct": 2.5,
        "usd_strength_jpy_5d_pct": 2.5,
        "btc_last": None,
        "btc_30d_high": None,
    }
    result = markets.compute_stress(inputs)

    assert result["degraded"] is True
    assert len(result["components"]) == 5
    weights = {c["key"]: c["weight"] for c in result["components"]}
    assert weights["equity_drawdown"] == pytest.approx(0.30 / 0.95, abs=1e-4)
    assert weights["vix_level"] == pytest.approx(0.25 / 0.95, abs=1e-4)
    assert weights["oil_move"] == pytest.approx(0.15 / 0.95, abs=1e-4)
    assert sum(weights.values()) == pytest.approx(1.0, abs=1e-3)
    # Every present component still normalizes to 0.5 -> renormalized score still 50.
    assert result["score"] == pytest.approx(50.0)


def test_compute_stress_gold_decline_does_not_add_negative_stress() -> None:
    inputs = {"gold_5d_pct": -6.0}
    result = markets.compute_stress(inputs)
    gold = next(c for c in result["components"] if c["key"] == "gold_move")
    assert gold["value"] == pytest.approx(-6.0)
    assert gold["normalized"] == 0.0


def test_compute_stress_all_sources_down_is_zero_not_none() -> None:
    result = markets.compute_stress({})

    assert result == {"score": 0, "components": [], "degraded": True}


# ---------------------------------------------------------------------------
# market_stress() — end-to-end through the (canned) upstreams
# ---------------------------------------------------------------------------

SPX_HISTORY_CSV = "Date,Open,High,Low,Close,Volume\r\n" + "\r\n".join(
    f"2026-06-{d:02d},6000,6050,5950,{6000 + d},0" for d in range(1, 26)
)
GOLD_HISTORY_CSV = "Date,Open,High,Low,Close,Volume\r\n" + "\r\n".join(
    f"2026-06-{d:02d},2400,2420,2380,{2400 + d},0" for d in range(1, 26)
)
OIL_HISTORY_CSV = "Date,Open,High,Low,Close,Volume\r\n" + "\r\n".join(
    f"2026-06-{d:02d},80,82,78,{80 - (d % 5)},0" for d in range(1, 26)
)
EUR_HISTORY_CSV = "Date,Open,High,Low,Close,Volume\r\n" + "\r\n".join(
    f"2026-06-{d:02d},1.08,1.09,1.07,{1.08 - d * 0.001:.4f},0" for d in range(1, 26)
)
JPY_HISTORY_CSV = "Date,Open,High,Low,Close,Volume\r\n" + "\r\n".join(
    f"2026-06-{d:02d},157,158,156,{157 + d * 0.05:.2f},0" for d in range(1, 26)
)
COINGECKO_BTC_HISTORY = {"prices": [[1700000000000 + i, 50000.0 + i * 10] for i in range(30)]}


async def test_market_stress_all_sources_live_has_all_six_components() -> None:
    with _route(
        {
            "s=^spx": SPX_HISTORY_CSV,
            "s=gc.f": GOLD_HISTORY_CSV,
            "s=cl.f": OIL_HISTORY_CSV,
            "s=eurusd": EUR_HISTORY_CSV,
            "s=usdjpy": JPY_HISTORY_CSV,
            "market_chart": COINGECKO_BTC_HISTORY,
            "id=VIXCLS": VIXCLS_FRED_CSV,
        }
    ):
        result = await markets.market_stress()

    assert result["degraded"] is False
    assert {c["key"] for c in result["components"]} == {
        "equity_drawdown",
        "vix_level",
        "gold_move",
        "oil_move",
        "usd_flight",
        "btc_drawdown",
    }
    assert sum(c["weight"] for c in result["components"]) == pytest.approx(1.0)
    assert 0 <= result["score"] <= 100


async def test_market_stress_end_to_end_degrades_missing_sources() -> None:
    # SPX + gold history live, oil/eur/jpy/btc/vix dead -> degraded True,
    # only equity_drawdown + gold_move present, weights renormalize over .45.
    with _route(
        {
            "s=^spx": SPX_HISTORY_CSV,
            "s=gc.f": GOLD_HISTORY_CSV,
        }
    ):
        result = await markets.market_stress()

    assert result["degraded"] is True
    keys = {c["key"] for c in result["components"]}
    assert keys == {"equity_drawdown", "gold_move"}
    assert sum(c["weight"] for c in result["components"]) == pytest.approx(1.0)
    assert "asof_utc" in result


async def test_market_stress_stooq_down_uses_fred_history_fallback() -> None:
    # Stooq history entirely dead (no "s=" routes at all) but the FRED
    # equivalents are live for spx/oil/eur/jpy + vix (FRED-only) — gold has
    # no FRED proxy (see module docstring) so it alone stays missing.
    with _route(
        {
            "id=SP500": SP500_FRED_CSV,
            "id=DCOILWTICO": DCOILWTICO_FRED_CSV,
            "id=DEXUSEU": DEXUSEU_FRED_CSV,
            "id=DEXJPUS": DEXJPUS_FRED_CSV,
            "id=VIXCLS": VIXCLS_FRED_CSV,
            "market_chart": COINGECKO_BTC_HISTORY,
        }
    ):
        result = await markets.market_stress()

    assert result["degraded"] is True
    keys = {c["key"] for c in result["components"]}
    assert keys == {"equity_drawdown", "vix_level", "oil_move", "usd_flight", "btc_drawdown"}
    assert sum(c["weight"] for c in result["components"]) == pytest.approx(1.0, abs=1e-3)


async def test_market_stress_stooq_and_fred_both_down_degrades_that_component() -> None:
    # SPX live via stooq, but oil is down on BOTH stooq and FRED — dropped,
    # not silently substituted from a different series.
    with _route({"s=^spx": SPX_HISTORY_CSV}):
        result = await markets.market_stress()

    keys = {c["key"] for c in result["components"]}
    assert "oil_move" not in keys
    assert keys == {"equity_drawdown"}


async def test_market_stress_all_sources_down() -> None:
    with _route({}):
        result = await markets.market_stress()

    assert result["score"] == 0
    assert result["components"] == []
    assert result["degraded"] is True
