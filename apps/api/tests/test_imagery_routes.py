def test_catalog_lists_gibs(client):
    r = client.get("/api/imagery/catalog")
    assert r.status_code == 200
    body = r.json()
    ids = {layer["id"] for layer in body["layers"]}
    assert "MODIS_Terra_CorrectedReflectance_TrueColor" in ids
    assert all(layer["provider"] == "gibs" for layer in body["layers"])


def test_tile_proxies_and_caches(client, monkeypatch):
    calls = {"n": 0}

    async def fake_fetch(url: str):
        calls["n"] += 1
        assert url.startswith("https://gibs.earthdata.nasa.gov/wmts/")
        return b"\xff\xd8\xff\xe0JPEGbytes"

    monkeypatch.setattr("app.routes.imagery._fetch_bytes", fake_fetch)
    path = (
        "/api/imagery/gibs/MODIS_Terra_CorrectedReflectance_TrueColor/3/4/2"
        "?date=2026-06-10"
    )
    r1 = client.get(path)
    r2 = client.get(path)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.content == b"\xff\xd8\xff\xe0JPEGbytes"
    assert calls["n"] == 1  # second served from disk cache


def test_unknown_layer_404(client):
    r = client.get("/api/imagery/gibs/NoSuchLayer/0/0/0?date=2026-06-10")
    assert r.status_code == 404


def test_unknown_provider_404(client):
    r = client.get("/api/imagery/nope/Layer/0/0/0?date=2026-06-10")
    assert r.status_code == 404


def test_bad_date_400(client):
    r = client.get(
        "/api/imagery/gibs/MODIS_Terra_CorrectedReflectance_TrueColor/0/0/0?date=June"
    )
    assert r.status_code == 400
