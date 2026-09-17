"""Citations as a hard contract: a brief that cannot be traced is withheld.

Two surfaces, one rule. ``routes/ai_selection.py`` already refused prose that
cited an id it was never given; it SERVED prose that cited nothing at all,
flagged ``grounded: false``, on the reasoning that unsourced prose is weaker
rather than false. W4 (2026-09-17) revokes that half: the flag was a field in a
JSON body, the prose was a paragraph on a watch floor, and nothing downstream
declined to render it. ``tests/test_selection_grounding.py`` carried the old
decision and now carries this one.

``intel/country_profile.py`` had no check at all — its events had no ids, so
there was nothing for a model to cite and nothing to check a citation against.
It now stamps ``event:<sha8>`` on each event, asks for citations, and withholds
the brief if the model cites an event that was never in the data.

Both are keyless; ``llm.chat`` is mocked, so nothing here touches a model.
"""

from __future__ import annotations

import asyncio

import pytest

from app import llm
from app import upstream as upstream_mod
from app.intel import country_profile


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
        _inner.system = messages[0]["content"]  # type: ignore[attr-defined]
        _inner.user = messages[1]["content"]  # type: ignore[attr-defined]
        return llm.LlmResult(text=text, model="model.gguf", backend="llamacpp")

    return _inner


# ── the selection brief ──────────────────────────────────────────────────────


def _brief(client, monkeypatch, text: str) -> dict:
    monkeypatch.setattr(llm, "chat", _chat_returning(text))
    r = client.post(
        "/api/ai/selection/brief",
        json={"kind": "aircraft", "id": "aircraft:a1b2c3", "props": {"callsign": "UAL123"}},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_an_uncited_selection_brief_is_withheld(client, monkeypatch: pytest.MonkeyPatch) -> None:
    body = _brief(client, monkeypatch, "Nothing anomalous; routine transit.")
    assert body["ok"] is False
    assert body["withheld"] == "uncited"
    # The prose itself never reaches the client: a claim nobody can trace is
    # not a weak finding, it is not a finding.
    assert "text" not in body
    assert "trace" in body["detail"]


def test_a_cited_selection_brief_is_still_served(client, monkeypatch: pytest.MonkeyPatch) -> None:
    body = _brief(client, monkeypatch, "Level at FL350 [aircraft:a1b2c3].")
    assert body["ok"] is True
    assert body["grounded"] is True
    assert body["text"].startswith("Level at FL350")


def test_the_fabricated_case_is_still_its_own_verdict(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two failures, two names. An operator who sees ``uncited`` knows the model
    said nothing checkable; one who sees ``unknown-citations`` knows it invented
    a provenance trail, which is a different and worse thing."""
    body = _brief(client, monkeypatch, "Shadowing [vessel:987654321].")
    assert body["ok"] is False
    assert body["withheld"] == "unknown-citations"


def test_the_gate_can_be_switched_off_by_an_operator(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``llm_require_citations`` defaults ON. A deployment that wants the old
    flag-and-serve behaviour sets it off; the setting is read through
    ``getattr`` so a Settings that predates it still defaults to the strict
    side."""
    from app.routes import ai_selection as sel

    class _S:
        llm_require_citations = False

    monkeypatch.setattr(sel, "get_settings", lambda: _S())
    body = _brief(client, monkeypatch, "Nothing anomalous; routine transit.")
    assert body["ok"] is True
    assert body["grounded"] is False


# ── the country brief ────────────────────────────────────────────────────────

_SECURITY = {
    "counts": {"conflict": 2},
    "events": [
        {"label": "clash reported", "date": "2026-09-10", "url": "https://example.com/a"},
        {"label": "border incident", "date": "2026-09-11", "url": None},
    ],
    "notes": [],
}


def _country(monkeypatch, text: str) -> dict:
    fake = _chat_returning(text)
    monkeypatch.setattr(llm, "chat", fake)
    upstream_mod.cache._data.clear()  # noqa: SLF001
    out = asyncio.run(country_profile.country_brief("UKR", "Ukraine", None, None, _SECURITY))
    out["_system"] = getattr(fake, "system", "")
    out["_user"] = getattr(fake, "user", "")
    return out


def test_the_country_brief_events_carry_checkable_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    out = _country(monkeypatch, "Quiet week.")
    assert '"id": "event:' in out["_user"] or '"id":"event:' in out["_user"]
    # And the grounding contract is stated, with the style rider last.
    assert llm.CITATION_CONTRACT in out["_system"]
    assert out["_system"].rstrip().endswith(llm.PROSE_STYLE)


def test_the_event_id_is_stable_for_the_same_event() -> None:
    e = {"label": "clash reported", "date": "2026-09-10"}
    assert country_profile._event_id(e) == country_profile._event_id(dict(reversed(list(e.items()))))
    assert country_profile._event_id(e) != country_profile._event_id({**e, "date": "2026-09-11"})


def test_a_country_brief_citing_a_fabricated_event_is_withheld(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out = _country(
        monkeypatch,
        "## Overview\nEscalation along the border [event:deadbeef].",
    )
    assert out["ok"] is False
    assert out["withheld"] == "unknown-citations"
    assert out["unknown_citations"] == ["event:deadbeef"]
    assert "markdown" not in out


def test_a_country_brief_citing_a_real_event_is_served(monkeypatch: pytest.MonkeyPatch) -> None:
    real = country_profile._event_id(_SECURITY["events"][0])
    out = _country(monkeypatch, f"## Overview\nClash reported [{real}].")
    assert out["ok"] is True, out
    assert real in out["markdown"]
    # The deterministic Sources footer still rides along, built from the data
    # and never from the model.
    assert "## Sources" in out["markdown"]


def test_a_country_brief_may_cite_its_own_subject(monkeypatch: pytest.MonkeyPatch) -> None:
    out = _country(monkeypatch, "## Overview\nIndicators are mixed [country:UKR].")
    assert out["ok"] is True, out
