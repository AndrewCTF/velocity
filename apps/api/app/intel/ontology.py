"""Typed ontology spine — the semantic layer everything else composes on.

This is Velocity's Foundry-style ontology: a small, typed Object / Link / Action
model plus a registry that persists objects and links per user in Supabase
(``public.objects`` / ``public.links``, RLS-scoped via the caller's token, the
exact same PostgREST pattern as ``target_board`` / ``alert_rules`` / BYOK).

Objects are keyed by the **canonical ids already used across the repo** so the
ontology is a join over what the live layers already emit, not a parallel
namespace:

    aircraft:<icao24>     e.g. aircraft:4ca7b3
    vessel:<mmsi>         e.g. vessel:636092000
    incident:<uuid>       e.g. incident:8f1c…    (intel/incidents.py)
    sim:<id>              e.g. sim:uav-12        (browser war-game sim)

``ObjectKind`` is derived from the id prefix, so callers hand us an id and we
stay consistent with `correlate/runner.py`, `incidents.py`, and the sim.

Everything degrades gracefully when Supabase is unconfigured or the tables are
absent: reads return ``None`` / ``[]`` and writes raise a 503 with the same
"store not configured" contract the frontend relies on (mirrors `targets.py`).
The module imports with no side effects so boot never depends on a live DB.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.keys import UserCtx, _client, _headers

# ── canonical object kinds ────────────────────────────────────────────────────
# Derived from the id prefix. "object" is the catch-all for an id whose prefix we
# don't recognise (we never reject — the ontology should be able to hold any node
# an action wants to create), but the known kinds are first-class.

# Infra/digital-OSINT kinds (domain … email) are minted by app/osint into this
# same graph; listing their prefixes here makes them first-class (own colour /
# facet) instead of the catch-all "object". The DB `kind` column is free text,
# so no migration is needed to add a prefix.
ObjectKind = Literal[
    "aircraft", "vessel", "incident", "sim",
    "domain", "ip", "cert", "asn", "service", "threat", "org", "email",
    "person", "username",
    "object",
]

_KNOWN_KINDS: frozenset[str] = frozenset(
    (
        "aircraft", "vessel", "incident", "sim",
        "domain", "ip", "cert", "asn", "service", "threat", "org", "email",
        "person", "username",
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


# ── PostgREST plumbing (RLS-scoped via the caller's token) ────────────────────
# Mirrors targets.py / keys.py exactly: one base-url helper per table that raises
# 503 when supabase_url is unset, and reuses keys._client / keys._headers.


def _objects_url(s: Settings) -> str:
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    return s.supabase_url.rstrip("/") + "/rest/v1/objects"


def _links_url(s: Settings) -> str:
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    return s.supabase_url.rstrip("/") + "/rest/v1/links"


class OntologyRegistry:
    """Per-user persistent Object/Link store over PostgREST.

    Constructed with the caller's ``UserCtx``; every read/write is scoped to that
    user by RLS (``auth.uid() = user_id``) AND an explicit ``user_id=eq.`` filter,
    so a user only ever touches their own graph.
    """

    def __init__(self, ctx: UserCtx, settings: Settings | None = None) -> None:
        self.ctx = ctx
        self.s = settings or get_settings()

    # ---- objects ----------------------------------------------------------

    async def upsert(self, obj: Object) -> Object:
        """Insert or merge an object (unique on ``(user_id, id)``).

        Server-side jsonb merge is not available through PostgREST, so we send
        the row with ``resolution=merge-duplicates``: re-upserting the same id
        replaces the row's columns wholesale. Callers that want to *extend*
        ``props`` should ``get`` first and merge in Python.
        """
        obj = obj.normalised()
        row = {
            "id": obj.id,
            "user_id": self.ctx.user_id,
            "kind": obj.kind,
            "props": obj.props,
            "classification": int(obj.classification),
            "compartments": obj.compartments,
            "shared": obj.shared,
        }
        headers = {
            **_headers(self.ctx, self.s, write=True),
            "Prefer": "resolution=merge-duplicates,return=representation",
        }
        async with _client() as c:
            r = await c.post(_objects_url(self.s), json=row, headers=headers)
        if r.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail="could not save object")
        data = r.json()
        stored = data[0] if isinstance(data, list) and data else (data or row)
        return Object(**_object_row(stored))

    async def get(self, object_id: str) -> Object | None:
        """Fetch one object by id (RLS-scoped). ``None`` if absent."""
        async with _client() as c:
            r = await c.get(
                _objects_url(self.s),
                params={
                    "user_id": f"eq.{self.ctx.user_id}",
                    "id": f"eq.{object_id}",
                    "select": "*",
                    "limit": "1",
                },
                headers=_headers(self.ctx, self.s),
            )
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="object store unavailable")
        rows = r.json()
        if not rows:
            return None
        return Object(**_object_row(rows[0]))

    # ---- links ------------------------------------------------------------

    async def link(self, link: Link) -> Link:
        """Create an edge. Idempotent on ``(user_id, src, dst, rel)``."""
        row = {
            "user_id": self.ctx.user_id,
            "src": link.src,
            "dst": link.dst,
            "rel": link.rel,
            "props": link.props,
            "classification": int(link.classification),
            "compartments": link.compartments,
            "shared": link.shared,
        }
        headers = {
            **_headers(self.ctx, self.s, write=True),
            "Prefer": "resolution=merge-duplicates,return=representation",
        }
        async with _client() as c:
            r = await c.post(_links_url(self.s), json=row, headers=headers)
        if r.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail="could not save link")
        data = r.json()
        stored = data[0] if isinstance(data, list) and data else (data or row)
        return Link(**_link_row(stored))

    async def _links_touching(self, ids: list[str]) -> list[Link]:
        """All links whose src OR dst is in ``ids`` (one round trip each side)."""
        if not ids:
            return []
        # PostgREST `in.(…)` list; ids are canonical (no commas/quotes) but wrap
        # defensively. Two queries (src-side, dst-side) unioned — simpler and
        # more index-friendly than an `or=` across both columns.
        in_list = "(" + ",".join(_quote_in(i) for i in ids) + ")"
        out: dict[tuple[str, str, str], Link] = {}
        async with _client() as c:
            for col in ("src", "dst"):
                r = await c.get(
                    _links_url(self.s),
                    params={
                        "user_id": f"eq.{self.ctx.user_id}",
                        col: f"in.{in_list}",
                        "select": "*",
                    },
                    headers=_headers(self.ctx, self.s),
                )
                if r.status_code != 200:
                    raise HTTPException(
                        status_code=502, detail="link store unavailable"
                    )
                for row in r.json():
                    lk = Link(**_link_row(row))
                    out[(lk.src, lk.dst, lk.rel)] = lk
        return list(out.values())

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


# ── row coercion ──────────────────────────────────────────────────────────────
# PostgREST may hand back extra columns (user_id, jsonb already parsed). Keep only
# the model fields and tolerate props arriving as None.


def _object_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "kind": row.get("kind") or kind_of(str(row.get("id", ""))),
        "props": row.get("props") or {},
        "created_at": row.get("created_at"),
        "classification": row.get("classification", 0) or 0,
        "compartments": row.get("compartments") or [],
        "shared": bool(row.get("shared", False)),
    }


def _link_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "src": row.get("src"),
        "dst": row.get("dst"),
        "rel": row.get("rel"),
        "props": row.get("props") or {},
        "created_at": row.get("created_at"),
        "classification": row.get("classification", 0) or 0,
        "compartments": row.get("compartments") or [],
        "shared": bool(row.get("shared", False)),
    }


def _quote_in(value: str) -> str:
    """Quote a value for a PostgREST ``in.(…)`` list if it needs it."""
    if any(ch in value for ch in (",", '"', "(", ")", " ")):
        return '"' + value.replace('"', '\\"') + '"'
    return value
