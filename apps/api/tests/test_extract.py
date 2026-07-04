"""Doc entity-extraction normalisation — slug/id, dedup, link resolution."""

from __future__ import annotations

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
