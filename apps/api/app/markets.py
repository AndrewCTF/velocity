"""Keyless market data + a transparent composite geopolitical-stress signal.

Four keyless upstreams, each degrading independently rather than raising:

- **Stooq** CSV quotes (indices/commodities/fx) + daily-history CSV (5d/30d
  baselines for the stress signal). PROBE NOTE (2026-07-21, this egress): the
  `/q/l/` batch-quote endpoint 404s unconditionally (every symbol shape
  tried, incl. the documented `s=^spx,...&f=sd2t2ohlcv&h&e=csv` form and a
  bare `aapl.us` — the path itself appears retired server-side, not a
  parameter issue), and `/q/d/l/` (daily history) serves a Cloudflare-style
  JS proof-of-work challenge page instead of CSV. Both stay wired first in
  the chain below (they may work from other deployments) and fall through
  to FRED rather than raising.
- **FRED** (St. Louis Fed) `graph/fredgraph.csv?id=<SERIES>` — verified live
  200 CSV from this egress for `SP500`, `NASDAQCOM` (Nasdaq Composite, the
  closest keyless proxy to the Nasdaq 100 — labelled distinctly so we never
  claim it's the 100), `VIXCLS`, `DCOILWTICO` (matches the existing
  `cl.f`/"WTI" labelling), `DHHNGSP` (Henry Hub nat-gas spot), `DEXUSEU`,
  `DEXJPUS`. One series per request only — a comma-joined multi-series id
  (`?id=A,B,C`) 200s but serves a zip archive instead of CSV, so each series
  is fetched (and cached) individually. IMPORTANT: this endpoint has NO
  daily gold series (the old `GOLDAMGBD228NLBM` London fixing series is
  discontinued/404, and `IQ12260` is a *monthly* import-price index, not a
  spot price) and no DAX/Nikkei series, so `gc.f`/`^dax`/`^nkx` have no FRED
  fallback and stay stooq-only — they degrade (dropped from their bucket /
  from the stress signal) when stooq is down rather than being faked from a
  wrong-shaped series. Missing FRED observations (holidays/weekends) come
  back as an empty field or a literal `.`; both are treated as absent.
- **CoinGecko** `simple/price` (spot + 24h change) and `market_chart` (30d
  history, for the btc-drawdown stress input) — both verified live 200s.
- **Polymarket gamma** `events` — verified live 200 with real geopolitical
  markets (Iran/Israel, elections, ceasefires) alongside sports/esports noise
  that we filter out by tag + keyword.

Every fetch goes through the shared `upstream.cache` (TtlCache) keyed as
`markets:quotes`, `markets:history:<symbol>`, `markets:fred:<series_id>`,
`markets:predictions`, `markets:crypto` so route handlers and the stress
scorer share one fetch per TTL window instead of each re-hitting the
upstream.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime
from typing import Any

from app.osint.fetch import fetch_json
from app.upstream import cache, get_client

# ---------------------------------------------------------------------------
# Stooq quotes (indices / commodities / fx)
# ---------------------------------------------------------------------------

# symbol -> (display symbol, name, bucket). Bucket matches the `snapshot()`
# output keys.
_QUOTE_SYMBOLS: dict[str, tuple[str, str, str]] = {
    "^spx": ("SPX", "S&P 500", "indices"),
    "^ndq": ("NDQ", "Nasdaq 100", "indices"),
    "^dax": ("DAX", "DAX", "indices"),
    "^nkx": ("NKX", "Nikkei 225", "indices"),
    "cl.f": ("CL", "Crude Oil (WTI)", "commodities"),
    "gc.f": ("GC", "Gold", "commodities"),
    "ng.f": ("NG", "Natural Gas", "commodities"),
    "eurusd": ("EURUSD", "Euro / US Dollar", "fx"),
    "usdjpy": ("USDJPY", "US Dollar / Japanese Yen", "fx"),
}

_STOOQ_QUOTE_URL = (
    "https://stooq.com/q/l/?s=" + ",".join(_QUOTE_SYMBOLS) + "&f=sd2t2ohlcv&h&e=csv"
)
_STOOQ_HIST_URL = "https://stooq.com/q/d/l/?s={symbol}&i=d"

# stooq symbol -> FRED series id, for symbols with a real keyless daily
# proxy on FRED (see module docstring — DAX/Nikkei/gold have none and stay
# stooq-only). `^ndq` maps to the Nasdaq *Composite*, not the Nasdaq 100, so
# it gets a distinct display name below rather than silently relabelled.
_FRED_SYMBOL_SERIES: dict[str, str] = {
    "^spx": "SP500",
    "^ndq": "NASDAQCOM",
    "cl.f": "DCOILWTICO",
    "ng.f": "DHHNGSP",
    "eurusd": "DEXUSEU",
    "usdjpy": "DEXJPUS",
}
_FRED_NAME_OVERRIDE: dict[str, str] = {"^ndq": "Nasdaq Composite"}

# VIX has no stooq quote/history route at all (see module docstring); it is
# FRED-only, both in `snapshot()`'s indices bucket and as the stress signal's
# vix_level component.
_VIX_SERIES = "VIXCLS"

_FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"

_QUOTES_TTL = 300.0
_HISTORY_TTL = 3600.0
_FRED_TTL = 3600.0  # daily data — no point re-fetching more than hourly
_PREDICTIONS_TTL = 300.0
_CRYPTO_TTL = 300.0

_GAMMA_URL = (
    "https://gamma-api.polymarket.com/events"
    "?closed=false&order=volume24hr&ascending=false&limit=50"
)
_COINGECKO_PRICE_URL = (
    "https://api.coingecko.com/api/v3/simple/price"
    "?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true"
)
_COINGECKO_HISTORY_URL = (
    "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart"
    "?vs_currency=usd&days=30&interval=daily"
)


async def _fetch_text(key: str, url: str, ttl: float) -> str | None:
    """Cached GET returning raw text, or None on any failure/non-200.

    Mirrors `osint.fetch.fetch_json`'s degrade-to-None contract, but for CSV
    bodies (stooq) that don't parse as JSON — and keyed by a caller-chosen
    cache key (`markets:quotes` / `markets:history:<symbol>`) rather than the
    URL, per the plan.
    """

    async def loader() -> str | None:
        try:
            r = await get_client().get(url, follow_redirects=True)
        except Exception:  # noqa: BLE001 — network error → degrade
            return None
        if r.status_code != 200:
            return None
        return r.text

    return await cache.get_or_fetch(key, ttl, loader)


def _parse_quotes_csv(text: str) -> dict[str, dict[str, Any]]:
    """Parse stooq's `s,d2,t2,o,h,l,c,v` header'd CSV into rows keyed by symbol.

    Missing sessions/fields come back as the literal string `N/D` — treated
    as absent. `change_pct_24h` is approximated as the latest session's
    (close - open) / open — stooq quotes are daily bars, so this is the
    standard same-session proxy (no separate "yesterday's close" field is
    served by this endpoint).
    """
    rows: dict[str, dict[str, Any]] = {}
    reader = csv.DictReader(io.StringIO(text))

    def _num(raw: dict[str, Any], field: str) -> float | None:
        v = (raw.get(field) or "").strip()
        if not v or v == "N/D":
            return None
        try:
            return float(v)
        except ValueError:
            return None

    for raw in reader:
        symbol = (raw.get("Symbol") or "").strip().lower()
        meta = _QUOTE_SYMBOLS.get(symbol)
        if meta is None:
            continue
        display, name, bucket = meta

        close = _num(raw, "Close")
        open_ = _num(raw, "Open")
        change_pct = None
        if close is not None and open_ not in (None, 0):
            change_pct = (close - open_) / open_ * 100
        date = (raw.get("Date") or "").strip()
        time_ = (raw.get("Time") or "").strip()
        ts = f"{date}T{time_}Z" if date else ""
        rows[symbol] = {
            "symbol": display,
            "name": name,
            "last": close,
            "change_pct_24h": round(change_pct, 4) if change_pct is not None else None,
            "ts": ts,
            "bucket": bucket,
        }
    return rows


def _parse_history_csv(text: str) -> list[dict[str, Any]]:
    """Parse stooq's daily-history CSV (`Date,Open,High,Low,Close,Volume`).

    Returns rows oldest-first; malformed/challenge-page bodies (not real
    CSV) yield an empty list rather than raising.
    """
    out: list[dict[str, Any]] = []
    try:
        reader = csv.DictReader(io.StringIO(text))
        for raw in reader:
            close = raw.get("Close")
            date = raw.get("Date")
            if not close or not date:
                continue
            out.append({"date": date, "close": float(close)})
    except (ValueError, csv.Error):
        return []
    return out


def _parse_fred_csv(text: str) -> list[dict[str, Any]]:
    """Parse a single-series `fredgraph.csv` (`observation_date,<SERIES>`).

    Missing observations (holidays/weekends) come back either as an empty
    field or the literal `.` depending on series/vintage — both are treated
    as absent and the row is dropped rather than carried as a stale/zero
    value. Returns rows oldest-first, matching `_parse_history_csv`'s shape.
    """
    out: list[dict[str, Any]] = []
    reader = csv.reader(io.StringIO(text))
    next(reader, None)  # header row
    for row in reader:
        if len(row) < 2:
            continue
        date, value = row[0].strip(), row[1].strip()
        if not date or not value or value == ".":
            continue
        try:
            close = float(value)
        except ValueError:
            continue
        out.append({"date": date, "close": close})
    return out


async def _fred_history(series_id: str) -> list[dict[str, Any]] | None:
    """Fetch + parse one FRED series' full daily history, or None if down."""
    text = await _fetch_text(
        f"markets:fred:{series_id}", _FRED_URL.format(series_id=series_id), _FRED_TTL
    )
    if text is None:
        return None
    rows = _parse_fred_csv(text)
    return rows or None


