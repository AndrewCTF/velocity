"""Entity-resolution merge REVIEW queue — the scored candidates an operator
decides from the Inbox (`intel/resolve.py::list_candidates`/`decide`, and the
`/api/resolve/candidates` router).

Unit layer mirrors ``test_resolve.py``'s tmp-db fixture; the route layer drives
the same scenario through a keyless ``TestClient`` to prove the HTTP surface,
the ontology ``same_as`` write, and the audit trail.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.intel import resolve

# ── unit layer ───────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _temp_db(tmp_path):
    resolve.override_db_path(str(tmp_path / "resolve_review_test.db"))
    yield
    resolve.override_db_path(None)


def _seed_collision() -> tuple[str, str]:
    """Two independently-minted vessels that later collide.

    ``name`` is itself a (weak) identifier in ``_PRIORITY``, so giving both
    vessels the SAME name would auto-alias them together via the name — not
    the collision this is meant to exercise. Two DIFFERENT names keep
    ``vessel:111`` and ``vessel:222`` genuinely distinct canonicals; a third
    observation then presents mmsi=111 (already vessel:111) together with
    callsign=XYZ (already vessel:222) — two present ids pointing at two
    different canonicals, exactly the ``multiple_canonicals`` collision
    ``resolve()`` records and never auto-merges. Returns (winner, loser) in
    the order the review queue stores them (``sorted`` puts vessel:111 first).
    """
    resolve.resolve("vessel", {"mmsi": "111", "name": "Alpha"})
    resolve.resolve("vessel", {"mmsi": "222", "callsign": "XYZ", "name": "Bravo"})
    resolve.resolve("vessel", {"mmsi": "111", "callsign": "XYZ"})
    return "vessel:111", "vessel:222"


def test_collision_records_one_scored_open_candidate():
    winner, loser = _seed_collision()
    candidates = resolve.list_candidates(status="open")
    assert len(candidates) == 1
    c = candidates[0]
    assert {c["id_a"], c["id_b"]} == {winner, loser}
    assert c["reason"] == "multiple_canonicals"
    assert c["status"] == "open"
    # multiple_canonicals base weight alone is 0.7; the name bonus is >= 0.
    assert 0.7 <= c["score"] <= 1.0
    assert c["a_name"] == "Alpha" and c["b_name"] == "Bravo"
    assert resolve.stats()["open"] == 1
    assert resolve.stats()["approved"] == 0


def test_decide_approve_merges_the_loser_into_the_winner():
    winner, loser = _seed_collision()
    result = resolve.decide(winner, loser, "approve", "op-1")
    assert result["status"] == "approved"
    # The loser's mmsi/callsign now resolve to the winner's canonical id.
    assert resolve.canonical_of(loser) == winner
    assert resolve.canonical_of("vessel:222") == winner
    # The candidate itself is no longer open.
    assert resolve.list_candidates(status="open") == []
    assert resolve.stats()["approved"] == 1


def test_decide_reject_marks_rejected_and_merges_nothing():
    winner, loser = _seed_collision()
    result = resolve.decide(winner, loser, "reject", "op-1")
    assert result["status"] == "rejected"
    # Nothing repointed: the loser still resolves to itself.
    assert resolve.canonical_of(loser) == loser
    assert resolve.list_candidates(status="open") == []
    rejected = resolve.list_candidates(status="rejected")
    assert len(rejected) == 1 and rejected[0]["status"] == "rejected"
    assert resolve.stats()["rejected"] == 1


def test_decide_unknown_pair_raises_key_error():
    with pytest.raises(KeyError):
        resolve.decide("vessel:1", "vessel:2", "approve", "op-1")


def test_resolve_still_never_auto_merges_on_a_collision():
    """Pins the module's cardinal rule even through the new scoring path."""
    winner, loser = _seed_collision()
    assert resolve.canonical_of(loser) != winner  # not merged by resolve() alone


# ── route layer (keyless TestClient) ────────────────────────────────────────


def test_list_route_returns_the_open_candidate(client: TestClient):
    winner, loser = _seed_collision()
    r = client.get("/api/resolve/candidates?status=open")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert {body[0]["id_a"], body[0]["id_b"]} == {winner, loser}


def test_limit_zero_is_422(client: TestClient):
    assert client.get("/api/resolve/candidates?limit=0").status_code == 422


def test_approve_route_merges_links_ontology_and_audits(client: TestClient):
    winner, loser = _seed_collision()
    r = client.post(f"/api/resolve/candidates/{winner}/{loser}/approve")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "approved"
    assert body["ontology"] == "linked same_as in the ontology"
    assert resolve.canonical_of(loser) == winner

    around = client.get(f"/api/ontology/search-around/{winner}?depth=1")
    assert around.status_code == 200
    links = around.json()["links"]
    assert any(lk["rel"] == "same_as" and lk["dst"] == loser for lk in links)

    audit_rows = client.get("/api/audit").json()
    actions = [row["action"] for row in audit_rows]
    assert "resolve.approve" in actions


def test_reject_route_marks_rejected_and_merges_nothing(client: TestClient):
    winner, loser = _seed_collision()
    r = client.post(f"/api/resolve/candidates/{winner}/{loser}/reject")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "rejected"
    assert resolve.canonical_of(loser) == loser
    assert client.get("/api/resolve/candidates?status=open").json() == []
