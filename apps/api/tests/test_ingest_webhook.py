"""Guards for the inbound push endpoint (routes/ingest.py).

Every other way data enters this platform is a pull the platform initiated. This
one route is the exception, so it is the one place an unauthenticated stranger
can write, and the tests here are mostly about that: the token is required, it
is compared in constant time, it is never handed back or logged, and a body that
is too large is refused before it is parsed rather than after.

The functional half is the reason the route is only a few lines: a pushed row
goes through the SAME append + auto-sync path an upload does, so it lands in the
ontology through whatever binding the operator already configured.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def dataset(client: TestClient) -> str:
    r = client.post(
        "/api/foundry/datasets/upload",
        files={"file": ("seed.csv", b"mmsi,name\n1,Alpha\n", "text/csv")},
        data={"name": "pushed"},
    )
    assert r.status_code == 200, r.text
    return r.json()["dataset_id"] if "dataset_id" in r.json() else r.json()["id"]


def _mint(client: TestClient, dataset_id: str) -> str:
    r = client.post(f"/api/foundry/datasets/{dataset_id}/ingest-token")
    assert r.status_code == 200, r.text
    return r.json()["token"]


# ── the token is a credential ─────────────────────────────────────────────────


def test_no_token_is_rejected(client: TestClient, dataset: str) -> None:
    _mint(client, dataset)
    r = client.post(f"/api/ingest/{dataset}", json={"mmsi": 2})
    assert r.status_code == 401


def test_a_wrong_token_is_rejected(client: TestClient, dataset: str) -> None:
    _mint(client, dataset)
    r = client.post(
        f"/api/ingest/{dataset}",
        json={"mmsi": 2},
        headers={"X-Ingest-Token": "not-the-token"},
    )
    assert r.status_code == 401


def test_a_dataset_with_no_token_has_no_ingest_endpoint(
    client: TestClient, dataset: str
) -> None:
    r = client.post(
        f"/api/ingest/{dataset}", json={"mmsi": 2}, headers={"X-Ingest-Token": "x"}
    )
    assert r.status_code == 404


def test_an_unknown_dataset_answers_the_same_as_an_unarmed_one(
    client: TestClient, dataset: str
) -> None:
    """Same status and same detail, so the endpoint cannot be used to find out
    which dataset ids exist."""
    unarmed = client.post(
        f"/api/ingest/{dataset}", json={}, headers={"X-Ingest-Token": "x"}
    )
    unknown = client.post(
        "/api/ingest/ds_doesnotexist", json={}, headers={"X-Ingest-Token": "x"}
    )
    assert unarmed.status_code == unknown.status_code == 404
    assert unarmed.json()["detail"] == unknown.json()["detail"]


def test_the_token_is_shown_once_and_never_again(
    client: TestClient, dataset: str
) -> None:
    token = _mint(client, dataset)
    listed = client.get("/api/foundry/datasets").json()
    assert token not in json.dumps(listed)
    one = client.get(f"/api/foundry/datasets/{dataset}").json()
    assert token not in json.dumps(one)
    assert "ingest_token" not in json.dumps(one)


def test_reminting_replaces_the_previous_token(
    client: TestClient, dataset: str
) -> None:
    old = _mint(client, dataset)
    new = _mint(client, dataset)
    assert old != new
    assert (
        client.post(
            f"/api/ingest/{dataset}", json={"mmsi": 9}, headers={"X-Ingest-Token": old}
        ).status_code
        == 401
    )
    assert (
        client.post(
            f"/api/ingest/{dataset}", json={"mmsi": 9}, headers={"X-Ingest-Token": new}
        ).status_code
        == 200
    )


def test_revoking_closes_the_endpoint(client: TestClient, dataset: str) -> None:
    token = _mint(client, dataset)
    assert client.delete(f"/api/foundry/datasets/{dataset}/ingest-token").status_code == 200
    r = client.post(
        f"/api/ingest/{dataset}", json={"mmsi": 3}, headers={"X-Ingest-Token": token}
    )
    assert r.status_code == 404


# ── what a push does ──────────────────────────────────────────────────────────


def test_one_object_appends_one_row(client: TestClient, dataset: str) -> None:
    token = _mint(client, dataset)
    r = client.post(
        f"/api/ingest/{dataset}",
        json={"mmsi": 2, "name": "Bravo"},
        headers={"X-Ingest-Token": token},
    )
    assert r.status_code == 200
    assert r.json()["rows_added"] == 1
    rows = client.get(f"/api/foundry/datasets/{dataset}/rows").json()["rows"]
    assert [row["name"] for row in rows] == ["Alpha", "Bravo"]


def test_an_array_appends_every_row(client: TestClient, dataset: str) -> None:
    token = _mint(client, dataset)
    r = client.post(
        f"/api/ingest/{dataset}",
        json=[{"mmsi": 2, "name": "Bravo"}, {"mmsi": 3, "name": "Charlie"}],
        headers={"X-Ingest-Token": token},
    )
    assert r.json()["rows_added"] == 2
    rows = client.get(f"/api/foundry/datasets/{dataset}/rows").json()["rows"]
    assert len(rows) == 3


def test_a_push_reaches_the_ontology_through_an_existing_binding(
    client: TestClient, dataset: str
) -> None:
    """The whole point of reusing append + auto_sync rather than writing a new
    ingest path: a pushed row becomes an ontology object with no extra wiring."""
    b = client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": dataset,
            "object_kind": "vessel",
            "key_column": "mmsi",
            "prop_map": {"name": "name"},
        },
    )
    assert b.status_code == 200, b.text
    token = _mint(client, dataset)
    client.post(
        f"/api/ingest/{dataset}",
        json={"mmsi": 636092000, "name": "EVER GIVEN"},
        headers={"X-Ingest-Token": token},
    )
    hits = client.get("/api/ontology/search", params={"q": "EVER GIVEN"}).json()
    assert any(o["props"].get("name") == "EVER GIVEN" for o in hits), hits


def test_an_empty_array_is_a_no_op_not_an_error(
    client: TestClient, dataset: str
) -> None:
    token = _mint(client, dataset)
    r = client.post(
        f"/api/ingest/{dataset}", json=[], headers={"X-Ingest-Token": token}
    )
    assert r.status_code == 200
    assert r.json()["rows_added"] == 0


def test_a_non_object_body_is_a_422(client: TestClient, dataset: str) -> None:
    token = _mint(client, dataset)
    for body in ("[1, 2, 3]", '"a string"', "42"):
        r = client.post(
            f"/api/ingest/{dataset}",
            content=body,
            headers={"X-Ingest-Token": token, "content-type": "application/json"},
        )
        assert r.status_code == 422, body


def test_malformed_json_is_a_422(client: TestClient, dataset: str) -> None:
    token = _mint(client, dataset)
    r = client.post(
        f"/api/ingest/{dataset}",
        content="{not json",
        headers={"X-Ingest-Token": token, "content-type": "application/json"},
    )
    assert r.status_code == 422


def test_an_oversized_body_is_refused_before_it_is_parsed(
    client: TestClient, dataset: str
) -> None:
    """A 413 that arrives only after json.loads has already built the object in
    memory is not a size cap."""
    from app.foundry.store import MAX_UPLOAD_BYTES

    token = _mint(client, dataset)
    body = b'[{"pad": "' + b"x" * (MAX_UPLOAD_BYTES + 1024) + b'"}]'
    r = client.post(
        f"/api/ingest/{dataset}",
        content=body,
        headers={"X-Ingest-Token": token, "content-type": "application/json"},
    )
    assert r.status_code == 413


def test_an_oversized_chunked_body_is_also_refused(
    client: TestClient, dataset: str
) -> None:
    """The Content-Length branch is the easy half. A chunked upload declares no
    length at all, so only the running total in the stream loop stops it."""
    from app.foundry.store import MAX_UPLOAD_BYTES

    token = _mint(client, dataset)

    def _chunks():  # type: ignore[no-untyped-def]
        yield b'[{"pad": "'
        for _ in range((MAX_UPLOAD_BYTES // 65536) + 2):
            yield b"x" * 65536
        yield b'"}]'

    r = client.post(
        f"/api/ingest/{dataset}",
        content=_chunks(),
        headers={"X-Ingest-Token": token, "content-type": "application/json"},
    )
    assert "content-length" not in {k.lower() for k in r.request.headers}
    assert r.status_code == 413


def test_minting_a_token_for_an_unknown_dataset_is_a_404(client: TestClient) -> None:
    assert (
        client.post("/api/foundry/datasets/ds_nope/ingest-token").status_code == 404
    )
