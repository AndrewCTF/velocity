"""Guards for the keyless per-country intelligence endpoints:
``/api/country/{iso3}/profile`` (Wikidata leadership + branches),
``/security`` (conflict/UCDP/installation fusion) and ``/brief`` (LLM).

No live network — SPARQL, the conflict/UCDP layers and the LLM are all mocked.
"""

from __future__ import annotations

import httpx

from app.intel import country_profile as cp
from app.llm import LlmResult
from app.routes import country_stats
from app.upstream import cache

# ── latest-start-wins selection (the no-end-date trap) ────────────────────────


def _row(cat, person, since=None, img=None, role_label=None):
    d = {"cat": {"value": cat}, "plabel": {"value": person}}
    if role_label is not None:
        d["roleLabel"] = {"value": role_label}
    if since is not None:
        d["since"] = {"value": since}
    if img is not None:
        d["image"] = {"value": img}
    return d


def test_latest_per_role_picks_latest_start():
    # The Nigeria trap: an undated dead ex-minister (Sani Abacha) must NOT beat a
    # dated current one (Christopher Musa, 2025-12-04); the latest start wins and
    # the undated holder is dropped because a dated holder exists for the role.
    rows = [
        _row("defence_minister", "Sani Abacha"),  # no start
        _row("defence_minister", "Bashir Magashi", "2019-08-21T00:00:00Z"),
        _row(
            "defence_minister",
            "Christopher Musa",
            "2025-12-04T00:00:00Z",
            img="http://img/musa.jpg",
            role_label="Minister of Defence of Nigeria",
        ),
        _row("head_of_state", "Umaru Yar'Adua", "2007-05-29T00:00:00Z"),
        _row("head_of_state", "Bola Tinubu", "2023-05-29T00:00:00Z"),
    ]
    out = cp._latest_per_role(rows)
    by_role = {d["role"]: d for d in out}
    assert by_role["defence_minister"]["person"] == "Christopher Musa"
    assert by_role["defence_minister"]["start"] == "2025-12-04"
    assert by_role["defence_minister"]["image"] == "http://img/musa.jpg"
    assert by_role["defence_minister"]["position"] == "Minister of Defence of Nigeria"
    assert by_role["head_of_state"]["person"] == "Bola Tinubu"
    # one entry per semantic role, no duplicates
    assert len(out) == 2
    # display order: head_of_state before defence_minister
    assert [d["role"] for d in out] == ["head_of_state", "defence_minister"]


def test_latest_per_role_collapses_duplicate_role_items():
    # The Germany trap: two Wikidata role ITEMS for the same office (historical
    # "German Foreign Minister" vs current "Federal Minister for Foreign
    # Affairs") share one ?cat, so the 1945 holder must lose to the 2025 one.
    rows = [
        _row("foreign_minister", "Schwerin von Krosigk", "1945-05-02T00:00:00Z",
             role_label="German Foreign Minister"),
        _row("foreign_minister", "Johann Wadephul", "2025-05-06T00:00:00Z",
             role_label="Federal Minister for Foreign Affairs"),
    ]
    out = cp._latest_per_role(rows)
    assert len(out) == 1
    assert out[0]["person"] == "Johann Wadephul"
    assert out[0]["position"] == "Federal Minister for Foreign Affairs"


def test_latest_per_role_drops_bare_qid_names():
    # The label service degrades to the bare QID under GROUP BY (observed live);
    # a QID row must not shadow or join a properly labelled holder.
    rows = [
        _row("foreign_minister", "Q1696501", "2025-05-06T00:00:00Z"),
        _row("foreign_minister", "Named Minister", "2024-01-01T00:00:00Z"),
    ]
    out = cp._latest_per_role(rows)
    assert len(out) == 1 and out[0]["person"] == "Named Minister"


def test_latest_per_role_keeps_undated_when_no_dated_holder():
    rows = [_row("commander_in_chief", "Only Holder")]  # no start anywhere
    out = cp._latest_per_role(rows)
    assert len(out) == 1 and out[0]["person"] == "Only Holder" and out[0]["start"] is None


# ── /profile route ────────────────────────────────────────────────────────────


