"""Typed ontology spine — the semantic layer everything else composes on.

This is Velocity's Foundry-style ontology: a small, typed Object / Link /
Assertion / Action model plus the ``_GraphWalk`` BFS mixin. Persistence lives
in ``SqliteRegistry`` (``intel/ontology_local.py``), reached through
``get_registry()``: a local SQLite store (same idiom as ``app/history.py``) so
the ontology works on a keyless boot, with an append-only ``assertions`` table
carrying per-property provenance (source, confidence, observed_at,
derivation). A Supabase/PostgREST remote backend existed until 2026-07-07;
the operator invoked the kill criterion and deleted it (docs/decisions.md).

Objects are keyed by the **canonical ids already used across the repo** so the
ontology is a join over what the live layers already emit, not a parallel
namespace:

    aircraft:<icao24>     e.g. aircraft:4ca7b3
    vessel:<mmsi>         e.g. vessel:636092000
    incident:<uuid>       e.g. incident:8f1c…    (intel/incidents.py)
    sim:<id>              e.g. sim:uav-12        (browser war-game sim)

``ObjectKind`` is derived from the id prefix, so callers hand us an id and we
stay consistent with `correlate/runner.py`, `incidents.py`, and the sim.

The module imports with no side effects so boot never depends on a live DB.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.keys import UserCtx

if TYPE_CHECKING:  # runtime import lives in get_registry (module cycle)
    from app.intel.ontology_local import SqliteRegistry

# ── canonical object kinds ────────────────────────────────────────────────────
# Derived from the id prefix. "object" is the catch-all for an id whose prefix we
# don't recognise (we never reject — the ontology should be able to hold any node
# an action wants to create), but the known kinds are first-class.

# Infra/digital-OSINT kinds (domain … email) are minted by app/osint into this
# same graph; listing their prefixes here makes them first-class (own colour /
# facet) instead of the catch-all "object". The DB `kind` column is free text,
# so no migration is needed to add a prefix.
# "investigation" joined 2026-07-07: the Investigation canvas has always
# minted `investigation:<slug>` ids with kind="investigation" on save — the
# Literal rejected it with a 422 that the old auth-first 401 masked.
# "url" / "wallet" / "tx" / "file" joined Phase 0 of the OSINT source
# expansion (docs/osint-sources-plan.md) — url/hash/wallet/tx targets minted
# by the new fetch.py classify_target() kinds need a first-class home too.
# "country" / "resource" joined the country-OSINT catalog
# (docs/country-osint-spec.md) — app/osint/country_catalog.py::build_graph
# mints country:<code> -> resource:<code>:<slug> -> domain:<host>.
ObjectKind = Literal[
    "aircraft", "vessel", "incident", "sim",
    "domain", "ip", "cert", "asn", "service", "threat", "org", "email",
    "person", "username", "investigation",
    "url", "wallet", "tx", "file",
    "country", "resource",
    "object",
]

_KNOWN_KINDS: frozenset[str] = frozenset(
    (
        "aircraft", "vessel", "incident", "sim",
        "domain", "ip", "cert", "asn", "service", "threat", "org", "email",
        "person", "username", "investigation",
        "url", "wallet", "tx", "file",
        "country", "resource",
        "object",
    )
)

# Link relations seeded by the first write-back actions + the fusion engine.
# Not an enum (the registry must hold an edge an analyst/agent invents), but the
# canonical verbs are documented here so callers stay consistent.
KNOWN_RELS: frozenset[str] = frozenset(
    (
        "flagged",  # analyst flagged this object (object → flag note)
        "evidence_of",  # signal/track → incident it supports
        "promoted_to",  # object → incident promoted from it
        "nominated",  # object → target_board entry
        "watched_by",  # object → alert_rule watching it
        "operates",  # operator → aircraft/vessel
        "correlated",  # cross-domain co-location (from the correlations index)
        "member_of",  # sim drone → swarm
        "contains",  # situation → child incident/entity/COA it aggregates
        "part_of",  # inverse of contains (child → situation)
        # Phase 0 OSINT source expansion (docs/osint-sources-plan.md) — verbs
        # for the new url/wallet/tx/file kinds and their infra/threat context.
        "archived_url",  # domain/url → its wayback-preserved copy
        "contacted",  # url/malware → ip it was observed talking to
        "peers_with",  # asn → peer asn (BGP peering/upstream relationship)
        "tor_exit",  # ip → threat node flagging it as a Tor exit relay
        "listed_by",  # ip/url/hash → threat feed that listed it
        "distributes",  # url → file it serves/hosts
        "sends_to",  # wallet → tx (outbound transfer)
        "receives_from",  # wallet → tx (inbound transfer)
        "officer_of",  # person → org they're an officer/director of
        "sanctioned_as",  # org/person → threat node (sanctions list entry)
        "same_as",  # object → wikidata entity bridge (entity resolution)
        "posted_by",  # reddit/social activity → username that posted it
        # Country-OSINT catalog (docs/country-osint-spec.md).
        "has_resource",  # country → resource (a toolkit entry for that country)
        "hosted_at",  # resource → domain (the resource URL's host — bridges
        # into the same domain: node the digital-OSINT investigate() enriches)
    )
)


def kind_of(object_id: str) -> ObjectKind:
    """Map a canonical id to its ``ObjectKind`` by prefix.

    ``aircraft:4ca7b3`` → ``"aircraft"``. Unknown / prefix-less ids → ``"object"``
    so the registry can still hold an analyst-created node.
    """
    prefix = object_id.split(":", 1)[0] if ":" in object_id else ""
    return prefix if prefix in _KNOWN_KINDS else "object"  # type: ignore[return-value]


# ── typed models ──────────────────────────────────────────────────────────────


class Object(BaseModel):
    """A node in the ontology graph.

    ``id`` is a canonical id (``aircraft:<icao24>`` …). ``kind`` is normally
    derived from the id but stored explicitly so a query can filter on it. ``props``
    is free-form distilled attributes (callsign, name, last lat/lon, flag, …) —
    NOT a full feature dump; the live layers remain the source of truth for
    high-frequency state.
    """

    id: str = Field(..., min_length=1, max_length=200)
    kind: ObjectKind = "object"
    props: dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None
    # Gotham-substrate ACL: classification ladder (0..4), positive compartments
    # the reader must hold, and whether this row is shared beyond its owner. The
    # DB RLS policies gate visibility on these columns (see the substrate migration).
    classification: int = 0
    compartments: list[str] = Field(default_factory=list)
    shared: bool = False

    def normalised(self) -> Object:
        """Return a copy with ``kind`` reconciled to the id prefix."""
        derived = kind_of(self.id)
        if derived != self.kind and derived != "object":
            return self.model_copy(update={"kind": derived})
        # If caller passed the catch-all but the prefix is known, fix it up.
        if self.kind == "object":
            return self.model_copy(update={"kind": derived})
        return self


class Link(BaseModel):
    """A typed, directed edge ``src --rel--> dst`` between two object ids."""

    src: str = Field(..., min_length=1, max_length=200)
    dst: str = Field(..., min_length=1, max_length=200)
    rel: str = Field(..., min_length=1, max_length=60)
    props: dict[str, Any] = Field(default_factory=dict)
    id: str | None = None
    created_at: str | None = None
    # ACL columns — same semantics as Object (see the substrate migration).
    classification: int = 0
    compartments: list[str] = Field(default_factory=list)
    shared: bool = False
    # Provenance — first-class columns in the local store. Additive with
    # defaults so existing callers and the frontend are unaffected.
    source: str = "analyst"
    confidence: float = 1.0
    observed_at: str | None = None
    valid_until: str | None = None


class Assertion(BaseModel):
    """One evidenced property statement about an object.

    The local store records every property as a time series of assertions —
    *who said this, when, how sure* — instead of only a mutable blob. ``value``
    is the parsed JSON value; a removal tombstone is ``value=None`` with
    ``derivation={"op": "remove"}``.
    """

    object_id: str
    prop: str
    value: Any = None
    source: str = "analyst"
    confidence: float = 1.0
    observed_at: str
    valid_until: str | None = None
    derivation: dict[str, Any] | None = None
    id: int | None = None


class Action(BaseModel):
    """A typed action descriptor — name + the param schema it expects.

    The ontology owns the *vocabulary* of actions (what verbs exist and what they
    take); ``intel/actions.py`` owns the *handlers* that execute them and append to
    ``action_log``. Splitting it this way keeps the schema spine here (composable,
    no Supabase write deps) and the side effects there.
    """

    name: str = Field(..., min_length=1, max_length=60)
    summary: str = ""
    # JSON-schema-ish param spec: {field: {"type": "str", "required": True, …}}.
    params: dict[str, dict[str, Any]] = Field(default_factory=dict)


class SearchAround(BaseModel):
    """Result of ``traverse`` — the center object plus its neighbourhood."""

    center: str
    depth: int
    objects: list[Object] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)


class PathResult(BaseModel):
    """Result of ``path_between`` — the shortest chain linking two objects.

    ``found`` is whether a path within ``max_depth`` hops exists. When found,
    ``path`` is the ordered list of object ids from ``a`` to ``b`` (inclusive)
    and ``objects`` / ``links`` carry just the nodes + edges ALONG that chain
    (an undirected walk — a typed edge ``src --rel--> dst`` connects in either
    direction for path-finding, so an analyst can ask "how is A connected to B"
    without knowing edge orientation). When not found both are empty and the
    frontend renders an honest "no connection within N hops".
    """

    a: str
    b: str
    found: bool = False
    hops: int = 0
    path: list[str] = Field(default_factory=list)
    objects: list[Object] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)


class _GraphWalk:
    """Backend-agnostic graph walks over ``get`` + ``_links_touching``.

    ``traverse`` and ``path_between`` are pure BFS over two storage primitives,
    so they live here once and both registries (PostgREST + SQLite) inherit
    them — the BFS test matrix in ``test_ontology_path.py`` covers both.
    Subclasses provide ``async get(object_id)`` and
    ``async _links_touching(ids)``.
    """

    async def get(self, object_id: str) -> Object | None:  # pragma: no cover
        raise NotImplementedError

    async def _links_touching(
        self, ids: list[str]
    ) -> list[Link]:  # pragma: no cover
        raise NotImplementedError

    async def traverse(self, object_id: str, depth: int = 1) -> SearchAround:
        """Breadth-first walk out from ``object_id`` up to ``depth`` hops.

        Returns the reachable objects + the links between them. ``depth`` is
        clamped to ``1..3`` — this is an analyst neighbourhood view, not a full
        graph dump, so we never let it fan out unbounded. Objects referenced by a
        link but not yet persisted as their own row are still returned as a
        derived stub (``kind`` from the id), so an edge to a live-but-unsaved
        ``aircraft:…`` still shows up.
        """
        depth = max(1, min(int(depth), 3))
        seen_objs: dict[str, Object] = {}
        seen_links: dict[tuple[str, str, str], Link] = {}

        center = await self.get(object_id)
        seen_objs[object_id] = center or Object(id=object_id, kind=kind_of(object_id))

        frontier = [object_id]
        for _ in range(depth):
            if not frontier:
                break
            links = await self._links_touching(frontier)
            next_frontier: list[str] = []
            for lk in links:
                seen_links[(lk.src, lk.dst, lk.rel)] = lk
                for nid in (lk.src, lk.dst):
                    if nid not in seen_objs:
                        next_frontier.append(nid)
                        # Persisted node? fetch it; else a derived stub.
                        node = await self.get(nid)
                        seen_objs[nid] = node or Object(id=nid, kind=kind_of(nid))
            frontier = next_frontier

        return SearchAround(
            center=object_id,
            depth=depth,
            objects=list(seen_objs.values()),
            links=list(seen_links.values()),
        )

    async def path_between(
        self, a: str, b: str, max_depth: int = 4
    ) -> PathResult:
        """Shortest UNDIRECTED chain from ``a`` to ``b`` within ``max_depth`` hops.

        Breadth-first over the link graph treating each ``src --rel--> dst`` edge
        as connecting in BOTH directions (an analyst asking "how is this aircraft
        connected to that incident" doesn't care which way the edge points). BFS
        guarantees the first time we reach ``b`` is via a shortest path, which we
        reconstruct from a parent map. Returns just the nodes + edges along that
        chain (not the whole neighbourhood — that's ``traverse``).

        ``max_depth`` is clamped to ``1..6``. ``a == b`` is a trivial zero-hop
        path. Unreachable within the budget → ``found=False`` with empty path,
        which the frontend renders as an honest "no connection within N hops".
        Nodes on the path that aren't persisted come back as derived stubs (kind
        from the id prefix), exactly like ``traverse``.
        """
        max_depth = max(1, min(int(max_depth), 6))

        if a == b:
            node = await self.get(a) or Object(id=a, kind=kind_of(a))
            return PathResult(a=a, b=b, found=True, hops=0, path=[a], objects=[node])

        # BFS layer by layer. ``parent[node]`` records (prev_node, link_used) so
        # we can walk back from b to a once found. ``frontier`` is the current
        # ring; we fetch all links touching it in one batched pair of queries.
        parent: dict[str, tuple[str, Link]] = {}
        visited: set[str] = {a}
        frontier = [a]

        found = False
        for _ in range(max_depth):
            if not frontier:
                break
            links = await self._links_touching(frontier)
            next_frontier: list[str] = []
            for lk in links:
                # Undirected: from whichever endpoint is on the frontier, the
                # OTHER endpoint is a candidate next node.
                for src_side, dst_side in ((lk.src, lk.dst), (lk.dst, lk.src)):
                    if src_side in visited and dst_side not in visited:
                        visited.add(dst_side)
                        parent[dst_side] = (src_side, lk)
                        next_frontier.append(dst_side)
                        if dst_side == b:
                            found = True
                            break
                if found:
                    break
            if found:
                break
            frontier = next_frontier

        if not found:
            return PathResult(a=a, b=b, found=False, hops=0)

        # Reconstruct b → a from the parent map, then reverse to a → b.
        chain_ids: list[str] = [b]
        chain_links: list[Link] = []
        cur = b
        while cur != a:
            prev, lk = parent[cur]
            chain_links.append(lk)
            chain_ids.append(prev)
            cur = prev
        chain_ids.reverse()
        chain_links.reverse()

        # Resolve each node on the path: persisted row or derived stub.
        objects: list[Object] = []
        for nid in chain_ids:
            node = await self.get(nid)
            objects.append(node or Object(id=nid, kind=kind_of(nid)))

        return PathResult(
            a=a,
            b=b,
            found=True,
            hops=len(chain_links),
            path=chain_ids,
            objects=objects,
            links=chain_links,
        )


# ── backend selection ─────────────────────────────────────────────────────────


def get_registry(ctx: UserCtx, settings: Settings | None = None) -> SqliteRegistry:
    """The ontology store for this caller — the local SQLite registry.

    2026-07-07: the operator invoked the kill criterion and deleted the
    Supabase/PostgREST backend (docs/decisions.md) — the local spine is the
    only store. The factory stays so call sites and a future remote backend
    (if ever re-earned) keep one seam. Late import avoids a module cycle.
    """
    from app.intel.ontology_local import SqliteRegistry

    return SqliteRegistry(ctx, settings or get_settings())
