"""POST /api/evidence/capture/replay-window — the flagship capture.

The competitor case in one sentence: God's Eye View can serialize a camera, a
layer set and one tracked target into a share URL, and cannot answer "is this a
different four vessels than last Tuesday" because it never held last Tuesday.
We hold it. Once that answer exists it should leave the building as something a
skeptic can re-check rather than as a screenshot.

Two properties this test exists to hold:

  * the diff is computed from OUR archive, never accepted from the caller. A
    notary for whatever the client typed is not evidence.
  * the artifact verifies. Canonical JSON with sorted keys, SHA-256 addressed,
    so the same window over the same archive is the same hash and
    GET /api/evidence/{sha}/verify answers to someone who does not trust us.
"""

from __future__ import annotations

import json

import pytest

from app import history


@pytest.fixture()
def _archive(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """A scratch position archive with a vessel that leaves and one that arrives."""
    monkeypatch.setattr(history, "_ROOTS", [str(tmp_path)], raising=False)
    history.reset_for_tests() if hasattr(history, "reset_for_tests") else None
    yield tmp_path


def _post(client, **over):
    body = {
        "lamin": 50.0, "lomin": -1.0, "lamax": 52.0, "lomax": 1.0,
        "at_a": 1_788_000_000.0, "at_b": 1_788_003_600.0,
        "window_sec": 600,
    }
    body.update(over)
    return client.post("/api/evidence/capture/replay-window", json=body)


def test_it_captures_a_verifiable_artifact(client) -> None:
    r = _post(client)
    assert r.status_code == 200, r.text
    obj = r.json()
    props = obj["props"]

    sha = props["sha256"]
    assert len(sha) == 64

    # The window is on the object, so the artifact says what it is a window OF.
    assert props["bbox"] == [-1.0, 50.0, 1.0, 52.0]
    assert props["at_a"] == 1_788_000_000.0
    assert props["window_sec"] == 600
    assert props["capture_method"] == "replay_window"
    assert set(props["counts"]) == {"arrived", "departed", "stayed"}

    # And it re-verifies against the stored bytes.
    v = client.get(f"/api/evidence/{sha}/verify")
    assert v.status_code == 200, v.text
    assert v.json()["ok"] is True, v.text


def test_the_diff_is_ours_not_the_callers(client) -> None:
    """A caller cannot smuggle a diff in. The field is not on the request model,
    so an attempt to supply one is ignored rather than notarized."""
    r = _post(client, diff={"arrived": ["vessel:LIES"], "departed": [], "stayed": []})
    assert r.status_code == 200, r.text
    props = r.json()["props"]
    assert "vessel:LIES" not in json.dumps(props["diff"])


def test_the_same_window_is_the_same_hash(client) -> None:
    """Canonical JSON: re-freezing an unchanged window must not mint a second
    artifact with a different id, or the custody chain forks for no reason."""
    a = _post(client).json()["props"]["sha256"]
    b = _post(client).json()["props"]["sha256"]
    assert a == b


def test_a_different_window_is_a_different_hash(client) -> None:
    a = _post(client).json()["props"]["sha256"]
    b = _post(client, at_a=1_787_000_000.0).json()["props"]["sha256"]
    assert a != b


def test_counts_come_from_the_diff_not_from_the_capped_lists(monkeypatch) -> None:
    """The defect this test exists for: window_diff caps its id arrays at
    `limit` while its own `counts` stay honest. Measuring the arrays produced an
    exhibit that said "500 stayed" about a window where 979 did — wrong in a way
    that looks precise, which is the worst kind for evidence."""
    import anyio

    from app.intel import evidence as ev
    from app.keys import UserCtx

    capped = {
        "counts": {"arrived": 45, "departed": 66, "stayed": 979},
        "arrived": [{"id": f"vessel:{i}"} for i in range(45)],
        "departed": [{"id": f"vessel:d{i}"} for i in range(66)],
        "stayed": [{"id": f"vessel:s{i}"} for i in range(500)],  # capped
    }

    async def run():
        return await ev.capture_replay_window(
            UserCtx(user_id="local", token=None),
            bbox=(-1.0, 50.0, 1.0, 52.0),
            at_a=1.0, at_b=2.0, window_sec=600, kind="vessel", diff=capped,
        )

    obj = anyio.run(run)
    assert obj.props["counts"]["stayed"] == 979, obj.props["counts"]
    assert obj.props["truncated"]["stayed"] is True
    assert obj.props["truncated"]["arrived"] is False


def test_the_bbox_is_bounded(client) -> None:
    assert _post(client, lamin=-999).status_code == 422
    assert _post(client, window_sec=99_999).status_code == 422
