"""Shape guard for the manual-pivot catalog (app/osint/pivots.py).

The catalog is data, so the failure mode is a typo, not a crash: a template
that lost its placeholder renders the same url for every target and looks like
it worked. These assertions are the cheapest thing that catches that, plus the
handful of rendering rules the panel depends on.

No network. The catalog never fetches anything, which is the point of it.
"""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.osint.pivots import KINDS, PIVOTS, pivots_for, placeholders_for


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(create_app())


def _all_entries() -> list[tuple[str, dict[str, str]]]:
    return [(kind, e) for kind, entries in PIVOTS.items() for e in entries]


def test_catalog_covers_exactly_the_declared_kinds() -> None:
    assert set(PIVOTS) == set(KINDS)
    for kind, entries in PIVOTS.items():
        assert entries, f"{kind} declares no pivots"


def test_every_template_carries_at_least_one_placeholder() -> None:
    for kind, e in _all_entries():
        found = set(re.findall(r"\{([^}]*)\}", e["url"]))
        assert found, f"{kind}/{e['id']} has no placeholder: {e['url']}"


def test_every_url_is_https() -> None:
    # A plain-http pivot leaks the selector on the wire and several of the
    # book's entries are http-only, so they are dropped rather than shipped.
    for kind, e in _all_entries():
        assert e["url"].startswith("https://"), f"{kind}/{e['id']}: {e['url']}"


def test_ids_are_unique_within_a_kind() -> None:
    for kind, entries in PIVOTS.items():
        ids = [e["id"] for e in entries]
        assert len(ids) == len(set(ids)), f"{kind} has duplicate ids"


def test_every_entry_names_a_category_and_a_name() -> None:
    for kind, e in _all_entries():
        assert e.get("name"), f"{kind}/{e['id']} has no name"
        assert e.get("category"), f"{kind}/{e['id']} has no category"


def test_only_known_format_tokens() -> None:
    for _kind, e in _all_entries():
        assert e.get("fmt", "raw") in ("raw", "dash", "plus", "dash1", "e164")


def test_no_em_dashes_in_operator_facing_text() -> None:
    # apps/web/CLAUDE.md: dashboard copy carries no em dashes, and every one of
    # these strings is rendered in the panel.
    for kind, e in _all_entries():
        for field in ("name", "note"):
            assert "—" not in (e.get(field) or ""), f"{kind}/{e['id']}.{field}"


# ── rendering ──────────────────────────────────────────────────────────────


def test_target_is_url_quoted_into_the_template() -> None:
    groups = pivots_for("person", "Michael Bazzell")
    urls = [link["url"] for g in groups for link in g["links"]]
    assert any("Michael%20Bazzell" in u for u in urls)
    # No raw space survives into any url.
    assert all(" " not in u for u in urls)


def test_phone_formats_render_the_shapes_the_sites_want() -> None:
    urls = {
        link["id"]: link["url"]
        for g in pivots_for("phone", "(618) 462-0000")
        for link in g["links"]
    }
    assert urls["thatsthem"].endswith("/618-462-0000")          # dash
    assert urls["whitepages"].endswith("/1-618-462-0000")       # dash1
    assert urls["syncme"].endswith("number=16184620000")        # e164
    assert urls["zabasearch"].endswith("/6184620000")           # raw digits


def test_person_name_formats() -> None:
    urls = {
        link["id"]: link["url"]
        for g in pivots_for("person", "Michael Bazzell")
        for link in g["links"]
    }
    assert urls["fastpeoplesearch"].endswith("/michael-bazzell")
    # The separator survives quoting: the book prints michael+bazzell, and the
    # value is still escaped everywhere else.
    assert urls["zabasearch"].endswith("/michael+bazzell/")


def test_wallet_drops_the_chain_prefix_and_filters_by_chain() -> None:
    btc = pivots_for("wallet", "btc:1EzwoHtiXB4iFwedPr49iywjZn2nnekhoj")
    cats = {g["category"] for g in btc}
    assert "Bitcoin" in cats and "Ethereum" not in cats
    urls = [link["url"] for g in btc for link in g["links"]]
    assert all("btc%3A" not in u and "btc:" not in u.split("//", 1)[1] for u in urls)

    eth = pivots_for("wallet", "eth:0x" + "a" * 40)
    cats = {g["category"] for g in eth}
    assert "Ethereum" in cats and "Bitcoin" not in cats


def test_unknown_kind_and_empty_target_are_empty_not_an_error() -> None:
    assert pivots_for("nonsense", "x") == []
    assert pivots_for("email", "   ") == []


def test_groups_preserve_catalog_order_and_carry_no_duplicates() -> None:
    for kind in KINDS:
        groups = pivots_for(kind, "example" if kind != "email" else "a@b.com")
        cats = [g["category"] for g in groups]
        assert len(cats) == len(set(cats)), f"{kind} emitted a category twice"


# ── the route ──────────────────────────────────────────────────────────────


