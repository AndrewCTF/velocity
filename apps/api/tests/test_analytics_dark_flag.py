"""Guard: analytics.query_vessels keeps the `dark_candidate` wire key.

Journalist-study finding this fixes: `dark_candidate` means "no static AIS
name+type broadcast for this contact", NOT "went dark / stopped transmitting".
The FIX was a relabel of the human-facing text in the frontend (EntityPanel,
VesselClassCard, styles.ts, registry/defaults.ts) — the wire contract MUST NOT
change, because styles.ts (vesselStyle), registry/defaults.ts and any alert
rule keyed on this property all depend on the exact key `dark_candidate`
(camelCased to `darkCandidate` client-side). This test fails loud if a future
edit renames the key or flips the underlying heuristic's semantics.
"""

from __future__ import annotations

import time

import pytest

from app.correlate.store import store
from app.correlate.types import Observation
from app.intel import analytics


@pytest.fixture(autouse=True)
def _isolate():
    store._buf.clear()
    store._latest.clear()
    yield
    store._buf.clear()
    store._latest.clear()


def _add_vessel(mmsi: str, name: str | None, ship_type: int | None) -> None:
    store.add(
        Observation(
            id=f"vessel:{mmsi}",
            source="aisstream",
            t=time.time(),
            lon=10.0,
            lat=50.0,
            emits_kind="vessel",
            attrs={"mmsi": mmsi, "name": name, "shipType": ship_type, "sog": 11.0, "cog": 90.0},
        )
    )


async def test_dark_candidate_key_present_for_no_static_identity() -> None:
    """A vessel with no name and no shipType is flagged dark_candidate=True —
    the wire key itself must not be renamed."""
    _add_vessel("111111111", name=None, ship_type=None)
    result = await analytics.query_vessels()
    assert result["vessels"], "expected the seeded vessel to come back"
    v = result["vessels"][0]
    assert "dark_candidate" in v, "wire key dark_candidate must stay stable"
    assert v["dark_candidate"] is True


async def test_dark_candidate_false_when_identity_known() -> None:
    """A vessel with a known name+type is NOT flagged dark_candidate — the
    heuristic is 'no static identity broadcast', not 'went dark'."""
    _add_vessel("222222222", name="MV TESTSHIP", ship_type=70)
    result = await analytics.query_vessels()
    v = next(v for v in result["vessels"] if v["mmsi"] == "222222222")
    assert v["dark_candidate"] is False