def _sparql_response(url, **kwargs):
    q = kwargs.get("params", {}).get("query", "")
    if "P527" in q:  # branches query
        body = {"results": {"bindings": [
            {"branchLabel": {"value": "Alpha Army"}},
            {"branchLabel": {"value": "Alpha Navy"}},
        ]}}
    else:  # leadership query
        body = {"results": {"bindings": [
            _row("head_of_state", "Pat President", "2021-01-01T00:00:00Z"),
            _row("defence_minister", "Old Minister"),  # undated → dropped
            _row("defence_minister", "New Minister", "2024-06-01T00:00:00Z",
                 role_label="Minister of Defence"),
        ]}}
    return httpx.Response(200, json=body, request=httpx.Request("GET", url))


def test_profile_shape(client, monkeypatch):
    async def fake_get(self, url, **kwargs):
        return _sparql_response(url, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    cache.invalidate("country:profile:FRA")
    r = client.get("/api/country/FRA/profile")
    assert r.status_code == 200
    body = r.json()
    assert body["iso3"] == "FRA" and body["source"] == "wikidata"
    roles = {p["role"]: p["person"] for p in body["leadership"]}
    assert roles["head_of_state"] == "Pat President"
    assert roles["defence_minister"] == "New Minister"  # latest-start-wins
    positions = {p["role"]: p["position"] for p in body["leadership"]}
    assert positions["defence_minister"] == "Minister of Defence"
    assert body["military_branches"] == ["Alpha Army", "Alpha Navy"]


def test_profile_degrades_on_sparql_failure(client, monkeypatch):
    async def boom(self, url, **kwargs):
        raise httpx.ConnectError("sparql down")

    monkeypatch.setattr(httpx.AsyncClient, "get", boom)
    cache.invalidate("country:profile:DEU")
    r = client.get("/api/country/DEU/profile")
    assert r.status_code == 200  # never 500
    body = r.json()
    assert body["unavailable"] is True
    assert body["leadership"] == [] and body["military_branches"] == []


def test_profile_unknown_iso3_404(client):
    assert client.get("/api/country/XXX/profile").status_code == 404


# ── /security route ───────────────────────────────────────────────────────────


def test_security_fuses_and_filters(client, monkeypatch):
    async def fake_conflict(hours=6):
        return {"type": "FeatureCollection", "features": [
            {"geometry": {"type": "Point", "coordinates": [7.0, 9.0]},
             "properties": {"actor1": "Nigeria Police", "actor2": "Militants",
                            "event": "armed clash", "day": "20260712"}},
            {"geometry": {"type": "Point", "coordinates": [2.0, 48.0]},
             "properties": {"actor1": "France", "actor2": "X", "event": "protest",
                            "day": "20260710"}},  # different country → filtered out
        ]}

    async def fake_ucdp(version=None):
        return {"type": "FeatureCollection", "features": [
            {"geometry": {"type": "Point", "coordinates": [8.0, 10.0]},
             "properties": {"country": "Nigeria", "side_a": "Govt", "side_b": "ISWAP",
                            "deaths_best": 12, "date_start": "2026-07-11",
                            "label": "Govt vs ISWAP"}},
        ]}

    import app.intel.conflict as conflict_mod
    import app.intel.ucdp as ucdp_mod

    monkeypatch.setattr(conflict_mod, "conflict_events", fake_conflict)
    monkeypatch.setattr(ucdp_mod, "ucdp_events", fake_ucdp)
    cache.invalidate("country:security:NGA:24")

    r = client.get("/api/country/NGA/security")
    assert r.status_code == 200
    body = r.json()
    assert body["counts"]["conflict"] == 1  # only the Nigeria-actor event
    assert body["counts"]["ucdp"] == 1
    # most-recent-first: UCDP (2026-07-11) beats GDELT day (20260712 as a string
    # sorts higher) — assert both present and each carries a source tag.
    sources = {e["source"] for e in body["events"]}
    assert sources == {"gdelt", "ucdp"}
    ucdp_ev = next(e for e in body["events"] if e["source"] == "ucdp")
    assert ucdp_ev["deaths"] == 12 and "ISWAP" in ucdp_ev["actors"]
    assert isinstance(body["notes"], list) and body["notes"]


def test_security_does_not_attribute_demonym_to_country(client, monkeypatch):
    # Regression: a St. Paul, Minnesota crime story naming an "Ethiopian"
    # suspect must NOT be attributed to Ethiopia's security brief -- the old
    # substring match (`name_n in actor`) false-positived on "ethiopia"
    # inside "ethiopian"; the word-boundary matcher must not.
    async def fake_conflict(hours=6):
        return {"type": "FeatureCollection", "features": [
            {"geometry": {"type": "Point", "coordinates": [-93.1, 44.9]},
             "properties": {"actor1": "Minnesota", "actor2": "Ethiopian immigrant",
                            "event": "small-arms fight", "day": "20260723",
                            "url": "https://example.com/st-paul-shooting"}},
            {"geometry": {"type": "Point", "coordinates": [39.0, 9.0]},
             "properties": {"actor1": "Ethiopia Government", "actor2": "Rebels",
                            "event": "armed clash", "day": "20260720"}},
        ]}

    async def fake_ucdp(version=None):
        return {"type": "FeatureCollection", "features": []}

    import app.intel.conflict as conflict_mod
    import app.intel.ucdp as ucdp_mod

    monkeypatch.setattr(conflict_mod, "conflict_events", fake_conflict)
    monkeypatch.setattr(ucdp_mod, "ucdp_events", fake_ucdp)
    cache.invalidate("country:security:ETH:24")

    r = client.get("/api/country/ETH/security")
    assert r.status_code == 200
    body = r.json()
    assert body["counts"]["conflict"] == 1  # only the "Ethiopia Government" event
    urls = {e["url"] for e in body["events"] if e["url"]}
    assert "https://example.com/st-paul-shooting" not in urls


def test_security_degrades_when_layers_unavailable(client, monkeypatch):
    async def dead_conflict(hours=6):
        return {"type": "FeatureCollection", "features": [], "unavailable": True,
                "note": "gdelt down"}

    async def dead_ucdp(version=None):
        return {"type": "FeatureCollection", "features": [], "unavailable": True,
                "note": "no token"}

    import app.intel.conflict as conflict_mod
    import app.intel.ucdp as ucdp_mod

    monkeypatch.setattr(conflict_mod, "conflict_events", dead_conflict)
    monkeypatch.setattr(ucdp_mod, "ucdp_events", dead_ucdp)
    cache.invalidate("country:security:BRA:24")

    r = client.get("/api/country/BRA/security")
    assert r.status_code == 200
    body = r.json()
    assert body["counts"]["conflict"] == 0 and body["counts"]["ucdp"] == 0
    assert body["sources"]["conflict"]["unavailable"] is True
    assert body["sources"]["ucdp"]["unavailable"] is True


# ── /brief route ──────────────────────────────────────────────────────────────


def test_brief_ok_with_mocked_llm(client, monkeypatch):
    # Keep all data-fetch cheap/degraded; only assert the LLM plumbing + shape.
    async def fake_wb(iso3u, ids, years):
        return [{"id": "NY.GDP.MKTP.CD", "label": "GDP", "unit": "current US$",
                 "series": [{"year": "2024", "value": 21000000000000}]}]

    async def fake_profile(iso3, name=None):
        return {"iso3": iso3, "name": name, "leadership": [
            {"role": "Head of state", "person": "Pat President", "start": "2021-01-01"}],
            "military_branches": ["Alpha Army"]}

    async def fake_security(iso3, name=None, hours=24):
        return {"counts": {"conflict": 0, "ucdp": 0, "installations": 0},
                "events": [], "notes": ["note"]}

    captured = {}

    async def fake_chat(messages, **kwargs):
        captured["sys"] = messages[0]["content"]
        captured["tier"] = kwargs.get("tier")
        captured["max_tokens"] = kwargs.get("max_tokens")
        return LlmResult(text="## Overview\nStable.", model="test-model", backend="deepseek")

    monkeypatch.setattr(country_stats, "load_worldbank", fake_wb)
    monkeypatch.setattr(cp, "fetch_profile", fake_profile)
    monkeypatch.setattr(cp, "country_security", fake_security)
    import app.llm as llm_mod

    monkeypatch.setattr(llm_mod, "chat", fake_chat)
    cache.invalidate("country:brief:USA")

    r = client.get("/api/country/USA/brief")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["markdown"].startswith("## Overview")
    assert body["model"] == "test-model" and body["backend"] == "deepseek"
    assert captured["tier"] == "fast" and captured["max_tokens"] == cp._BRIEF_MAX_TOKENS
    assert "senior all-source intelligence analyst" in captured["sys"]


def test_brief_trims_truncated_body_before_sources(client, monkeypatch):
    # Regression: a live run hit the model's length cap mid-sentence (once even
    # mid-URL) inside ## Recent security events, right before the deterministic
    # ## Sources footer got appended. The raw truncated fragment must never
    # reach the response markdown.
    async def fake_wb(iso3u, ids, years):
        return []

    async def fake_profile(iso3, name=None):
        return {"leadership": [], "military_branches": []}

    async def fake_security(iso3, name=None, hours=24):
        return {
            "counts": {"conflict": 1, "ucdp": 0, "installations": 0},
            "events": [
                {"label": "clash", "date": "2026-07-20", "url": "https://example.com/a",
                 "source": "gdelt"},
            ],
            "notes": [],
        }

    truncated = (
        "## Overview\nStable.\n\n## Recent security events\nA military force "
        "event involving actors was reported ([source](https://example.com/"
        "very-long-article-that-got-cut-off-mid-url-righ"
    )

    async def fake_chat(messages, **kwargs):
        return LlmResult(text=truncated, model="test-model", backend="deepseek")

    monkeypatch.setattr(country_stats, "load_worldbank", fake_wb)
    monkeypatch.setattr(cp, "fetch_profile", fake_profile)
    monkeypatch.setattr(cp, "country_security", fake_security)
    import app.llm as llm_mod

    monkeypatch.setattr(llm_mod, "chat", fake_chat)
    cache.invalidate("country:brief:ETH")

    r = client.get("/api/country/ETH/brief")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    md = body["markdown"]
    assert "## Sources" in md
    pre_sources = md.split("## Sources")[0]
    assert "cut-off-mid-url-righ" not in pre_sources  # dangling fragment dropped
    assert pre_sources.rstrip().endswith("Stable.")  # cut back to the last clean sentence


def test_brief_degrades_when_no_llm(client, monkeypatch):
    async def fake_wb(iso3u, ids, years):
        return []

    async def fake_profile(iso3, name=None):
        return {"leadership": [], "military_branches": []}

    async def fake_security(iso3, name=None, hours=24):
        return {"counts": {}, "events": [], "notes": []}

    async def dead_chat(messages, **kwargs):
        return LlmResult(text=None, error="no LLM backend configured")

    monkeypatch.setattr(country_stats, "load_worldbank", fake_wb)
    monkeypatch.setattr(cp, "fetch_profile", fake_profile)
    monkeypatch.setattr(cp, "country_security", fake_security)
    import app.llm as llm_mod

    monkeypatch.setattr(llm_mod, "chat", dead_chat)
    cache.invalidate("country:brief:GBR")

    r = client.get("/api/country/GBR/brief")
    assert r.status_code == 200  # degrade, never 500
    body = r.json()
    assert body["ok"] is False and body["reason"]


# ── WB indicator manifest (extended, shape unchanged) ─────────────────────────


def test_wb_manifest_includes_new_military_codes_wellformed():
    ids = {i["id"] for i in country_stats.WB_INDICATORS}
    for code in ("MS.MIL.XPND.CD", "MS.MIL.XPND.ZS", "MS.MIL.MPRT.KD", "MS.MIL.XPRT.KD"):
        assert code in ids
    # Manifest shape contract: every row is {id,label,unit}, id id-safe.
    for i in country_stats.WB_INDICATORS:
        assert set(i) >= {"id", "label", "unit"}
        assert all(c.isalnum() or c == "." for c in i["id"])
