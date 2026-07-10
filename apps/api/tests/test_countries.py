"""Country-OSINT catalog (docs/country-osint-spec.md): loader + routes.

The ``country_data/*.json`` directory is filled independently by 53 parallel
extraction agents — some files may not exist yet when this test runs. We
therefore assert "np is present and count >= 1", never a hardcoded 53.
"""

from __future__ import annotations

from app.keys import UserCtx, current_user
from app.osint import country_catalog
from app.osint.fetch import normalise_domain

# ── loader ──────────────────────────────────────────────────────────────────


def test_catalog_loads_np_and_is_non_empty() -> None:
    assert len(country_catalog.CATALOG) >= 1
    codes = {r.code for r in country_catalog.CATALOG}
    assert "np" in codes


def test_by_code_round_trips_np() -> None:
    rec = country_catalog.by_code("np")
    assert rec is not None
    assert rec.name == "Nepal"
    assert rec.region == "Asia"
    assert rec.iso2 == "NP"
    assert len(rec.resources) > 0
    for res in rec.resources:
        assert res.category in country_catalog.CATEGORIES


def test_by_code_unknown_returns_none() -> None:
    assert country_catalog.by_code("zz-not-a-country") is None


def test_list_summary_shape() -> None:
    summary = country_catalog.list_summary()
    assert summary["count"] == len(country_catalog.CATALOG)
    assert "np" in {c["code"] for c in summary["countries"]}
    assert set(country_catalog.CATEGORIES) == set(summary["categories"])


def test_list_summary_filters_by_region_and_category() -> None:
    all_summary = country_catalog.list_summary()
    asia = country_catalog.list_summary(region="Asia")
    assert asia["count"] <= all_summary["count"]
    assert all(c["region"] == "Asia" for c in asia["countries"])

    by_cat = country_catalog.list_summary(category="open-data")
    assert all(c["category_counts"].get("open-data", 0) > 0 for c in by_cat["countries"])


# ── build_graph: the mint function ───────────────────────────────────────────


def test_build_graph_unknown_code_returns_none() -> None:
    assert country_catalog.build_graph("zz-not-a-country") is None


def test_build_graph_mints_country_resource_domain_and_links() -> None:
    graph = country_catalog.build_graph("np")
    assert graph is not None
    node_ids = {o.id for o in graph["nodes"]}

    assert "country:np" in node_ids
    resource_ids = {i for i in node_ids if i.startswith("resource:np:")}
    assert resource_ids
    domain_ids = {i for i in node_ids if i.startswith("domain:")}
    assert domain_ids

    country_obj = next(o for o in graph["nodes"] if o.id == "country:np")
    assert country_obj.kind == "country"
    resource_obj = next(o for o in graph["nodes"] if o.id in resource_ids)
    assert resource_obj.kind == "resource"

    has_resource_links = [lk for lk in graph["links"] if lk.rel == "has_resource"]
    assert has_resource_links
    assert all(lk.src == "country:np" for lk in has_resource_links)
    assert {lk.dst for lk in has_resource_links} <= resource_ids

    hosted_at_links = [lk for lk in graph["links"] if lk.rel == "hosted_at"]
    assert hosted_at_links
    assert all(lk.src in resource_ids for lk in hosted_at_links)
    assert all(lk.dst in domain_ids for lk in hosted_at_links)


def test_build_graph_domain_bridge_matches_normalise_domain() -> None:
    """The bridge: a resource's hosted_at domain id equals the same
    domain:<host> id the digital-OSINT classify_target()/investigate() path
    would mint for that host, so the two graphs join on ONE node."""
    rec = country_catalog.by_code("np")
    assert rec is not None
    graph = country_catalog.build_graph("np")
    assert graph is not None

    expected_hosts = {
        normalise_domain(r.url) for r in rec.resources if normalise_domain(r.url)
    }
    assert expected_hosts  # np.json has real FQDN resource urls

    domain_ids = {o.id for o in graph["nodes"] if o.id.startswith("domain:")}
    assert domain_ids == {"domain:" + h for h in expected_hosts}


