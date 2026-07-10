"""short/long context-optimisation variants for the MCP tool layer.

Covers the pure shaper (`app.intel.shape.shape`) and its wiring into the MCP
tools (default `short` digest vs opt-in `long` full bundle).
"""

from __future__ import annotations

import pytest

import app.mcp_server as M
from app.intel.shape import LONG, SHORT, normalize_detail, shape


def test_normalize_detail_defaults_and_coerces() -> None:
    assert normalize_detail(None) == SHORT
    assert normalize_detail("") == SHORT
    assert normalize_detail("LONG") == LONG
    assert normalize_detail("  short ") == SHORT
    assert normalize_detail("garbage") == SHORT  # unknown -> safe default


def test_long_is_exact_passthrough() -> None:
    payload = {"incidents": [{"id": i} for i in range(50)], "narrative": "x" * 999}
    assert shape(payload, "long") is payload  # untouched, same object


def test_error_envelope_never_shrunk() -> None:
    err = {"error": "backend_unreachable", "detail": "y" * 999, "list": list(range(99))}
    assert shape(err, "short") == err  # errors pass through verbatim


def test_non_dict_passthrough() -> None:
    assert shape([1, 2, 3], "short") == [1, 2, 3]
    assert shape("hello", "short") == "hello"


def test_small_payload_is_noop_under_short() -> None:
    """The many already-tiny tool payloads must be returned UNCHANGED (no added
    keys) so short is a faithful passthrough for them."""
    payload = {"ok": True, "count": 3, "items": [1, 2, 3]}
    out = shape(payload, "short")
    assert out == payload
    assert "truncated" not in out and "hint" not in out


def test_short_caps_lists_and_reports_true_size() -> None:
    payload = {"incidents": [{"id": i} for i in range(20)]}
    out = shape(payload, "short", list_cap=5)
    assert len(out["incidents"]) == 5
    assert out["incidents_total"] == 20  # honest full-set size
    assert out["truncated"] is True
    assert "detail='long'" in out["hint"]
    # first items are preserved in order (agent sees the head of the list)
    assert [x["id"] for x in out["incidents"]] == [0, 1, 2, 3, 4]


def test_short_truncates_verbose_strings() -> None:
    payload = {"narrative": "n" * 500}
    out = shape(payload, "short", str_cap=240)
    assert len(out["narrative"]) == 240 and out["narrative"].endswith("…")
    assert out["truncated"] is True


def test_short_digests_nested_structures() -> None:
    payload = {
        "situation": {
            "aircraft": {"total": 13000},
            "gps_jamming": {"cells": [{"c": i} for i in range(40)]},
        }
    }
    out = shape(payload, "short", list_cap=3)
    assert out["situation"]["aircraft"]["total"] == 13000  # scalars kept
    assert len(out["situation"]["gps_jamming"]["cells"]) == 3
    assert out["situation"]["gps_jamming"]["cells_total"] == 40


def test_existing_total_key_not_clobbered() -> None:
    payload = {"cells": list(range(10)), "cells_total": 99}  # pre-set count wins
    out = shape(payload, "short", list_cap=2)
    assert out["cells_total"] == 99


@pytest.mark.asyncio
async def test_tool_short_default_vs_long(monkeypatch: pytest.MonkeyPatch) -> None:
    """A heavy tool defaults to the short digest; detail='long' returns it all."""
    big = {
        "incidents": [{"id": i, "narrative": "z" * 400} for i in range(30)],
        "threat_level": "elevated",
    }

    async def _fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        return big

    monkeypatch.setattr(M, "_get", _fake_get)

    short = await M.intel_brief()  # default detail
    assert len(short["incidents"]) < 30
    assert short["incidents_total"] == 30
    assert short["threat_level"] == "elevated"  # headline scalar survives

    full = await M.intel_brief(detail="long")
    assert full is big  # long is the untouched bundle
    assert len(full["incidents"]) == 30


@pytest.mark.asyncio
async def test_tool_short_errors_pass_through(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_get(path: str, params=None):  # type: ignore[no-untyped-def]
        return {"error": "backend_500", "detail": "boom"}

    monkeypatch.setattr(M, "_get", _fake_get)
    out = await M.get_situation()  # short default must not mangle an error
    assert out["error"] == "backend_500"
