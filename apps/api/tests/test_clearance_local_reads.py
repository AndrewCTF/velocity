"""Guard: the classification stored on ontology rows actually gates a READ.

Until 2026-09-17 ``intel/ontology_local.py`` wrote ``classification`` and
``compartments`` on every object and link and then never read them back — every
SELECT was ``WHERE user_id=?`` alone. A level-4 object was therefore visible to
a clearance-0 caller on any deployment, which makes the whole Gotham ACL spine
decorative. ``get_registry(ctx, settings, principal=p)`` plus the one predicate
``intel/ontology.visible_to`` is the fix; these are its guards.

Four things are pinned here:

1. **The predicate reaches every read path.** ``get`` / ``search`` /
   ``list_by_kind`` / ``traverse`` / ``path_between`` / ``get_assertions`` all
   answer nothing for a clearance-0 principal and everything for a cleared one,
   and a compartment the reader does not hold hides a row whose LEVEL they
   could read.
2. **The write side is not a way around the read side.** A caller may not
   classify above their own clearance, and may not land a write on a row they
   cannot see (``props`` is a wholesale replace, so an ungated write destroys
   or declassifies).
3. **Anti-rot**: every GET on the ontology / situations / evidence / maps
   routers resolves ``current_principal_or_local``, so a new read route cannot
   quietly reopen the hole.
4. ``situation`` is a first-class ``ObjectKind`` and appears in the schema.

``principal=None`` (the internal writers: promotion, watch officer, evidence
capture, Foundry binding, workflow blocks) stays unfiltered, and a keyless box
resolves a clearance-0 ``Principal`` over rows that are all level 0 — which is
why ``test_ontology_local.py::test_all_ontology_routes_serve_data_keyless``
still passes.
"""

from __future__ import annotations

import asyncio
import itertools
import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.intel.ontology import Link, Object, get_registry
from app.intel.ontology_local import SqliteRegistry
from app.keys import UserCtx
from app.security import Principal, current_principal_or_local

_S = Settings(supabase_url="")
_USER = "local"

# The classified row every read test looks for, and the level-0 neighbour it is
# linked to (the link itself is level 0 — what must hide it is its ENDPOINT).
_SECRET = "incident:ts-only"
_OPEN = "aircraft:abc123"


def _reg(principal: Principal | None) -> SqliteRegistry:
    """A registry for the SAME user as the writer — otherwise a test would be
    proving user scoping (which already worked) instead of clearance."""
    reg = get_registry(UserCtx(_USER, ""), _S, principal=principal)
    assert isinstance(reg, SqliteRegistry)
    return reg


def _p(clearance: int, *compartments: str) -> Principal:
    return Principal(
        user_id=_USER, token="", clearance=clearance, compartments=compartments
    )


async def _seed(*, compartments: list[str] | None = None) -> None:
    """One level-4 object, one level-0 object, and a level-0 link between them.

    Written with NO principal — the internal, unfiltered path every background
    writer uses.
    """
    writer = _reg(None)
    await writer.upsert(
        Object(
            id=_SECRET,
            props={"narrative": "the classified fact", "kind": "incident"},
            classification=4,
            compartments=compartments or [],
        )
    )
    await writer.upsert(Object(id=_OPEN, props={"callsign": "OPEN1"}))
    await writer.link(Link(src=_OPEN, dst=_SECRET, rel="evidence_of"))


# ── 1. the read paths ─────────────────────────────────────────────────────────


def test_a_level_four_object_is_invisible_to_a_clearance_zero_principal() -> None:
    async def run() -> None:
        await _seed()
        blind, cleared = _reg(_p(0)), _reg(_p(4))

        # get: out of clearance reads exactly like absent.
        assert await blind.get(_SECRET) is None
        assert (await cleared.get(_SECRET)) is not None

        # search: the FTS hit is dropped, not merely reordered.
        assert [o.id for o in await blind.search("classified")] == []
        assert [o.id for o in await cleared.search("classified")] == [_SECRET]

        # list_by_kind (props->>kind, the situations/maps/evidence list path).
        assert [o.id for o in await blind.list_by_kind("incident")] == []
        assert [o.id for o in await cleared.list_by_kind("incident")] == [_SECRET]

        # get_assertions inherits the parent object's classification.
        assert await blind.get_assertions(_SECRET) == []
        assert len(await cleared.get_assertions(_SECRET)) >= 1

    asyncio.run(run())


