"""Graph link-analysis tests on graphs with known centrality structure."""

from __future__ import annotations

from app.intel import graph_analytics as ga


def test_star_hub_is_top_key_node():
    nodes = ["hub", "l1", "l2", "l3", "l4"]
    edges = [("hub", "l1"), ("hub", "l2"), ("hub", "l3"), ("hub", "l4")]
    res = ga.analyze(nodes, edges)
    assert res["node_count"] == 5
    assert res["edge_count"] == 4
    assert res["community_count"] == 1
    assert res["key_nodes"][0]["id"] == "hub"
    # hub touches everyone → degree centrality 1.0; leaves < that
    assert res["key_nodes"][0]["degree"] == 1.0


def test_two_components_detected():
    res = ga.analyze(["a", "b", "c", "d"], [("a", "b"), ("c", "d")])
    assert res["community_count"] == 2
    assert sorted(len(c) for c in res["communities"]) == [2, 2]


def test_path_graph_middle_has_max_betweenness():
    # a-b-c-d-e : c lies on the most shortest paths
    edges = [("a", "b"), ("b", "c"), ("c", "d"), ("d", "e")]
    res = ga.analyze(["a", "b", "c", "d", "e"], edges)
    btw = {k["id"]: k["betweenness"] for k in res["key_nodes"]}
    assert btw["c"] > btw["b"] > btw["a"]
    assert res["key_nodes"][0]["id"] == "c"


def test_isolated_node_has_zero_centrality():
    res = ga.analyze(["a", "b", "lonely"], [("a", "b")])
    lonely = next(k for k in res["key_nodes"] if k["id"] == "lonely")
    assert lonely["degree"] == 0.0 and lonely["neighbors"] == 0
    assert res["community_count"] == 2  # {a,b} and {lonely}


def test_from_search_around_dict_and_objects():
    as_dict = {"objects": [{"id": "x"}, {"id": "y"}], "links": [{"src": "x", "dst": "y", "rel": "r"}]}
    ids, edges = ga.from_search_around(as_dict)
    assert set(ids) == {"x", "y"} and edges == [("x", "y")]