async def _history(symbol: str) -> list[dict[str, Any]] | None:
    """Fetch + parse a symbol's daily history: stooq first, FRED fallback.

    Returns None only when stooq is down/unparseable AND either the symbol
    has no FRED proxy (DAX/Nikkei/gold — see module docstring) or FRED is
    also down.
    """
    text = await _fetch_text(
        f"markets:history:{symbol}", _STOOQ_HIST_URL.format(symbol=symbol), _HISTORY_TTL
    )
    if text is not None:
        rows = _parse_history_csv(text)
        if rows:
            return rows
    series_id = _FRED_SYMBOL_SERIES.get(symbol)
    if series_id is None:
        return None
    return await _fred_history(series_id)


async def _fred_quote_row(
    symbol: str, display: str, name: str, bucket: str
) -> dict[str, Any] | None:
    """Build one quote row from a FRED series' last two closes, or None if down."""
    series_id = _FRED_SYMBOL_SERIES.get(symbol)
    if series_id is None:
        return None
    hist = await _fred_history(series_id)
    if not hist:
        return None
    last = hist[-1]["close"]
    change_pct = None
    if len(hist) >= 2 and hist[-2]["close"]:
        change_pct = (last - hist[-2]["close"]) / hist[-2]["close"] * 100
    return {
        "symbol": display,
        "name": _FRED_NAME_OVERRIDE.get(symbol, name),
        "last": last,
        "change_pct_24h": round(change_pct, 4) if change_pct is not None else None,
        "ts": f"{hist[-1]['date']}T00:00:00Z",
        "bucket": bucket,
    }