def test_traverse_and_path_do_not_leak_the_hidden_id_as_a_stub() -> None:
    """_GraphWalk resolves an endpoint with ``get`` and falls back to a DERIVED
    STUB when that returns None. So filtering ``get`` alone would turn a hidden
    object into ``Object(id="incident:ts-only")`` — the id, which is the fact.
    The filter therefore lives in ``_links_touching``, on the endpoints' own
    columns, which covers traverse AND path_between."""

    async def run() -> None:
        await _seed()
        blind, cleared = _reg(_p(0)), _reg(_p(4))

        around = await blind.traverse(_OPEN, depth=2)
        assert around.links == []
        assert [o.id for o in around.objects] == [_OPEN]

        around_ok = await cleared.traverse(_OPEN, depth=2)
        assert {o.id for o in around_ok.objects} == {_OPEN, _SECRET}
        assert len(around_ok.links) == 1

        assert (await blind.path_between(_OPEN, _SECRET)).found is False
        assert (await cleared.path_between(_OPEN, _SECRET)).found is True

    asyncio.run(run())


def test_a_compartment_the_reader_does_not_hold_hides_the_row() -> None:
    """Level is necessary, not sufficient: compartments are POSITIVE grants."""

    async def run() -> None:
        await _seed(compartments=["FVEY"])
        assert await _reg(_p(4)).get(_SECRET) is None  # cleared, wrong compartment
        assert await _reg(_p(4, "FVEY")).get(_SECRET) is not None
        assert [o.id for o in await _reg(_p(4)).search("classified")] == []
        assert await _reg(_p(4)).get_assertions(_SECRET) == []

    asyncio.run(run())


def test_no_principal_is_the_unfiltered_internal_path() -> None:
    """Promotion, the watch officer, evidence capture and the workflow blocks
    build a registry with no principal and must keep seeing everything —
    filtering is an HTTP-edge concern."""

    async def run() -> None:
        await _seed(compartments=["FVEY"])
        reg = _reg(None)
        assert (await reg.get(_SECRET)) is not None
        assert [o.id for o in await reg.search("classified")] == [_SECRET]
        assert len(await reg.get_assertions(_SECRET)) >= 1
        assert len((await reg.traverse(_OPEN, depth=1)).links) == 1

    asyncio.run(run())


# ── 2. the write ceiling ──────────────────────────────────────────────────────


def test_keyless_post_above_your_clearance_is_refused(client: TestClient) -> None:
    """A keyless box resolves a clearance-0 local principal, so classifying a new
    object SECRET is a 403 — otherwise the write side launders the read side
    (post at 4, read your own row back)."""
    r = client.post(
        "/api/ontology/object",
        json={"id": "investigation:x", "props": {"n": 1}, "classification": 3},
    )
    assert r.status_code == 403, r.text
    assert "clearance" in r.json()["detail"]

    # A compartment the caller does not hold is refused on the same gate.
    r = client.post(
        "/api/ontology/object",
        json={"id": "investigation:x", "props": {}, "compartments": ["FVEY"]},
    )
    assert r.status_code == 403, r.text

    # Level 0 with no compartments is the keyless norm and still works.
    assert (
        client.post(
            "/api/ontology/object", json={"id": "investigation:x", "props": {"n": 1}}
        ).status_code
        == 200
    )


def test_a_hidden_row_cannot_be_overwritten_or_merged_into(
    client: TestClient,
) -> None:
    """``upsert`` replaces props WHOLESALE and ``promote``'s ``assert_props``
    merges and RETURNS the merged object. Both are reads-by-write onto a row the
    caller cannot see, so both refuse."""
    asyncio.run(_seed())

    r = client.post(
        "/api/ontology/object", json={"id": _SECRET, "props": {"narrative": "mine"}}
    )
    assert r.status_code == 403, r.text

    r = client.post(
        "/api/ontology/promote", json={"id": _SECRET, "props": {"x": 1}}
    )
    assert r.status_code == 403, r.text

    # And the row is intact — the refusal is before the write, not after it.
    obj = asyncio.run(_reg(None).get(_SECRET))
    assert obj is not None and obj.props["narrative"] == "the classified fact"