# ── routes: keyless GETs ─────────────────────────────────────────────────────


def test_route_list_countries(client) -> None:  # type: ignore[no-untyped-def]
    r = client.get("/api/osint/countries")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] >= 1
    assert "np" in {c["code"] for c in body["countries"]}


def test_route_list_countries_filters(client) -> None:  # type: ignore[no-untyped-def]
    r = client.get("/api/osint/countries", params={"region": "Asia"})
    assert r.status_code == 200
    assert all(c["region"] == "Asia" for c in r.json()["countries"])


def test_route_categories(client) -> None:  # type: ignore[no-untyped-def]
    r = client.get("/api/osint/countries/categories")
    assert r.status_code == 200
    body = r.json()
    assert set(body["categories"]) == set(country_catalog.CATEGORIES)
    assert set(body["counts"]) == set(country_catalog.CATEGORIES)


def test_route_country_detail_round_trips(client) -> None:  # type: ignore[no-untyped-def]
    r = client.get("/api/osint/countries/np")
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "np"
    assert body["name"] == "Nepal"
    assert len(body["resources"]) > 0
    assert all("category" in res for res in body["resources"])


def test_route_country_detail_unknown_404(client) -> None:  # type: ignore[no-untyped-def]
    r = client.get("/api/osint/countries/zz-nope")
    assert r.status_code == 404


def test_route_graph_preview_not_persisted(client) -> None:  # type: ignore[no-untyped-def]
    r = client.get("/api/osint/countries/np/graph")
    assert r.status_code == 200
    body = r.json()
    ids = {n["id"] for n in body["nodes"]}
    assert "country:np" in ids
    assert any(lk["rel"] == "has_resource" for lk in body["links"])
    assert any(lk["rel"] == "hosted_at" for lk in body["links"])

    # Preview must NOT have written anything into the (keyless "local") ontology.
    r2 = client.get("/api/ontology/object/country:np")
    assert r2.status_code == 404


def test_route_graph_preview_unknown_404(client) -> None:  # type: ignore[no-untyped-def]
    r = client.get("/api/osint/countries/zz-nope/graph")
    assert r.status_code == 404


# ── ingest: persists into the caller's ontology ──────────────────────────────


def test_route_ingest_requires_auth(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post("/api/osint/countries/np/ingest")
    assert r.status_code == 401


def test_route_ingest_persists_into_local_registry(client) -> None:  # type: ignore[no-untyped-def]
    # Same "local" identity current_user_or_local resolves to on this keyless
    # test boot (no Supabase configured), so the follow-up ontology GETs
    # (which use current_user_or_local) read the SAME user-scoped graph the
    # ingest (current_user) just wrote — user-scoped registries don't share
    # rows across identities (test_ontology_local's u1/u2 scoping guard).
    client.app.dependency_overrides[current_user] = lambda: UserCtx(user_id="local", token="")
    try:
        r = client.post("/api/osint/countries/np/ingest")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["root"] == "country:np"
        assert body["objects"] > 0
        assert body["links"] > 0

        # It actually landed in the ontology store, keyless.
        obj = client.get("/api/ontology/object/country:np")
        assert obj.status_code == 200
        assert obj.json()["props"]["name"] == "Nepal"

        sa = client.get("/api/ontology/search-around/country:np")
        assert sa.status_code == 200
        sa_body = sa.json()
        assert any(o["id"].startswith("resource:np:") for o in sa_body["objects"])
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_route_ingest_unknown_code_404(client) -> None:  # type: ignore[no-untyped-def]
    client.app.dependency_overrides[current_user] = lambda: UserCtx(user_id="t", token="t")
    try:
        r = client.post("/api/osint/countries/zz-nope/ingest")
        assert r.status_code == 404
    finally:
        client.app.dependency_overrides.pop(current_user, None)
