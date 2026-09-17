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