def test_the_classified_object_is_a_404_over_http_on_a_keyless_box(
    client: TestClient,
) -> None:
    asyncio.run(_seed())
    assert client.get(f"/api/ontology/object/{_SECRET}").status_code == 404
    assert client.get(f"/api/ontology/object/{_OPEN}").status_code == 200
    assert client.get("/api/ontology/search?q=classified").json() == []
    assert client.get(f"/api/ontology/assertions/{_SECRET}").json() == []
    around = client.get(f"/api/ontology/search-around/{_OPEN}").json()
    assert around["links"] == []
    assert [o["id"] for o in around["objects"]] == [_OPEN]


# ── 3. anti-rot: the dependency cannot fall off a read route ──────────────────


def _resolves_principal(route: object) -> bool:
    """Does this route resolve ``current_principal_or_local`` anywhere in its
    dependency tree?

    Walks ``route.dependant``, NOT ``route.dependencies``: the gate here is a
    handler PARAMETER default (``p: Principal = Depends(...)``), which never
    appears in the router-level ``dependencies`` list that
    ``test_security_hardening.py``'s operator walk inspects.
    """
    seen: list = [getattr(route, "dependant", None)]
    while seen:
        dep = seen.pop()
        if dep is None:
            continue
        if getattr(getattr(dep, "call", None), "__name__", "") == (
            "current_principal_or_local"
        ):
            return True
        seen.extend(getattr(dep, "dependencies", []))
    return False


def test_every_ontology_read_route_resolves_the_principal() -> None:
    """Anti-rot. A GET added to one of these four routers without the principal
    is a read that ignores classification again.

    Walks the ROUTERS, not ``app.routes``: ``create_app`` registers each router
    through an ``_IncludedRouter`` wrapper that does not expose leaf paths, so
    an app-level walk matches nothing and passes vacuously (the reasoning is
    pinned in apps/api/CLAUDE.md and test_security_hardening.py).
    """
    from app.routes import evidence as evidence_routes  # noqa: PLC0415
    from app.routes import maps as maps_routes  # noqa: PLC0415
    from app.routes import ontology as ontology_routes  # noqa: PLC0415
    from app.routes import situations as situations_routes  # noqa: PLC0415

    # /api/ontology/schema is static, per-deployment and identical for every
    # caller. It has never had an auth dependency; giving it one would 401 it on
    # a Supabase deployment, so it is exempt BY DECISION, not by oversight.
    exempt = {"/api/ontology/schema"}
    gated = 0
    for router in (
        ontology_routes.router,
        situations_routes.router,
        evidence_routes.router,
        maps_routes.router,
    ):
        for route in router.routes:
            if "GET" not in (getattr(route, "methods", None) or set()):
                continue  # POST/DELETE handlers and the /ws/cop WebSocket
            want = route.path not in exempt
            assert _resolves_principal(route) == want, route.path
            gated += want
    # A walk that matched nothing would pass vacuously and guard nothing.
    assert gated >= 10, gated


def test_the_local_principal_is_least_privilege() -> None:
    """What makes the keyless box keep working: the local identity is a real
    Principal at clearance 0 with no compartments, and every row a keyless box
    has ever written is level 0."""
    from fastapi import Request  # noqa: PLC0415

    req = Request({"type": "http", "headers": [], "method": "GET", "path": "/"})
    p = asyncio.run(
        current_principal_or_local(req, ctx=UserCtx(user_id=_USER, token=""))
    )
    assert (p.clearance, p.compartments) == (0, ())


# ── 4. situation is a first-class kind ────────────────────────────────────────