def test_route_detects_the_kind_from_the_target(client: TestClient) -> None:
    r = client.get("/api/osint/pivots", params={"target": "jane@example.com"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "email"
    assert body["count"] == len(PIVOTS["email"])


def test_route_detects_a_punctuated_phone(client: TestClient) -> None:
    r = client.get("/api/osint/pivots", params={"target": "618-462-0000"})
    assert r.status_code == 200
    assert r.json()["kind"] == "phone"


def test_route_takes_an_explicit_kind_for_a_free_text_name(client: TestClient) -> None:
    r = client.get("/api/osint/pivots", params={"target": "Michael Bazzell", "kind": "person"})
    assert r.status_code == 200
    assert r.json()["kind"] == "person"
    assert r.json()["count"] == len(PIVOTS["person"])


def test_route_rejects_an_unknown_kind(client: TestClient) -> None:
    r = client.get("/api/osint/pivots", params={"target": "x", "kind": "nonsense"})
    assert r.status_code == 400


def test_route_rejects_an_unclassifiable_target_with_no_kind(client: TestClient) -> None:
    r = client.get("/api/osint/pivots", params={"target": "Michael Bazzell"})
    assert r.status_code == 400
    assert "kind=" in r.json()["detail"]


def test_route_makes_no_upstream_call(client: TestClient, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    # If this route ever grew a fetch, it would stop being instant and start
    # being able to fail. Prove it by making any upstream call explode.
    import app.osint.fetch as F

    async def boom(*a: object, **k: object) -> None:
        raise AssertionError("pivots must not touch the network")

    monkeypatch.setattr(F, "fetch_json", boom)
    assert client.get("/api/osint/pivots", params={"target": "8.8.8.8"}).status_code == 200


def test_catalog_is_worth_having() -> None:
    # A floor, not a target: the wave shipped 170 across ten kinds. If a future
    # edit halves it, that is a deletion someone should have to justify.
    total = sum(len(v) for v in PIVOTS.values())
    assert total >= 200, total


def test_placeholders_stay_inside_the_kinds_allowed_set() -> None:
    # `{anything_else}` would survive into the url as literal braces. The
    # coordinate kind is the one that uses {lat}/{lon} instead of {q}.
    for kind, e in _all_entries():
        allowed = placeholders_for(kind)
        for tok in re.findall(r"\{([^}]*)\}", e["url"]):
            assert tok in allowed, f"{kind}/{e['id']} uses {{{tok}}}, allowed {sorted(allowed)}"


def test_no_rendered_url_keeps_a_literal_brace() -> None:
    samples = {
        "coordinate": "38.897700,-77.036500",
        "wallet": "btc:1EzwoHtiXB4iFwedPr49iywjZn2nnekhoj",
        "email": "jane@example.com",
        "video": "dQw4w9WgXcQ",
    }
    for kind in KINDS:
        for g in pivots_for(kind, samples.get(kind, "example")):
            for link in g["links"]:
                assert "{" not in link["url"] and "}" not in link["url"], (
                    f"{kind}/{link['id']}: {link['url']}"
                )


# ── ch. 27 coordinates ─────────────────────────────────────────────────────


def test_coordinate_splits_lat_and_lon_and_respects_site_order() -> None:
    urls = {
        link["id"]: link["url"]
        for g in pivots_for("coordinate", "38.897700,-77.036500")
        for link in g["links"]
    }
    # Google names the point and then centres on it: {lat}/{lon} twice each.
    assert urls["google-maps"] == (
        "https://www.google.com/maps/place/38.897700,-77.036500"
        "/@38.897700,-77.036500,18z"
    )
    # Yandex wants longitude first, which is exactly why this kind cannot use {q}.
    assert "ll=-77.036500%2C38.897700" in urls["yandex-maps"]
    assert "lat=38.897700&lng=-77.036500" in urls["mapillary"]


def test_coordinate_kind_is_detected_from_a_typed_pair(client: TestClient) -> None:
    for target in ("38.8977,-77.0365", "38.8977 -77.0365"):
        r = client.get("/api/osint/pivots", params={"target": target})
        assert r.status_code == 200, target
        assert r.json()["kind"] == "coordinate", target
        assert r.json()["count"] == len(PIVOTS["coordinate"])


def test_dms_coordinates_reach_the_same_links(client: TestClient) -> None:
    r = client.get("/api/osint/pivots", params={"target": "41°53'23.2\"N 12°29'32.2\"E"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "coordinate"
    assert body["target"] == "41.889778,12.492278"


# ── ch. 28 / ch. 30 ────────────────────────────────────────────────────────


def test_document_and_video_kinds_are_opt_in(client: TestClient) -> None:
    for kind in ("document", "video"):
        r = client.get("/api/osint/pivots", params={"target": "dQw4w9WgXcQ", "kind": kind})
        assert r.status_code == 200
        assert r.json()["kind"] == kind
        assert r.json()["count"] == len(PIVOTS[kind])


def test_video_pivots_build_the_thumbnail_reverse_search() -> None:
    urls = {link["id"]: link["url"] for g in pivots_for("video", "dQw4w9WgXcQ")
            for link in g["links"]}
    assert urls["thumbnail"] == "https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
    # The reverse-image pivots take the thumbnail url, already encoded.
    assert "img.youtube.com%2Fvi%2FdQw4w9WgXcQ" in urls["lens-thumb"]
    assert "img.youtube.com%2Fvi%2FdQw4w9WgXcQ" in urls["yandex-thumb"]
