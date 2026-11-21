"""The http (URL poll) connection: boundary checks, and one poll landing rows.

The fetch itself is ``intel/evidence._fetch_guarded`` and has its own SSRF
tests; here it is replaced so the test proves the runner's half — format →
parser → dataset version — and that an auth header never reaches a stored error.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.foundry import connections as C
from app.intel import evidence


@pytest.fixture
def dataset(client: TestClient) -> str:
    return client.post(
        "/api/foundry/datasets/upload",
        files={"file": ("seed.csv", b"name,lat,lon\nSEED,1,1\n", "text/csv")},
        data={"name": "http_target"},
    ).json()["id"]


@pytest.mark.parametrize(
    ("config", "needle"),
    [
        ({"url": "file:///etc/passwd"}, "http(s) URL"),
        ({"url": "http://127.0.0.1:8000/api/x"}, "public host"),
        ({"url": "http://[::ffff:10.0.0.1]/x"}, "public host"),
        ({"url": "https://example.com/x", "format": "xlsx"}, "format must be"),
        ({"url": "https://example.com/x", "auth_header_env": "Bearer abc"}, "NAME"),
    ],
)
def test_the_route_refuses_a_bad_http_config(
    client: TestClient, dataset: str, config: dict, needle: str
) -> None:
    r = client.post(
        "/api/foundry/connections",
        json={"name": "bad", "kind": "http", "dataset_id": dataset, "config": config},
    )
    assert r.status_code == 422, r.text
    assert needle in r.text


def test_the_route_accepts_a_public_url(client: TestClient, dataset: str) -> None:
    r = client.post(
        "/api/foundry/connections",
        json={
            "name": "gdelt",
            "kind": "http",
            "dataset_id": dataset,
            "config": {"url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
                       "format": "geojson"},
            "enabled": False,
        },
    )
    assert r.status_code == 200, r.text


@pytest.mark.anyio
async def test_a_poll_lands_geojson_rows_and_sends_the_auth_header(
    client: TestClient, dataset: str, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    seen: dict = {}

    async def _fake(url, settings, *, cap=None, extra_headers=None, max_hops=5):  # type: ignore[no-untyped-def]
        seen.update(url=url, cap=cap, headers=extra_headers)
        body = (
            b'{"type":"FeatureCollection","features":[{"type":"Feature",'
            b'"geometry":{"type":"Point","coordinates":[32.3,30.5]},'
            b'"properties":{"name":"PROTEST ONE"}}]}'
        )
        return evidence._Fetched(200, {}, url, body)

    monkeypatch.setattr(evidence, "_fetch_guarded", _fake)
    monkeypatch.setenv("OSINT_HTTP_AUTH_TEST", "Authorization: Bearer s3cret")

    from app.config import get_settings
    from app.foundry.store import MAX_UPLOAD_BYTES, FoundryStore

    conn = {
        "id": "conn_http",
        "name": "riots",
        "kind": "http",
        "dataset_id": dataset,
        "config": {"url": "https://example.com/feed", "format": "geojson",
                   "auth_header_env": "OSINT_HTTP_AUTH_TEST"},
    }
    task = asyncio.create_task(C._run_http(FoundryStore(get_settings()), conn))
    rows: list = []
    for _ in range(200):
        await asyncio.sleep(0.05)
        rows = client.get(f"/api/foundry/datasets/{dataset}/rows").json()["rows"]
        if any(r.get("name") == "PROTEST ONE" for r in rows):
            break
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    # A poll is a snapshot: the seed row from the upload is replaced, not kept.
    assert [r.get("name") for r in rows] == ["PROTEST ONE"]
    hit = rows[0]
    assert (hit["lat"], hit["lon"]) == (30.5, 32.3)
    assert seen["headers"] == {"Authorization": "Bearer s3cret"}
    assert seen["cap"] == MAX_UPLOAD_BYTES


@pytest.mark.anyio
async def test_a_non_2xx_answer_raises_without_the_token(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    async def _fake(url, settings, **_kw):  # type: ignore[no-untyped-def]
        return evidence._Fetched(403, {}, url, b"Bearer s3cret rejected")

    monkeypatch.setattr(evidence, "_fetch_guarded", _fake)
    with pytest.raises(RuntimeError, match="HTTP 403") as exc:
        await C._run_http(None, {"config": {"url": "https://example.com/f?key=s3cret"}})  # type: ignore[arg-type]
    assert "s3cret" not in str(exc.value)


@pytest.mark.parametrize(
    ("body", "path", "names"),
    [
        (b'{"data":[{"name":"A"},{"name":"B"}]}', "data", ["A", "B"]),
        (b'{"hits":{"hits":[{"name":"C"}]}}', "hits.hits", ["C"]),
        (b'[{"name":"D"}]', "", ["D"]),
        (b'{"states":{"Kyiv":{"name":"K"},"Lviv":{"name":"L"}}}', "states", ["K", "L"]),
    ],
)
def test_rows_path_walks_to_the_wrapped_array(body: bytes, path: str, names: list) -> None:
    assert [r["name"] for r in C.http_rows(body, "json", path)] == names


def test_rows_path_names_the_missing_key() -> None:
    with pytest.raises(ValueError, match="no key 'nope'"):
        C.http_rows(b'{"data":[]}', "json", "nope")


def test_the_route_refuses_a_bad_rows_path(client: TestClient, dataset: str) -> None:
    r = client.post(
        "/api/foundry/connections",
        json={"name": "bad", "kind": "http", "dataset_id": dataset,
              "config": {"url": "https://example.com/x", "rows_path": "a[0]; drop"}},
    )
    assert r.status_code == 422 and "rows_path" in r.text


def test_every_shipped_preset_passes_the_http_boundary() -> None:
    """A preset is installed through the same validator a hand-typed connection
    meets, so a bad entry in source_presets.json fails here, not in the UI."""
    from app.routes import foundry as F

    presets = F._presets()
    assert len({p["id"] for p in presets}) == len(presets)
    for p in presets:
        assert p["title"] and p["license"] and p["category"], p["id"]
        F._reject_bad_http_config("http", {k: p[k] for k in F._PRESET_KEYS if k in p})


def test_installing_a_preset_creates_dataset_and_connection_once(
    client: TestClient, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    async def _noop() -> None:
        return None

    monkeypatch.setattr(C, "reconcile", _noop)
    listed = client.get("/api/foundry/source-presets").json()
    pid = listed[0]["id"]
    assert listed[0]["installed"] is False

    r = client.post(f"/api/foundry/source-presets/{pid}/install")
    assert r.status_code == 200, r.text
    conn = r.json()["connection"]
    assert conn["kind"] == "http" and conn["config"]["url"] == listed[0]["url"]
    assert next(p for p in client.get("/api/foundry/source-presets").json() if p["id"] == pid)["installed"]

    assert client.post(f"/api/foundry/source-presets/{pid}/install").status_code == 409
    assert client.post("/api/foundry/source-presets/nope/install").status_code == 404


@pytest.mark.anyio
async def test_repeated_polls_replace_rather_than_accumulate(
    client: TestClient, dataset: str, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    """The regression: appending each poll re-added every earlier poll's rows,
    so a feed of N rows grew by N per cycle until the row cap refused it."""
    polls = 0

    async def _fake(url, settings, **_kw):  # type: ignore[no-untyped-def]
        nonlocal polls
        polls += 1
        return evidence._Fetched(200, {}, url, b"name,lat,lon\nA,1,1\nB,2,2\n")

    monkeypatch.setattr(evidence, "_fetch_guarded", _fake)
    monkeypatch.setattr(C, "_HTTP_MIN_INTERVAL_S", 0.0)

    from app.config import get_settings
    from app.foundry.store import FoundryStore

    conn = {"id": "conn_rep", "name": "rep", "kind": "http", "dataset_id": dataset,
            "config": {"url": "https://example.com/f.csv", "format": "csv", "interval_s": 0.01}}
    task = asyncio.create_task(C._run_http(FoundryStore(get_settings()), conn))
    for _ in range(200):
        await asyncio.sleep(0.05)
        if polls >= 4:
            break
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert polls >= 4
    rows = client.get(f"/api/foundry/datasets/{dataset}/rows").json()["rows"]
    assert sorted(r["name"] for r in rows) == ["A", "B"]


def test_rss_rows_carry_georss_points() -> None:
    body = (
        b'<?xml version="1.0"?><rss version="2.0" xmlns:georss="http://www.georss.org/georss">'
        b"<channel><title>t</title><item><title>Quake A</title><link>http://x/a</link>"
        b"<georss:point>35.5 139.7</georss:point></item><item><title>No geo</title></item>"
        b"</channel></rss>"
    )
    rows = C.http_rows(body, "rss")
    assert rows[0]["title"] == "Quake A" and (rows[0]["lat"], rows[0]["lon"]) == (35.5, 139.7)
    assert "lat" not in rows[1]