def test_situation_is_a_known_kind_and_is_declared_in_the_schema(
    client: TestClient,
) -> None:
    from app.intel.ontology import _KNOWN_KINDS, kind_of  # noqa: PLC0415

    assert "situation" in _KNOWN_KINDS
    assert kind_of("situation:abc123") == "situation"

    body = client.get("/api/ontology/schema").json()
    assert "situation" in body["kinds"]
    assert body["kinds"]["situation"]["severity"] == "str"


def test_a_new_situation_gets_the_kind_column_and_still_lists(
    client: TestClient,
) -> None:
    """``normalised()`` now stamps the kind COLUMN from the ``situation:`` id
    prefix, while ``props.kind`` — which is what ``list_by_kind`` and
    ``_from_object`` read — is unchanged, so old rows (kind column "object")
    and new ones both list."""
    r = client.post("/api/situations", json={"name": "Strait watch"})
    assert r.status_code == 201, r.text
    sit_id = r.json()["id"]

    stored = asyncio.run(_reg(None).get(sit_id))
    assert stored is not None
    assert stored.kind == "situation"
    assert stored.props["kind"] == "situation"

    assert [s["id"] for s in client.get("/api/situations").json()] == [sit_id]
    assert client.get(f"/api/situations/{sit_id}").status_code == 200


# ── 5. the write gate on the id-keyed routers (W4-1) ──────────────────────────
# The read filter hides a classified row, but every id-keyed WRITE on the
# situations/maps routers went straight to ``reg.upsert``/``reg.link``/
# ``reg.delete`` with no visibility check, and ``props`` is a wholesale replace:
# a clearance-0 caller could overwrite (and declassify) or delete a level-4
# situation / COP it cannot even read. ``routes/ontology.py`` already had the two
# gates (``_refuse_write_above_clearance`` / ``_refuse_overwrite_of_hidden_row``);
# these pin that the other two routers carry them too.

_HIDDEN_SIT = "situation:classified"
_HIDDEN_MAP = "map:classified"


async def _seed_named_hidden_rows() -> None:
    """One level-4 situation and one level-4 COP, written with NO principal (the
    internal, unfiltered path)."""
    writer = _reg(None)
    await writer.upsert(
        Object(
            id=_HIDDEN_SIT,
            props={
                "kind": "situation",
                "name": "SECRET OP",
                "summary": "classified fact",
            },
            classification=4,
        )
    )
    await writer.upsert(
        Object(
            id=_HIDDEN_MAP,
            props={"kind": "map", "name": "SECRET COP", "state": {}},
            classification=4,
        )
    )


def test_a_hidden_situation_cannot_be_overwritten_or_deleted(client: TestClient) -> None:
    asyncio.run(_seed_named_hidden_rows())

    r = client.post(
        "/api/situations",
        json={"id": _HIDDEN_SIT, "name": "pwned by clearance 0"},
    )
    assert r.status_code == 403, r.text
    assert client.delete(f"/api/situations/{_HIDDEN_SIT}").status_code == 403

    # The refusal is BEFORE the write: level and props survive untouched.
    obj = asyncio.run(_reg(None).get(_HIDDEN_SIT))
    assert obj is not None
    assert obj.classification == 4
    assert obj.props["name"] == "SECRET OP"


def test_a_hidden_situation_cannot_be_linked_to_or_from(client: TestClient) -> None:
    asyncio.run(_seed_named_hidden_rows())
    asyncio.run(_seed())  # level-4 incident:ts-only + its level-0 neighbour

    # Linking FROM a hidden situation writes the edge on src=sit_id.
    r = client.post(f"/api/situations/{_HIDDEN_SIT}/link", json={"dst": _OPEN})
    assert r.status_code == 403, r.text

    # Linking TO a hidden child writes the edge AND ``assert_props``-merges into
    # the dst, so the dst gate has to fire before either write.
    r = client.post("/api/situations/situation:mine/link", json={"dst": _SECRET})
    assert r.status_code == 403, r.text
    assert asyncio.run(_reg(None).traverse("situation:mine", depth=1)).links == []

    obj = asyncio.run(_reg(None).get(_SECRET))
    assert obj is not None and obj.classification == 4