async def snapshot() -> dict[str, Any]:
    """Batched keyless quote snapshot: indices, commodities, fx, crypto.

    Each stooq symbol falls back to its FRED proxy (see module docstring)
    when the stooq batch quote is down or missing that symbol; DAX/Nikkei/
    gold have no FRED proxy and stay absent from their bucket in that case.
    VIX is FRED-only (never on stooq here) and gets its own indices row.

    `unavailable` is True only when stooq, every FRED fallback, AND the
    CoinGecko price call all failed — i.e. every bucket is empty — so a
    caller can distinguish "one source degraded" (buckets partially filled)
    from "nothing to show".
    """
    text = await _fetch_text("markets:quotes", _STOOQ_QUOTE_URL, _QUOTES_TTL)
    quote_rows = _parse_quotes_csv(text) if text else {}

    for symbol, (display, name, bucket) in _QUOTE_SYMBOLS.items():
        if symbol in quote_rows:
            continue
        row = await _fred_quote_row(symbol, display, name, bucket)
        if row is not None:
            quote_rows[symbol] = row

    # ^vix has no stooq counterpart to key off (see module docstring), so
    # it's built directly from the FRED series rather than through the
    # per-symbol helper's `_FRED_SYMBOL_SERIES` mapping.
    vix_hist = await _fred_history(_VIX_SERIES)
    if vix_hist:
        last = vix_hist[-1]["close"]
        change_pct = None
        if len(vix_hist) >= 2 and vix_hist[-2]["close"]:
            change_pct = (last - vix_hist[-2]["close"]) / vix_hist[-2]["close"] * 100
        quote_rows["^vix"] = {
            "symbol": "VIX",
            "name": "CBOE Volatility Index",
            "last": last,
            "change_pct_24h": round(change_pct, 4) if change_pct is not None else None,
            "ts": f"{vix_hist[-1]['date']}T00:00:00Z",
            "bucket": "indices",
        }

    indices: list[dict[str, Any]] = []
    commodities: list[dict[str, Any]] = []
    fx: list[dict[str, Any]] = []
    for row in quote_rows.values():
        bucket = row.pop("bucket")
        target = {"indices": indices, "commodities": commodities, "fx": fx}.get(bucket)
        if target is not None:
            target.append(row)

    crypto: list[dict[str, Any]] = []
    price = await fetch_json(_COINGECKO_PRICE_URL, _CRYPTO_TTL)
    if isinstance(price, dict):
        for coin_id, sym, name in (("bitcoin", "BTC", "Bitcoin"), ("ethereum", "ETH", "Ethereum")):
            entry = price.get(coin_id)
            if not isinstance(entry, dict) or "usd" not in entry:
                continue
            crypto.append(
                {
                    "symbol": sym,
                    "name": name,
                    "last": entry.get("usd"),
                    "change_pct_24h": entry.get("usd_24h_change"),
                    "ts": datetime.now(UTC).isoformat(),
                }
            )

    unavailable = not quote_rows and not crypto
    return {
        "indices": indices,
        "commodities": commodities,
        "fx": fx,
        "crypto": crypto,
        "asof_utc": datetime.now(UTC).isoformat(),
        "unavailable": unavailable,
    }


