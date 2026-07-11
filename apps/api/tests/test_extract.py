"""Doc entity-extraction normalisation — slug/id, dedup, link resolution.

Also covers the ``POST /api/extract`` auth contract: it is the only LLM/
ontology route that used to hard-require a signed-in Supabase user
(``current_principal`` → ``keys.current_user`` → 401) while every sibling
route degrades to the shared ``local`` identity on a keyless boot. It now
uses ``current_principal_or_local`` so a keyless box can extract too — with
Supabase configured the behavior is unchanged (still 401 without a token).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import keys as keys_mod
from app import llm
from app import security as security_mod
from app.config import Settings
from app.routes.extract import _entity_id, _normalise, _slug


def test_slug() -> None:
    assert _slug("Dar es Salaam!") == "dar-es-salaam"
    assert _slug("  Acme,  Ltd. ") == "acme-ltd"
    assert _slug("") == "x"


def test_entity_id() -> None:
    assert _entity_id("Organization", "Acme Ltd") == "ext:organization:acme-ltd"
    assert _entity_id("Person", "John Doe") == "ext:person:john-doe"
    assert _entity_id("Weird", "X") == "ext:other:x"  # unknown type → other


def test_normalise_dedups_entities_and_links() -> None:
    parsed = {
        "entities": [
            {"type": "Person", "name": "John Doe"},
            {"type": "person", "name": "john doe"},  # dup (same type+slug)
            {"type": "Organization", "name": "Acme"},
        ],
        "relationships": [
            {"source": "John Doe", "relation": "member_of", "target": "Acme"},
            {"source": "John Doe", "relation": "member_of", "target": "Acme"},  # dup
            {"source": "John Doe", "relation": "knows", "target": "Nobody"},  # unresolved
        ],
    }
    ents, links = _normalise(parsed)
    ids = {e.id for e in ents}
    assert ids == {"ext:person:john-doe", "ext:organization:acme"}
    assert len(ents) == 2  # deduped
    assert len(links) == 1  # dup removed, unresolved-target dropped
    assert links[0].src == "ext:person:john-doe"
    assert links[0].dst == "ext:organization:acme"
    assert links[0].rel == "member_of"


def test_normalise_tolerates_garbage() -> None:
    ents, links = _normalise({"entities": ["notadict", {"name": ""}], "relationships": ["x"]})
    assert ents == []
    assert links == []


# ── auth contract: keyless degrades to "local", Supabase-configured still 401s ──


async def _fake_chat_json(messages, **kwargs):  # noqa: ANN001, ANN003
    parsed = {
        "entities": [{"type": "Person", "name": "Jane Doe", "attributes": {}}],
        "relationships": [],
    }
    return parsed, llm.LlmResult(text="{}", model="test-model", backend="ollama")


def test_extract_degrades_keyless_to_local_identity(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Default test settings carry no Supabase config → current_principal_or_local
    # must serve the "local" identity instead of a dead 401, same contract as
    # every other ontology/LLM route on a keyless boot.
    monkeypatch.setattr(llm, "chat_json", _fake_chat_json)
    r = client.post(
        "/api/extract",
        json={"text": "Jane Doe works at Acme.", "commit": False},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["committed"] is False
    assert any(e["name"] == "Jane Doe" for e in body["entities"])


def test_extract_commits_keyless_to_local_ontology(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(llm, "chat_json", _fake_chat_json)
    r = client.post(
        "/api/extract",
        json={"text": "Jane Doe works at Acme.", "commit": True},
    )
    assert r.status_code == 200
    assert r.json()["committed"] is True


def test_extract_401_without_token_when_supabase_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Mirrors tests/test_alert_rules.py::_configure_supabase — patch the
    # get_settings each involved module actually calls (the process-wide
    # get_settings() lru_cache is already memoized to the hermetic keyless
    # default by the time this test runs).
    fake = Settings(supabase_url="http://x", supabase_anon_key="anon")
    monkeypatch.setattr(security_mod, "get_settings", lambda: fake)
    monkeypatch.setattr(keys_mod, "get_settings", lambda: fake)
    monkeypatch.setattr(llm, "chat_json", _fake_chat_json)
    r = client.post(
        "/api/extract",
        json={"text": "Jane Doe works at Acme.", "commit": False},
    )
    assert r.status_code == 401