def test_a_hidden_map_cannot_be_overwritten_or_deleted(client: TestClient) -> None:
    asyncio.run(_seed_named_hidden_rows())

    r = client.post("/api/maps", json={"id": _HIDDEN_MAP, "name": "pwned"})
    assert r.status_code == 403, r.text
    assert client.delete(f"/api/maps/{_HIDDEN_MAP}").status_code == 403

    obj = asyncio.run(_reg(None).get(_HIDDEN_MAP))
    assert obj is not None
    assert obj.classification == 4
    assert obj.props["name"] == "SECRET COP"


def test_export_and_coa_answer_like_absence_for_a_hidden_situation(
    client: TestClient,
) -> None:
    """Neither handler writes — so the destructive-write 403 gate does not apply —
    but both are POST-shaped and take a caller id, so pin that they reach nothing
    above the caller's clearance and leave the row untouched (the read filter is
    their gate, and out-of-clearance reads answer like absence, not 403)."""
    asyncio.run(_seed_named_hidden_rows())

    r = client.post(f"/api/situations/{_HIDDEN_SIT}/export", json={"fmt": "json"})
    assert r.status_code == 404, r.text
    assert client.post(f"/api/situations/{_HIDDEN_SIT}/coa/propose").status_code == 404

    obj = asyncio.run(_reg(None).get(_HIDDEN_SIT))
    assert obj is not None and obj.props["name"] == "SECRET OP"


# ── 6. the case export (build_bundle) ─────────────────────────────────────────
# ``build_bundle`` built its OWN registry, unfiltered, so a situation the caller
# CAN read exported every linked child — including a level-4 one they cannot see,
# with its assertion history (a download, not a glance). The bundle now takes the
# caller's principal; ``principal=None`` stays the internal writer path.


def test_a_case_export_omits_a_child_above_the_callers_clearance() -> None:
    from app.intel import case_export as ce  # noqa: PLC0415

    async def run() -> None:
        writer = _reg(None)
        await writer.upsert(
            Object(id="situation:case", props={"kind": "situation", "name": "Case"})
        )
        await _seed()  # level-4 incident:ts-only + its level-0 neighbour
        await writer.link(Link(src="situation:case", dst=_OPEN, rel="evidence_of"))
        await writer.link(Link(src="situation:case", dst=_SECRET, rel="evidence_of"))

        blind = await ce.build_bundle(
            UserCtx(user_id=_USER, token=""), "situation:case", principal=_p(0)
        )
        assert {c["object"]["id"] for c in blind["children"]} == {_OPEN}
        # The hidden row must not arrive by another door either: no link endpoint,
        # no assertion (its props ride in the child entries).
        assert all(_SECRET not in (lk["src"], lk["dst"]) for lk in blind["links"])
        assert "the classified fact" not in json.dumps(blind)

        # A cleared principal gets the child back; so does the internal path.
        cleared = await ce.build_bundle(
            UserCtx(user_id=_USER, token=""), "situation:case", principal=_p(4)
        )
        assert {c["object"]["id"] for c in cleared["children"]} == {_OPEN, _SECRET}
        internal = await ce.build_bundle(UserCtx(user_id=_USER, token=""), "situation:case")
        assert {c["object"]["id"] for c in internal["children"]} == {_OPEN, _SECRET}

    asyncio.run(run())


# ── 7. the evidence locker (list + the two POST reads) ───────────────────────
# ``intel/evidence.py`` built its own registry for reads too, so the route applied
# ``visible_to`` to the rows it got back — AFTER the SQL LIMIT, which is how a
# hidden exhibit ate the page (``limit=1`` returned nothing at all).

_EV_VISIBLE_SHA = "a" * 64
_EV_HIDDEN_SHA = "b" * 64
_EV_VISIBLE = "evidence:" + _EV_VISIBLE_SHA
_EV_HIDDEN = "evidence:" + _EV_HIDDEN_SHA
_EV_CASE = "situation:case"