# ---------------------------------------------------------------------------
# Polymarket predictions
# ---------------------------------------------------------------------------

# Verified against a live gamma probe (2026-07-21, 50 top-volume events): real
# geopolitical markets carry tags like "Geopolitics"/"Elections"/"Middle
# East"/"Military Strikes", or an unambiguous keyword in the title itself
# ("ceasefire", "invade", "sanctions"...). Sports/esports/tennis noise shares
# the same feed sorted by volume and must be excluded even when a loosely
# related tag (e.g. "Politics" on a Trump-tweet-count market) is present.
_GEO_TAGS = {
    "geopolitics",
    "elections",
    "global elections",
    "main election",
    "military strikes",
    "middle east",
    "world elections",
}
_GEO_KEYWORDS = (
    "war",
    "conflict",
    "election",
    "sanction",
    "nuclear",
    "nato",
    "ceasefire",
    "geopolitic",
    "military",
    "invade",
    "invasion",
    "coup",
    "regime",
    "strait",
    "airspace",
)
_EXCLUDE_TAGS = {
    "sports",
    "esports",
    "games",
    "tennis",
    "nba",
    "nfl",
    "mlb",
    "nhl",
    "basketball",
    "soccer",
    "awards",
    "culture",
}


def _is_geopolitical(event: dict[str, Any]) -> bool:
    tags = {str(t.get("label", "")).lower() for t in event.get("tags", []) if isinstance(t, dict)}
    title = str(event.get("title", "")).lower()
    has_geo_tag = bool(tags & _GEO_TAGS)
    has_keyword = any(k in title for k in _GEO_KEYWORDS) or any(
        k in tag for tag in tags for k in _GEO_KEYWORDS
    )
    if tags & _EXCLUDE_TAGS and not has_geo_tag:
        return False
    return has_geo_tag or has_keyword


