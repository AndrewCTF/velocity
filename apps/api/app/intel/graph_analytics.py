"""Graph link-analysis over the ontology — centrality, communities, key nodes.

Gotham's headline link-analysis answers "who are the important nodes in this
network" (centrality) and "what are the clusters" (community detection). Velocity
already has neighbourhood expansion (``ontology.traverse``) and shortest-path
(``ontology.path_between``); this module adds the metrics on top.

Pure Python on purpose: an analyst's ontology graph (their own annotations + a
depth-bounded search-around neighbourhood) is small — dozens to a few hundred
nodes — so exact Brandes betweenness and BFS components are instant and we avoid
a ``networkx`` dependency for a few dozen lines of standard graph code.

# ponytail: exact Brandes O(V*E) + component BFS; fine for the bounded per-user
# graph. Swap to networkx/igraph only if a whole-corpus graph (10k+ nodes) ever
# needs analysis here.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable
from typing import Any


def _adjacency(node_ids: Iterable[str], edges: Iterable[tuple[str, str]]) -> dict[str, set[str]]:
    """Undirected adjacency. Edge endpoints not in node_ids are added as nodes so
    an edge to a not-yet-persisted stub still counts (matches traverse's stubs)."""
    adj: dict[str, set[str]] = {n: set() for n in node_ids}
    for a, b in edges:
        if a == b:
            continue  # ignore self-loops for centrality
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)
    return adj


def degree_centrality(adj: dict[str, set[str]]) -> dict[str, float]:
    n = len(adj)
    if n <= 1:
        return {v: 0.0 for v in adj}
    return {v: len(nbrs) / (n - 1) for v, nbrs in adj.items()}


def betweenness_centrality(adj: dict[str, set[str]]) -> dict[str, float]:
    """Exact Brandes betweenness for an unweighted, undirected graph, normalised
    to [0, 1] (the fraction of shortest paths through each node)."""
    bc: dict[str, float] = {v: 0.0 for v in adj}
    for s in adj:
        stack: list[str] = []
        preds: dict[str, list[str]] = {w: [] for w in adj}
        sigma: dict[str, float] = {w: 0.0 for w in adj}
        sigma[s] = 1.0
        dist: dict[str, int] = {w: -1 for w in adj}
        dist[s] = 0
        q: deque[str] = deque([s])
        while q:
            v = q.popleft()
            stack.append(v)
            for w in adj[v]:
                if dist[w] < 0:
                    dist[w] = dist[v] + 1
                    q.append(w)
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    preds[w].append(v)
        delta: dict[str, float] = {w: 0.0 for w in adj}
        while stack:
            w = stack.pop()
            for v in preds[w]:
                delta[v] += (sigma[v] / sigma[w]) * (1.0 + delta[w])
            if w != s:
                bc[w] += delta[w]
    # undirected: each pair counted twice
    for v in bc:
        bc[v] /= 2.0
    n = len(adj)
    if n > 2:
        norm = 2.0 / ((n - 1) * (n - 2))
        for v in bc:
            bc[v] *= norm
    return bc


def communities(adj: dict[str, set[str]]) -> list[list[str]]:
    """Connected components as communities (BFS), each sorted, largest first.

    For a sparse analyst graph, components ARE the natural clusters; Louvain-style
    modularity splitting is deferred until a single component grows large enough
    to need sub-clustering.
    """
    seen: set[str] = set()
    out: list[list[str]] = []
    for start in adj:
        if start in seen:
            continue
        comp: list[str] = []
        q: deque[str] = deque([start])
        seen.add(start)
        while q:
            v = q.popleft()
            comp.append(v)
            for w in adj[v]:
                if w not in seen:
                    seen.add(w)
                    q.append(w)
        out.append(sorted(comp))
    out.sort(key=len, reverse=True)
    return out


def from_search_around(result: Any) -> tuple[list[str], list[tuple[str, str]]]:
    """Extract (node_ids, edges) from an ontology ``SearchAround`` (or a dict with
    ``objects``/``links``). Tolerant of pydantic objects and plain dicts."""
    objs = getattr(result, "objects", None)
    links = getattr(result, "links", None)
    if objs is None and isinstance(result, dict):
        objs = result.get("objects", [])
        links = result.get("links", [])
    node_ids = [getattr(o, "id", None) or o.get("id") for o in (objs or [])]
    edges: list[tuple[str, str]] = []
    for lk in (links or []):
        src = getattr(lk, "src", None) or (lk.get("src") if isinstance(lk, dict) else None)
        dst = getattr(lk, "dst", None) or (lk.get("dst") if isinstance(lk, dict) else None)
        if src and dst:
            edges.append((src, dst))
    return [n for n in node_ids if n], edges


def analyze(
    node_ids: Iterable[str], edges: Iterable[tuple[str, str]], *, top_k: int = 10
) -> dict[str, Any]:
    """Full link-analysis summary for a node/edge set.

    Returns degree + betweenness centrality, connected-component communities, and
    a ranked ``key_nodes`` list (the network's most central actors — the ones
    whose removal most fragments it).
    """
    adj = _adjacency(node_ids, edges)
    deg = degree_centrality(adj)
    btw = betweenness_centrality(adj)
    comps = communities(adj)
    ranked = sorted(
        adj.keys(),
        key=lambda v: (btw.get(v, 0.0), deg.get(v, 0.0)),
        reverse=True,
    )
    key_nodes = [
        {"id": v, "betweenness": round(btw[v], 4), "degree": round(deg[v], 4),
         "neighbors": len(adj[v])}
        for v in ranked[:top_k]
    ]
    return {
        "node_count": len(adj),
        "edge_count": sum(len(n) for n in adj.values()) // 2,
        "community_count": len(comps),
        "communities": comps,
        "key_nodes": key_nodes,
    }