async def _seed_classified_evidence() -> None:
    """One level-0 exhibit and one level-4 exhibit in the caller's locker."""
    writer = _reg(None)
    await writer.upsert(
        Object(
            id=_EV_VISIBLE,
            props={
                "kind": "evidence",
                "title": "open exhibit",
                "sha256": _EV_VISIBLE_SHA,
            },
        )
    )
    await writer.upsert(
        Object(
            id=_EV_HIDDEN,
            props={
                "kind": "evidence",
                "title": "SECRET EXHIBIT",
                "sha256": _EV_HIDDEN_SHA,
            },
            classification=4,
        )
    )
    await writer.upsert(Object(id=_EV_CASE, props={"kind": "situation", "name": "Case"}))


def test_the_evidence_list_spends_its_page_on_readable_rows(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The clearance clause has to be in the WHERE, not applied after the page:
    post-filtering let ONE hidden exhibit consume ``limit`` and answer an empty
    list to a caller who has readable evidence."""
    from app.intel import ontology_local  # noqa: PLC0415

    # ``created_at`` is second-precision, so two same-second rows tie and the
    # LIMIT-1 assertion would depend on SQLite's tie-break. A fixed clock makes
    # the HIDDEN row unambiguously newest (the pre-fix failure).
    clock = itertools.count()
    monkeypatch.setattr(ontology_local, "_now_iso", lambda: f"2026-09-17T00:00:{next(clock):02d}Z")
    asyncio.run(_seed_classified_evidence())

    rows = client.get("/api/evidence", params={"limit": 1}).json()
    assert [r["id"] for r in rows] == [_EV_VISIBLE]


def test_a_hidden_exhibit_cannot_be_attached_to_a_case(client: TestClient) -> None:
    """A sha the caller cannot read must not be attachable: out of clearance reads
    like absent (404), and no edge is written onto the case file."""
    asyncio.run(_seed_classified_evidence())

    r = client.post(f"/api/evidence/{_EV_HIDDEN_SHA}/attach", json={"situation_id": _EV_CASE})
    assert r.status_code == 404, r.text

    # ... and the level-0 exhibit still attaches (the gate is not blanket).
    assert (
        client.post(
            f"/api/evidence/{_EV_VISIBLE_SHA}/attach", json={"situation_id": _EV_CASE}
        ).status_code
        == 200
    )
    links = asyncio.run(_reg(None).traverse(_EV_CASE, depth=1)).links
    assert [lk.dst for lk in links] == [_EV_VISIBLE]


def test_a_hidden_exhibit_is_not_enumerable_through_the_manifest(
    client: TestClient,
) -> None:
    """The manifest walks a caller-supplied id list; a hidden member must be
    dropped exactly like one that does not exist, or the hash-of-hashes is an
    existence oracle."""
    asyncio.run(_seed_classified_evidence())

    body = client.post(
        "/api/evidence/manifest",
        json={"evidence_ids": [_EV_VISIBLE_SHA, _EV_HIDDEN_SHA]},
    ).json()
    assert [i["id"] for i in body["items"]] == [_EV_VISIBLE]
    assert _EV_HIDDEN_SHA not in json.dumps(body)
    assert "SECRET EXHIBIT" not in json.dumps(body)


# ── 8. the caller-facing OSINT writes that upsert by a derived id ────────────
# /investigate and /recon mint ids straight from the caller's target, and
# countries/{code}/ingest from the country code. ``upsert`` replaces props
# wholesale and rewrites ``classification``, so a level-4 row at one of those ids
# was declassified and destroyed by a clearance-0 caller. Same refusal as
# routes/ontology.py's id-keyed gate.


def test_investigating_a_hidden_root_is_refused_and_leaves_it_intact(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.osint import connectors as C  # noqa: PLC0415

    async def _no_upstream(url: str, ttl: float, **kw: object) -> object:
        return None

    monkeypatch.setattr(C, "fetch_json", _no_upstream)

    async def seed() -> None:
        await _reg(None).upsert(
            Object(
                id="domain:classified.example",
                props={"narrative": "the classified fact", "entity_type": "Domain"},
                classification=4,
            )
        )

    asyncio.run(seed())
    r = client.post("/api/osint/investigate", json={"target": "classified.example"})
    assert r.status_code == 403, r.text
    assert "the classified fact" not in r.text

    obj = asyncio.run(_reg(None).get("domain:classified.example"))
    assert obj is not None and obj.classification == 4
    assert obj.props["narrative"] == "the classified fact"


def test_ingesting_a_country_over_a_hidden_row_is_refused(client: TestClient) -> None:
    from app.keys import current_user  # noqa: PLC0415

    async def seed() -> None:
        await _reg(None).upsert(
            Object(
                id="country:np",
                props={"kind": "country", "name": "SECRET NP"},
                classification=4,
            )
        )

    asyncio.run(seed())
    client.app.dependency_overrides[current_user] = lambda: UserCtx(user_id=_USER, token="")
    try:
        r = client.post("/api/osint/countries/np/ingest")
        assert r.status_code == 403, r.text
        assert "SECRET NP" not in r.text
    finally:
        client.app.dependency_overrides.pop(current_user, None)

    obj = asyncio.run(_reg(None).get("country:np"))
    assert obj is not None and obj.classification == 4
    assert obj.props["name"] == "SECRET NP"


# ── 9. the /ws/cop follow-along room ─────────────────────────────────────────


def test_the_cop_room_reads_the_map_under_the_joiners_clearance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The multi-user gate read the map with an UNFILTERED registry, so a
    signed-in clearance-0 caller could join the room of a level-4 COP it cannot
    load — and receive every viewport/selection delta the cleared driver
    published. There is no DI on a WebSocket, so the principal comes from the
    credential the WS gate itself validates (``auth.ws_credential``) through
    ``security.principal_for_token``, the helper that exists for WS handlers."""
    from starlette.testclient import WebSocketDenialResponse  # noqa: PLC0415
    from starlette.websockets import WebSocketDisconnect  # noqa: PLC0415

    from app.main import create_app  # noqa: PLC0415
    from tests._authkit import ALICE, mint, multi_user  # noqa: PLC0415

    multi_user(monkeypatch, url=False)

    async def seed() -> None:
        writer = get_registry(UserCtx(user_id=ALICE, token=""), _S)
        await writer.upsert(
            Object(
                id="map:secret",
                props={"kind": "map", "name": "SECRET COP", "state": {}},
                classification=4,
            )
        )
        await writer.upsert(
            Object(
                id="map:open",
                props={"kind": "map", "name": "open COP", "state": {}},
            )
        )

    asyncio.run(seed())
    with TestClient(create_app()) as c:
        # The level-0 COP still joins — the filter must not empty the room.
        with c.websocket_connect(f"/ws/cop?map=map:open&key={mint(ALICE)}") as ws:
            assert ws.receive_json()["kind"] == "joined"
        with pytest.raises((WebSocketDenialResponse, WebSocketDisconnect)):
            with c.websocket_connect(f"/ws/cop?map=map:secret&key={mint(ALICE)}") as ws:
                ws.receive_json()


# ── 10. governed actions that hand object data back to the caller ────────────


def test_flagging_a_hidden_object_neither_reads_nor_clobbers_it() -> None:
    """``flag_entity`` opened the registry with no principal, so its ``get``
    returned the hidden object, its props were merged into the flagged node, and
    the merged object went back in the receipt — a read-back of any level-4
    object's props for a clearance-0 caller. The registry is filtered now and a
    write that would land on a row the caller cannot see is refused."""
    from fastapi import HTTPException  # noqa: PLC0415

    from app.intel.actions import dispatch  # noqa: PLC0415

    asyncio.run(_seed())
    ctx = UserCtx(user_id=_USER, token="")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            dispatch("flag_entity", {"target_id": _SECRET, "note": "x", "severity": 1}, ctx)
        )
    assert exc.value.status_code == 403
    assert "the classified fact" not in str(exc.value.detail)

    obj = asyncio.run(_reg(None).get(_SECRET))
    assert obj is not None and obj.classification == 4
    assert obj.props["narrative"] == "the classified fact"

    # A level-0 target still flags — the gate must not refuse the normal case.
    res = asyncio.run(
        dispatch(
            "flag_entity",
            {"target_id": _OPEN, "note": "watch this", "severity": 2},
            ctx,
        )
    )
    assert res.detail["object"]["props"]["flag"]["note"] == "watch this"
