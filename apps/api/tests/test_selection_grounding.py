"""The grounding gate on POST /api/ai/selection/brief.

`llm.is_grounded` was written with a docstring that says "the caller can then
decline to render rather than shipping prose that points at nothing", and until
2026-08-30 it had no caller anywhere in the repo — while the route's own comment
claimed the bracket form was "verified against the real ids below". A model that
emitted [vessel:987654321] for a vessel that does not exist reached the analyst
looking exactly like provenance.

Two failures, named differently on purpose, and both pinned here:

  cited an id that was never in the evidence -> WITHHELD "unknown-citations"
  cited nothing at all                       -> WITHHELD "uncited"

The second line said ``SERVED, grounded: false`` until 2026-09-17 (W4). The
reasoning behind it — unsourced prose is weaker, not false, and refusing it
would delete a useful brief over a formatting habit — was sound and the outcome
was still wrong: ``grounded: false`` was a field in a JSON body, the prose was a
paragraph on a watch floor, and no surface downstream declined to render it. A
claim an analyst cannot trace is not a weak finding, it is not a finding. The
distinction between the two failures is kept in the ``withheld`` reason, because
"said nothing checkable" and "invented a provenance trail" are different things
for the person reading the refusal.

``Settings.llm_require_citations`` (default True) is the operator's way back to
the old behaviour; ``tests/test_citations_hard.py`` pins both sides of it.

Keyless via the shared ``client`` fixture; ``llm.chat`` is mocked so no network
or model is touched.
"""

from __future__ import annotations

import pytest

from app import llm
from app import upstream as upstream_mod


@pytest.fixture(autouse=True)
def _isolate(monkeypatch: pytest.MonkeyPatch):
    llm.set_selection_enabled(True)
    upstream_mod.cache._data.clear()  # noqa: SLF001
    upstream_mod.cache._locks.clear()  # noqa: SLF001
    yield
    llm.set_selection_enabled(None)
    upstream_mod.cache._data.clear()  # noqa: SLF001
    upstream_mod.cache._locks.clear()  # noqa: SLF001


def _chat_returning(text: str):
    async def _inner(messages, *, tier="fast", max_tokens=1024, label="", **kw):  # noqa: ANN001, ANN003
        return llm.LlmResult(text=text, model="model.gguf", backend="llamacpp")

    return _inner


def _brief(client, monkeypatch, text: str, *, kind="aircraft", eid="aircraft:a1b2c3", props=None):
    monkeypatch.setattr(llm, "chat", _chat_returning(text))
    r = client.post(
        "/api/ai/selection/brief",
        json={"kind": kind, "id": eid, "props": props or {"callsign": "UAL123"}},
    )
    assert r.status_code == 200, r.text
    return r.json()


# ── the dangerous failure: a fabricated provenance trail ─────────────────────


def test_a_fabricated_id_is_withheld(client, monkeypatch: pytest.MonkeyPatch) -> None:
    body = _brief(
        client, monkeypatch,
        "Routine transit [aircraft:a1b2c3], shadowing [vessel:987654321].",
    )
    assert body["ok"] is False
    assert body["withheld"] == "unknown-citations"
    assert body["unknown_citations"] == ["vessel:987654321"]
    # The reason names the id, so an operator can see WHAT was wrong rather than
    # just that something was.
    assert "vessel:987654321" in body["detail"]
    # And the prose itself never reaches the client.
    assert "text" not in body


def test_the_withheld_reason_does_not_dump_every_id(client, monkeypatch: pytest.MonkeyPatch) -> None:
    cited = " ".join(f"[vessel:{i}]" for i in range(10))
    body = _brief(client, monkeypatch, f"Contacts {cited}.")
    assert body["ok"] is False
    assert len(body["unknown_citations"]) == 8  # capped
    assert "and others" in body["detail"]


# ── the other failure: nothing checkable was said at all ─────────────────────


def test_prose_citing_nothing_is_withheld_as_uncited(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Superseded ``test_prose_citing_nothing_is_served_and_flagged`` on
    2026-09-17 — see this module's docstring for why the earlier decision was
    revoked rather than merely changed."""
    body = _brief(client, monkeypatch, "Nothing anomalous; routine transit.")
    assert body["ok"] is False
    assert body["withheld"] == "uncited"
    assert "text" not in body


# ── the good path ────────────────────────────────────────────────────────────


def test_citing_the_subject_is_grounded(client, monkeypatch: pytest.MonkeyPatch) -> None:
    body = _brief(client, monkeypatch, "Level at FL350 [aircraft:a1b2c3].")
    assert body["ok"] is True
    assert body["grounded"] is True


def test_the_subject_counts_in_either_id_form(client, monkeypatch: pytest.MonkeyPatch) -> None:
    """The globe sends "<kind>:<raw>"; some callers send a bare id. A brief that
    cites its own subject must not read as a fabrication over that difference."""
    body = _brief(client, monkeypatch, "Level at FL350 [aircraft:a1b2c3].", eid="a1b2c3")
    assert body["ok"] is True, body
    assert body["grounded"] is True


def test_an_id_present_in_the_props_is_allowed(client, monkeypatch: pytest.MonkeyPatch) -> None:
    """The allowed set is the evidence that went into the prompt, not just the
    subject — an id the model was shown in the props is a real citation."""
    body = _brief(
        client, monkeypatch,
        "Associated with [incident:xyz-9].",
        props={"callsign": "UAL123", "incident": "incident:xyz-9"},
    )
    assert body["ok"] is True, body
    assert body["grounded"] is True


# ── the helper itself ────────────────────────────────────────────────────────


def test_unknown_citations_is_ordered_and_deduplicated() -> None:
    got = llm.unknown_citations(
        "[vessel:9] then [aircraft:1] then [vessel:9] again", ["aircraft:1"]
    )
    assert got == ["vessel:9"]


def test_unknown_citations_is_empty_when_everything_checks_out() -> None:
    assert llm.unknown_citations("[aircraft:1] [vessel:2]", ["aircraft:1", "vessel:2"]) == []
