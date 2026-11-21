"""Guards for the shipped OSM military dataset (osm_military.json.gz) and its
route: every row is served, per category, with ids that resolve as entities."""

from __future__ import annotations

from app import places

# Category counts of the 2026-11-20 atlas snapshot (258,956 rows).
EXPECTED = {
    "bunker": 106634,
    "military_landuse": 61795,
    "trench": 26623,
    "barracks": 15784,
    "office": 8457,
    "checkpoint": 7855,
    "other": 6912,
    "range": 5252,
    "base": 4451,
    "unspecified": 3290,
    "training_area": 3144,
    "danger_area": 2906,
    "nuclear_test_site": 2513,
    "airfield": 2304,
    "obstacle_course": 1036,
}


def test_every_row_is_served_per_category():
    for cat, n in EXPECTED.items():
        fc = places.facility_bbox_features("osm_military", -180, -90, 180, 90, limit=10**6, category=cat)
        assert len(fc["features"]) == n, cat
    assert len(places.osm_military()) == sum(EXPECTED.values())


def test_rows_keep_osm_identity_and_drop_empty_fields():
    ids = set()
    for r in places.osm_military()[:5000]:
        assert r["id"][:5] in ("osm-n", "osm-w", "osm-r")
        assert r["osm_url"].startswith("https://www.openstreetmap.org/")
        assert "" not in r.values() and None not in r.values()
        ids.add(r["id"])
    assert len(ids) == 5000


def test_route_and_entity(client):
    r = client.get("/api/places/osm-military", params={"bbox": "2.0,48.5,2.6,49.0", "category": "bunker"})
    assert r.status_code == 200
    feats = r.json()["features"]
    assert feats and all(f["id"].startswith("military:osm-") for f in feats)
    assert all(f["properties"]["category"] == "bunker" for f in feats)
    # no bbox → empty (zoom-gated layer)
    assert client.get("/api/places/osm-military").json()["features"] == []
    e = client.get(f"/api/entity/{feats[0]['id']}")
    body = e.json()
    assert e.status_code == 200 and body["source"] == "openstreetmap"
    assert body["osm_url"].startswith("https://www.openstreetmap.org/") and body["region"]
    # an unknown osm id is a miss, and MIRTA ids still resolve through the other index
    assert places.facility_by_id("osm-n0") is None
    assert places.facility_by_id("mirta-1") is not None


def test_named_features_are_searchable(client):
    hits = places.search_places("Kaserne", limit=8)
    mil = [h for h in hits if h["id"].startswith("military:osm-")]
    assert mil and all("kaserne" in h["label"].lower() for h in mil)
    assert all(h["kind"] == "place" and h["detail"] for h in mil)
    # airports still rank first on a shared name
    assert places.search_places("LAX")[0]["kind"] == "airport"
    r = client.get("/api/search", params={"q": "Kaserne"})
    assert r.status_code == 200
    assert any(x["id"].startswith("military:osm-") for x in r.json()["results"])


def test_military_name_hits_do_not_suppress_the_geocoder(client, monkeypatch):
    from app.routes import search as search_route

    async def _fake(key, ttl, loader):
        return [{"kind": "place", "id": "poi:1,2", "label": "Kaserne (town)", "lon": 2.0, "lat": 1.0}]

    monkeypatch.setattr(search_route.cache, "get_or_fetch", _fake)
    res = client.get("/api/search", params={"q": "Kaserne"}).json()["results"]
    assert res[0]["id"] == "poi:1,2"  # geocoded place first
    assert any(x["id"].startswith("military:osm-") for x in res)


def test_dense_view_is_sampled_stably_not_cut_in_grid_order():
    wide = places.facility_bbox_features("osm_military", -10, 40, 30, 60, limit=5000, category="bunker")
    assert wide["truncated"] and wide["total"] > 5000 and len(wide["features"]) == 5000
    # spread across the whole view, not just the first grid cells
    lons = [f["geometry"]["coordinates"][0] for f in wide["features"]]
    assert min(lons) < 0 and max(lons) > 20
    # every marker kept in the wide view that falls in a narrower one is kept there too
    narrow = places.facility_bbox_features("osm_military", 0, 45, 10, 52, limit=5000, category="bunker")
    narrow_ids = {f["id"] for f in narrow["features"]}
    inside = {
        f["id"]
        for f in wide["features"]
        if 0 <= f["geometry"]["coordinates"][0] <= 10 and 45 <= f["geometry"]["coordinates"][1] <= 52
    }
    assert inside <= narrow_ids


def test_status_filter_splits_in_use_from_out_of_use(client):
    world = (-180, -90, 180, 90)
    inactive = places.facility_bbox_features("osm_military", *world, limit=10**6, status="inactive")
    assert len(inactive["features"]) == 19030
    assert {f["properties"]["status"] for f in inactive["features"]} == {"disused", "abandoned", "ruins"}
    active = sum(
        len(places.facility_bbox_features("osm_military", *world, limit=10**6, category=c, status="active")["features"])
        for c in EXPECTED
    )
    assert active + len(inactive["features"]) == sum(EXPECTED.values())
    r = client.get("/api/places/osm-military", params={"bbox": "-10,40,30,60", "status": "inactive", "limit": 50})
    assert r.status_code == 200 and all(f["properties"]["status"] for f in r.json()["features"])
    assert client.get("/api/places/osm-military", params={"bbox": "0,0,1,1", "status": "bogus"}).status_code == 422


def test_branches_come_from_data_not_guesses():
    rows = places.osm_military()
    for r in rows:
        if r["category"] == "airfield":
            assert r["branch"] == "air"
        elif r["category"] == "base" and "branch" in r:
            assert r["branch"] in ("air", "naval", "army") and r["branch_basis"]
        else:
            assert "branch" not in r
    named = {r.get("name"): r.get("branch") for r in rows if r["category"] == "base"}
    assert named.get("Base Naval de Pemba") == "naval"


def test_route_thins_dense_views_on_a_stable_grid(client):
    def ids(bbox):
        r = client.get("/api/places/osm-military", params={"bbox": bbox, "category": "bunker", "limit": 5000})
        return r.json()

    wide = ids("-10,40,30,60")
    assert wide["truncated"] and len(wide["features"]) < 3000 < wide["total"]
    # panning keeps the markers identical wherever both views fully cover a
    # grid cell (cell = 2/32 = 2**-4 deg for a 2 deg view; margin 0.07 deg)
    def core(fc):
        return {
            f["id"]
            for f in fc["features"]
            if -1.33 <= f["geometry"]["coordinates"][0] <= 0.43
            and 48.87 <= f["geometry"]["coordinates"][1] <= 49.73
        }

    a, b = core(ids("-1.5,48.8,0.5,49.8")), core(ids("-1.4,48.8,0.6,49.8"))
    assert a and a == b
    # street level shows every row in view
    street = ids("-0.7,49.33,-0.69,49.34")
    assert "truncated" not in street
