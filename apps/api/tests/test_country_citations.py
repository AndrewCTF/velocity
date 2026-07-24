"""Guards for the country-honesty fixes:

- a ``country_security`` GDELT event carries the upstream ``url`` when the
  feature had one (nothing footnotable was silently dropped);
- World Bank floats fed to the brief prompt are rounded to sane precision;
- ``/api/news/feed?iso3=`` filters headlines server-side to the requested
  country using the same name-matching rule the news edition uses.

No live network — the conflict/UCDP layers and the news article store are
mocked/reset.
"""

from __future__ import annotations

from app.intel import country_profile as cp
from app.news import store as news_store
from app.news.sources import Article
from app.upstream import cache

# ── FIX 1: url carried through country_security events ─────────────────────


def test_gdelt_event_carries_url(client, monkeypatch):
    async def fake_conflict(hours=6):
        return {
            "type": "FeatureCollection",
            "features": [
                {
                    "geometry": {"type": "Point", "coordinates": [7.0, 9.0]},
                    "properties": {
                        "actor1": "Nigeria Police",
                        "actor2": "Militants",
                        "event": "armed clash",
                        "day": "20260712",
                        "url": "https://example.com/clash-report",
                    },
                },
            ],
        }

    async def fake_ucdp(version=None):
        return {"type": "FeatureCollection", "features": []}

    import app.intel.conflict as conflict_mod
    import app.intel.ucdp as ucdp_mod

    monkeypatch.setattr(conflict_mod, "conflict_events", fake_conflict)
    monkeypatch.setattr(ucdp_mod, "ucdp_events", fake_ucdp)
    cache.invalidate("country:security:NGA:24")

    r = client.get("/api/country/NGA/security")
    assert r.status_code == 200
    body = r.json()
    ev = next(e for e in body["events"] if e["source"] == "gdelt")
    assert ev["url"] == "https://example.com/clash-report"


def test_gdelt_event_url_is_none_when_upstream_had_none(client, monkeypatch):
    async def fake_conflict(hours=6):
        return {
            "type": "FeatureCollection",
            "features": [
                {
                    "geometry": {"type": "Point", "coordinates": [7.0, 9.0]},
                    "properties": {
                        "actor1": "Nigeria Police",
                        "actor2": "Militants",
                        "event": "armed clash",
                        "day": "20260712",
                    },
                },
            ],
        }

    async def fake_ucdp(version=None):
        return {"type": "FeatureCollection", "features": []}

    import app.intel.conflict as conflict_mod
    import app.intel.ucdp as ucdp_mod

    monkeypatch.setattr(conflict_mod, "conflict_events", fake_conflict)
    monkeypatch.setattr(ucdp_mod, "ucdp_events", fake_ucdp)
    cache.invalidate("country:security:NGA:24")

    r = client.get("/api/country/NGA/security")
    assert r.status_code == 200
    ev = next(e for e in r.json()["events"] if e["source"] == "gdelt")
    assert ev["url"] is None  # never fabricated


# ── World Bank rounding + brief sourced footnotes ───────────────────────────


def test_wb_digest_rounds_spurious_precision():
    wb = {
        "indicators": [
            {
                "id": "NY.GDP.MKTP.CD",
                "label": "GDP",
                "unit": "current US$",
                "series": [{"year": 2024, "value": 23.4567891233}],
            }
        ]
    }
    out = cp._wb_digest(wb)
    assert out[0]["value"] == 23.46  # 4 significant figures, not 10 decimals


def test_wb_round_keeps_sig_figs_for_gdp_scale_values():
    # Regression: the earlier max(digits, 0) clamp defeated rounding for any
    # value >= 10_000 (digits goes negative), i.e. exactly the GDP case it was
    # meant to tidy. round() must accept negative ndigits to keep 4 sig figs.
    assert cp._round_wb_value(2.1943729812e13) == 2.194e13
    assert cp._round_wb_value(1234567) == 1234567  # ints pass through untouched
    assert cp._round_wb_value(98765.4) == 98770.0


def test_wb_digest_leaves_ints_alone():
    wb = {
        "indicators": [
            {"id": "SP.POP.TOTL", "label": "Population", "unit": "", "series": [{"year": 2024, "value": 213401254}]}
        ]
    }
    out = cp._wb_digest(wb)
    assert out[0]["value"] == 213401254


def test_sourced_footnotes_only_cite_urls_present_in_data():
    events = [
        {"label": "clash", "date": "2026-07-12", "url": "https://example.com/a"},
        {"label": "protest", "date": "2026-07-10", "url": None},  # no fabrication
        {"label": "clash", "date": "2026-07-12", "url": "https://example.com/a"},  # dedup
    ]
    out = cp._sourced_footnotes(events)
    assert out.count("https://example.com/a") == 1
    assert "## Sources" in out
    assert "protest" not in out  # never cite an event with no url