def _event_probability(event: dict[str, Any]) -> float | None:
    markets = event.get("markets")
    if not isinstance(markets, list) or not markets:
        return None
    market = markets[0]
    outcomes = market.get("outcomes")
    prices = market.get("outcomePrices")
    # Gamma serves both fields as JSON-encoded strings, e.g. '["Yes","No"]'.
    if isinstance(outcomes, str):
        try:
            outcomes = json.loads(outcomes)
        except ValueError:
            outcomes = None
    if isinstance(prices, str):
        try:
            prices = json.loads(prices)
        except ValueError:
            prices = None
    if not isinstance(outcomes, list) or not isinstance(prices, list):
        return None
    for outcome, price in zip(outcomes, prices, strict=False):
        if str(outcome).lower() == "yes":
            try:
                return float(price)
            except (TypeError, ValueError):
                return None
    return None


async def predictions() -> dict[str, Any]:
    """Top geopolitical Polymarket markets by 24h volume."""
    data = await fetch_json(_GAMMA_URL, _PREDICTIONS_TTL)
    if not isinstance(data, list):
        return {"items": [], "unavailable": True}

    items: list[dict[str, Any]] = []
    for event in data:
        if not isinstance(event, dict) or not _is_geopolitical(event):
            continue
        prob = _event_probability(event)
        slug = event.get("slug")
        items.append(
            {
                "question": event.get("title"),
                "prob": prob,
                "volume_24h": event.get("volume24hr"),
                "url": f"https://polymarket.com/event/{slug}" if slug else None,
            }
        )
    return {"items": items, "unavailable": False}


# ---------------------------------------------------------------------------
# Composite market-stress signal
# ---------------------------------------------------------------------------

# Weights sum to 1 over PRESENT components; a missing component's weight is
# redistributed proportionally over whatever remains (see `compute_stress`).
# `vix_level` rejoined 2026-07-21 now that VIXCLS is a confirmed-live FRED
# series (see module docstring) — previously dropped entirely because stooq
# never confirmed a `^vix` quote at probe time.
_WEIGHTS: dict[str, float] = {
    "equity_drawdown": 0.30,
    "vix_level": 0.25,
    "gold_move": 0.15,
    "oil_move": 0.15,
    "usd_flight": 0.10,
    "btc_drawdown": 0.05,
}


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _equity_drawdown(
    spx_last: float | None, spx_30d_high: float | None
) -> tuple[float, float] | None:
    if not spx_last or not spx_30d_high or spx_30d_high <= 0:
        return None
    dd_pct = max(0.0, (spx_30d_high - spx_last) / spx_30d_high * 100)
    # 0% off the 30d high -> 0 stress; a 10%+ drawdown (correction territory) -> full stress.
    return dd_pct, _clamp01(dd_pct / 10.0)


def _gold_move(gold_5d_pct: float | None) -> tuple[float, float] | None:
    if gold_5d_pct is None:
        return None
    # Only a RALLY reads as flight-to-safety stress; a gold decline is not
    # inverted into negative stress, it just contributes 0.
    up = max(0.0, gold_5d_pct)
    return gold_5d_pct, _clamp01(up / 8.0)  # +8% in 5d -> full stress


