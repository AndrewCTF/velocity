"""Need-to-know on the intel agent: read-tool results are redacted to the
caller's clearance/compartments before they reach the LLM or the SSE frame.

Pure-logic tests — no network. They drive the reused classification primitives
(``redact_for`` / ``redact_features``) and the agent's redaction seam
(``agent._redact_tool_result``) with tagged rows. Live OSINT feeds carry no
``classification`` field, so redaction is a no-op on them; the teeth land on the
classified ontology rows (intel_brief / lookups) that DO carry a level.
"""

from __future__ import annotations

from app.intel import agent
from app.intel import classification as clf
from app.intel.classification import SECRET, TOP_SECRET, UNCLASSIFIED


def test_redact_for_clearance_zero_drops_secret_keeps_unclassified():
    rows = [{"classification": SECRET, "id": "a"}, {"classification": UNCLASSIFIED, "id": "b"}]
    out = clf.redact_for(0, (), rows)
    assert [r["id"] for r in out] == ["b"]


def test_redact_for_clearance_secret_keeps_secret_drops_top_secret():
    rows = [{"classification": SECRET, "id": "s"}, {"classification": TOP_SECRET, "id": "ts"}]
    out = clf.redact_for(SECRET, (), rows)
    assert [r["id"] for r in out] == ["s"]


def test_redact_for_compartment_required_but_not_held_is_dropped():
    rows = [{"classification": UNCLASSIFIED, "compartments": ["FVEY"], "id": "x"}]
    assert clf.redact_for(SECRET, (), rows) == []


def test_redact_for_compartment_held_case_insensitive_is_kept():
    rows = [{"classification": UNCLASSIFIED, "compartments": ["FVEY"], "id": "x"}]
    out = clf.redact_for(SECRET, ("fvey",), rows)
    assert [r["id"] for r in out] == ["x"]


def _fc():
    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"classification": SECRET, "id": "s"}},
            {"type": "Feature", "properties": {"classification": UNCLASSIFIED, "id": "u"}},
        ],
    }


def test_redact_features_clearance_zero_keeps_only_unclassified_feature():
    out = clf.redact_features(0, (), _fc())
    assert [f["properties"]["id"] for f in out["features"]] == ["u"]
    assert out["type"] == "FeatureCollection"  # envelope preserved


def test_redact_features_clearance_secret_keeps_both_features():
    out = clf.redact_features(SECRET, (), _fc())
    assert [f["properties"]["id"] for f in out["features"]] == ["s", "u"]


def test_redact_features_tolerates_non_feature_collection():
    plain = {"incident_count": 3}
    assert clf.redact_features(0, (), plain) == plain  # missing "features" → unchanged


def test_agent_seam_redacts_feature_collection_by_clearance():
    # The seam the dispatch loop calls on every read-tool result. A SECRET feature
    # is gone for a keyless (clearance 0) reader, present for a SECRET reader.
    at_zero = agent._redact_tool_result(0, (), _fc())
    assert [f["properties"]["id"] for f in at_zero["features"]] == ["u"]
    at_secret = agent._redact_tool_result(SECRET, (), _fc())
    assert [f["properties"]["id"] for f in at_secret["features"]] == ["s", "u"]


def test_agent_seam_redacts_plain_row_list():
    rows = [{"classification": TOP_SECRET, "id": "ts"}, {"classification": UNCLASSIFIED, "id": "u"}]
    out = agent._redact_tool_result(0, (), rows)
    assert [r["id"] for r in out] == ["u"]


def test_agent_seam_passes_through_unclassified_feed_dict():
    # Live OSINT feed shape (no "features", no "classification") → untouched.
    feed = {"count": 42, "aircraft": 13000}
    assert agent._redact_tool_result(0, (), feed) == feed