def test_sourced_footnotes_empty_when_no_urls():
    assert cp._sourced_footnotes([{"label": "clash", "url": None}]) == ""


def test_sourced_footnotes_flags_gdelt_provenance():
    # A GDELT-sourced citation carries a working URL but is only actor-name
    # matched (reporting intensity, not verified ground truth); the
    # deterministic Sources list must say so, since it is appended after the
    # model's markdown and never itself reviewed by the model.
    events = [
        {"label": "clash", "date": "2026-07-20", "url": "https://example.com/a",
         "source": "gdelt"},
    ]
    out = cp._sourced_footnotes(events)
    assert "reporting intensity" in out
    assert "## Sources" in out


def test_sourced_footnotes_no_caveat_when_ucdp_only():
    events = [
        {"label": "clash", "date": "2026-07-20", "url": "https://example.com/a",
         "source": "ucdp"},
    ]
    out = cp._sourced_footnotes(events)
    assert "reporting intensity" not in out
    assert "## Sources" in out


# ── _trim_incomplete_tail: truncated-generation backstop ───────────────────
# Regression: two independent live /api/country/{iso3}/brief runs truncated
# mid-sentence (once mid-URL) right before the deterministic ## Sources
# footer, because the model's own generation hit its length cap. This trims
# the dangling fragment back to the last safely-terminated sentence.


def test_trim_incomplete_tail_cuts_mid_sentence():
    text = (
        "## Overview\nThe situation remains tense. A military force event "
        "involving Minnesota and Ethiopian actors was reported on 202"
    )
    assert cp._trim_incomplete_tail(text) == "## Overview\nThe situation remains tense."


def test_trim_incomplete_tail_cuts_mid_url():
    text = (
        "## Overview\nCalm.\n\n## Recent security events\nA clash was reported "
        "([source](https://www.dailymail.com/news/article-15996701/Tsegaab-"
        "Binessu-shooting-ap"
    )
    out = cp._trim_incomplete_tail(text)
    assert out == "## Overview\nCalm."
    assert "[" not in out and "(" not in out  # no dangling link syntax kept


def test_trim_incomplete_tail_leaves_clean_ending_untouched():
    text = "## Watch items\nWatch for further escalation in the border region."
    assert cp._trim_incomplete_tail(text) == text


def test_trim_incomplete_tail_leaves_clean_citation_untouched():
    text = "A clash was reported ([source](https://example.com/ok))."
    assert cp._trim_incomplete_tail(text) == text


def test_trim_incomplete_tail_empty_body():
    assert cp._trim_incomplete_tail("") == ""
    assert cp._trim_incomplete_tail("   \n\t  ") == ""


def test_trim_incomplete_tail_drops_all_when_no_safe_boundary():
    # No sentence-ending punctuation anywhere in the text -- nothing safe to
    # keep, so the whole dangling fragment is dropped rather than shown broken.
    text = "A clash was reported ([source](https://example.com/still-loading"
    assert cp._trim_incomplete_tail(text) == ""


# ── FIX 3: /api/news/feed?iso3= server-side filter ──────────────────────────


def _article(title: str, summary: str = "") -> Article:
    return Article(
        title=title,
        summary=summary,
        link="https://example.com/x",
        source="Test Wire",
        leaning="center",
        published_iso="2026-07-20T00:00:00Z",
    )


def test_news_feed_filters_by_iso3(client, monkeypatch):
    import app.routes.news as news_routes

    news_store.reset()

    async def fake_articles():
        return [
            _article("France announces new policy"),
            _article("Unrelated local sports story"),
            _article("Fighting continues near the France border"),
        ]

    monkeypatch.setattr(news_routes, "_ensure_articles", fake_articles)

    r = client.get("/api/news/feed", params={"iso3": "fra"})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    assert all("France" in a["title"] for a in body["articles"])


def test_news_feed_iso3_no_match_is_empty_not_error(client, monkeypatch):
    import app.routes.news as news_routes

    news_store.reset()

    async def fake_articles():
        return [_article("Unrelated local sports story")]

    monkeypatch.setattr(news_routes, "_ensure_articles", fake_articles)

    r = client.get("/api/news/feed", params={"iso3": "fra"})
    assert r.status_code == 200
    assert r.json() == {"count": 0, "articles": []}


def test_news_feed_without_iso3_is_unfiltered(client, monkeypatch):
    import app.routes.news as news_routes

    news_store.reset()

    async def fake_articles():
        return [_article("France announces new policy"), _article("Unrelated local sports story")]

    monkeypatch.setattr(news_routes, "_ensure_articles", fake_articles)

    r = client.get("/api/news/feed")
    assert r.status_code == 200
    assert r.json()["count"] == 2