def _oil_move(oil_5d_pct: float | None) -> tuple[float, float] | None:
    if oil_5d_pct is None:
        return None
    # Either direction is a stress signal (spike = supply shock, crash = demand shock).
    return oil_5d_pct, _clamp01(abs(oil_5d_pct) / 10.0)  # +-10% in 5d -> full stress


def _usd_flight(
    usd_strength_eur_5d_pct: float | None, usd_strength_jpy_5d_pct: float | None
) -> tuple[float, float] | None:
    parts = [p for p in (usd_strength_eur_5d_pct, usd_strength_jpy_5d_pct) if p is not None]
    if not parts:
        return None
    avg = sum(parts) / len(parts)
    strength = max(0.0, avg)
    return avg, _clamp01(strength / 5.0)  # +5% avg dollar strength in 5d -> full stress


def _vix_level(vix_last: float | None) -> tuple[float, float] | None:
    if vix_last is None:
        return None
    # VIX ~12-20 is calm; readings >=35 are crisis-grade fear (2008/2020 both
    # ran well past that). 15 floor -> 0 stress, 35 -> full stress.
    return vix_last, _clamp01((vix_last - 15.0) / 20.0)


def _btc_drawdown(btc_last: float | None, btc_30d_high: float | None) -> tuple[float, float] | None:
    if not btc_last or not btc_30d_high or btc_30d_high <= 0:
        return None
    dd_pct = max(0.0, (btc_30d_high - btc_last) / btc_30d_high * 100)
    # Crypto is materially more volatile than equities, so its full-stress band is 2x as wide.
    return dd_pct, _clamp01(dd_pct / 20.0)


def compute_stress(inputs: dict[str, float | None]) -> dict[str, Any]:
    """Pure-math composite stress score from already-derived percentages.

    Expected `inputs` keys (all optional — a missing/None key means that
    component's upstream is degraded and it's dropped, weight redistributed
    over what remains):
      - `spx_last`, `spx_30d_high` -> equity_drawdown
      - `vix_last` -> vix_level
      - `gold_5d_pct` -> gold_move
      - `oil_5d_pct` -> oil_move
      - `usd_strength_eur_5d_pct`, `usd_strength_jpy_5d_pct` -> usd_flight
        (caller pre-converts quote deltas to a dollar-strength sign: EURUSD
        falling and USDJPY rising both mean the dollar strengthened)
      - `btc_last`, `btc_30d_high` -> btc_drawdown

    Returns `{"score": 0-100, "components": [...], "degraded": bool}`. All
    sources down -> `score: 0` (neutral/no-signal), `components: []`,
    `degraded: True` — 0 rather than None so callers can render a number
    without a null check, documented here as the deliberate choice (a
    fabricated high score would be worse than an honest "no reading").
    """
    candidates: dict[str, tuple[tuple[float, float] | None, float, list[str]]] = {
        "equity_drawdown": (
            _equity_drawdown(inputs.get("spx_last"), inputs.get("spx_30d_high")),
            _WEIGHTS["equity_drawdown"],
            ["spx_last", "spx_30d_high"],
        ),
        "vix_level": (
            _vix_level(inputs.get("vix_last")),
            _WEIGHTS["vix_level"],
            ["vix_last"],
        ),
        "gold_move": (
            _gold_move(inputs.get("gold_5d_pct")),
            _WEIGHTS["gold_move"],
            ["gold_5d_pct"],
        ),
        "oil_move": (
            _oil_move(inputs.get("oil_5d_pct")),
            _WEIGHTS["oil_move"],
            ["oil_5d_pct"],
        ),
        "usd_flight": (
            _usd_flight(
                inputs.get("usd_strength_eur_5d_pct"), inputs.get("usd_strength_jpy_5d_pct")
            ),
            _WEIGHTS["usd_flight"],
            ["usd_strength_eur_5d_pct", "usd_strength_jpy_5d_pct"],
        ),
        "btc_drawdown": (
            _btc_drawdown(inputs.get("btc_last"), inputs.get("btc_30d_high")),
            _WEIGHTS["btc_drawdown"],
            ["btc_last", "btc_30d_high"],
        ),
    }
    present = {k: v for k, v in candidates.items() if v[0] is not None}
    if not present:
        return {"score": 0, "components": [], "degraded": True}

    weight_sum = sum(weight for _, weight, _ in present.values())
    components: list[dict[str, Any]] = []
    score = 0.0
    for key, (result, weight, input_keys) in present.items():
        assert result is not None  # narrowed by the `present` filter above
        raw_value, normalized = result
        renorm_weight = weight / weight_sum
        score += renorm_weight * normalized
        components.append(
            {
                "key": key,
                "value": round(raw_value, 4),
                "normalized": round(normalized, 4),
                "weight": round(renorm_weight, 4),
                "inputs": {k: inputs.get(k) for k in input_keys},
            }
        )
    return {
        "score": round(score * 100, 2),
        "components": components,
        "degraded": len(present) < len(candidates),
    }


async def market_stress() -> dict[str, Any]:
    """Fetch live inputs and compute the composite stress score.

    Every upstream fetch degrades to None independently — a dead stooq
    history endpoint (see module docstring: live at probe time it 404s/serves
    a JS challenge) drops the components that depend on it and renormalizes,
    it never raises to the caller.
    """
    spx_hist, gold_hist, oil_hist, eur_hist, jpy_hist = [
        await _history(sym) for sym in ("^spx", "gc.f", "cl.f", "eurusd", "usdjpy")
    ]
    btc_hist = await _coingecko_btc_history()
    vix_hist = await _fred_history(_VIX_SERIES)

    def _pct_5d(hist: list[dict[str, Any]] | None) -> float | None:
        if not hist or len(hist) < 6:
            return None
        last = hist[-1]["close"]
        prior = hist[-6]["close"]
        if not prior:
            return None
        return (last - prior) / prior * 100

    def _last_and_30d_high(hist: list[dict[str, Any]] | None) -> tuple[float | None, float | None]:
        if not hist:
            return None, None
        last = hist[-1]["close"]
        window = hist[-30:]
        high = max((row["close"] for row in window), default=None)
        return last, high

    spx_last, spx_high = _last_and_30d_high(spx_hist)
    eur_5d = _pct_5d(eur_hist)
    jpy_5d = _pct_5d(jpy_hist)
    btc_last, btc_high = _last_and_30d_high(btc_hist)
    vix_last = vix_hist[-1]["close"] if vix_hist else None

    inputs = {
        "spx_last": spx_last,
        "spx_30d_high": spx_high,
        "vix_last": vix_last,
        "gold_5d_pct": _pct_5d(gold_hist),
        "oil_5d_pct": _pct_5d(oil_hist),
        # EURUSD falling = dollar strengthened against EUR; USDJPY rising =
        # dollar strengthened against JPY — both converted to a common
        # "positive = dollar stronger" sign before reaching `compute_stress`.
        "usd_strength_eur_5d_pct": -eur_5d if eur_5d is not None else None,
        "usd_strength_jpy_5d_pct": jpy_5d,
        "btc_last": btc_last,
        "btc_30d_high": btc_high,
    }
    result = compute_stress(inputs)
    result["asof_utc"] = datetime.now(UTC).isoformat()
    return result


async def _coingecko_btc_history() -> list[dict[str, Any]] | None:
    data = await fetch_json(_COINGECKO_HISTORY_URL, _HISTORY_TTL)
    if not isinstance(data, dict):
        return None
    prices = data.get("prices")
    if not isinstance(prices, list) or not prices:
        return None
    out = []
    for point in prices:
        if isinstance(point, list) and len(point) == 2:
            out.append({"date": point[0], "close": point[1]})
    return out or None
