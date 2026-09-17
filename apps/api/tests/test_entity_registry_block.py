"""Guard: the T0 ↔ T2 join on the object view (gap-analysis §6 rows 6-7).

``GET /api/entity/{eid}`` carries a ``registry`` block: the ontology's
assertions for the SAME canonical id, each stamped with the tier its SOURCE
names and its lag against the object's newest live sensor fix. Without that
join the object view is a map tooltip ("what is it, where") — with it, it also
answers *says who, since when, and how far from the fix*.

Fixtures follow ``tests/test_ontology_local.py``: the real ``SqliteRegistry``
on the per-test temp DB the autouse ``_isolate_ontology_db`` hook installs.
The live fix is seeded into a fresh correlate store monkeypatched over
``app.routes.entity.store`` and the aircraft enrichment's upstreams are stubbed
at ``get_client`` / ``cache.get_or_fetch``, so nothing here touches the network.
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.correlate.store import ObservationStore
from app.correlate.types import Observation
from app.intel.ontology import Object, get_registry
from app.keys import UserCtx
from app.routes import entity

_S = Settings(supabase_url="")
ICAO = "4ca7b3"
_LIVE = f"aircraft:{ICAO}"


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _reg():
    reg = get_registry(UserCtx("local", ""), _S)
    return reg


def _seed(fix_t: float | None) -> None:
    """One object with assertions in all five tiers, plus the live ADS-B fix."""

    async def run() -> None:
        reg = _reg()
        await reg.upsert(Object(id=_LIVE, kind="aircraft", props={"icao24": ICAO}))
        # sensor: the live feed itself
        await reg.assert_props(_LIVE, {"callsign": "RYR123"}, source="adsb", observed_at=_iso(fix_t or time.time()))
        # registry: who it is registered to
        await reg.assert_props(
            _LIVE,
            {"operator": "Ryanair Holdings plc"},
            source="registry:gleif",
            confidence=0.9,
            observed_at=_iso((fix_t or time.time()) + 3 * 3600),
            derivation={"note": "LEI parent"},
        )
        # filing: a document filed about it
        await reg.assert_props(
            _LIVE,
            {"owner_filed": "RYANAIR DAC"},
            source="sec:edgar",
            observed_at=_iso((fix_t or time.time()) - 6 * 3600),
        )
        # claim: somebody said so
        await reg.assert_props(_LIVE, {"sighting": "unconfirmed"}, source="gdelt", observed_at=_iso(fix_t or time.time()))
        # unknown prefix → other, never guessed into a tier
        await reg.assert_props(_LIVE, {"hunch": "no"}, source="analyst", observed_at=_iso(fix_t or time.time()))

    asyncio.run(run())


def _stub_upstreams(monkeypatch: pytest.MonkeyPatch, fix_t: float | None) -> None:
    """No-network aircraft enrichment + an isolated correlate store."""

    class _Resp:
        status_code = 200

        def json(self) -> dict[str, str]:
            return {
                "Registration": "EI-ABC",
                "Type": "B737-800",
                "ICAOTypeCode": "B738",
                "RegisteredOwners": "Ryanair",
                "Manufacturer": "Boeing",
                "Country": "Ireland",
                "ModeS": ICAO.upper(),
            }

    class _Client:
        async def get(self, *_a: object, **_k: object) -> _Resp:
            return _Resp()

    async def _uncached(_key: str, _ttl: float, loader):  # type: ignore[no-untyped-def]
        return await loader()

    store = ObservationStore()
    if fix_t is not None:
        store.add(Observation(id=_LIVE, source="adsb", t=fix_t, lon=6.1, lat=46.2, emits_kind="aircraft"))
    monkeypatch.setattr(entity, "store", store)
    monkeypatch.setattr(entity, "get_client", lambda: _Client())
    monkeypatch.setattr(entity.cache, "get_or_fetch", _uncached)


def test_registry_block_tiers_and_lag(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    # Second-aligned: the assertions store whole-second ISO stamps, so a
    # sub-second fix would make the round()ed lag off-by-one.
    fix_t = float(int(time.time()))
    _stub_upstreams(monkeypatch, fix_t)
    _seed(fix_t)

    r = client.get(f"/api/entity/{_LIVE}")
    assert r.status_code == 200, r.text
    body = r.json()
    # the live sensor tier is untouched by the join
    assert body["registration"] == "EI-ABC"
    assert body["kind"] == "aircraft"

    block = body["registry"]
    assert block["degraded"] is False
    assert block["tiers"] == {
        "adsb": "sensor",
        "registry:gleif": "registry",
        "sec:edgar": "filing",
        "gdelt": "claim",
        "analyst": "other",
    }

    by_prop = {a["prop"]: a for a in block["assertions"]}
    # upsert() also diffs the object's initial props into assertions
    # (source "analyst"), so the seeded props are a subset, not the whole block.
    assert {"callsign", "operator", "owner_filed", "sighting", "hunch"} <= set(by_prop)

    # Every assertion carries its provenance fields through unchanged (the
    # panel renders prop = value · observed_at · lag).
    operator = by_prop["operator"]
    assert operator["source"] == "registry:gleif"
    assert operator["value"] == "Ryanair Holdings plc"
    assert operator["confidence"] == 0.9
    assert operator["observed_at"] == _iso(fix_t + 3 * 3600)
    assert operator["derivation"] == {"note": "LEI parent"}
    assert operator["tier"] == "registry"
    # lag_s = observed_at minus the live fix time: this filing postdates the fix
    assert operator["lag_s"] == 10800
    # ... and a statement older than the fix is negative, not clamped to zero
    assert by_prop["owner_filed"]["tier"] == "filing"
    assert by_prop["owner_filed"]["lag_s"] == -21600
    assert by_prop["sighting"]["tier"] == "claim"
    assert by_prop["callsign"]["tier"] == "sensor"
    assert by_prop["callsign"]["lag_s"] == 0
    assert by_prop["hunch"]["tier"] == "other"


def test_lag_absent_without_a_live_fix(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    # No observation for the id → there is no "distance from the fix" to report.
    # Report nothing rather than a fabricated zero.
    _stub_upstreams(monkeypatch, None)
    _seed(None)

    r = client.get(f"/api/entity/{_LIVE}")
    assert r.status_code == 200, r.text
    block = r.json()["registry"]
    assert block["degraded"] is False
    assert block["assertions"]
    assert all(a["lag_s"] is None for a in block["assertions"])


def test_ontology_failure_degrades_without_losing_the_fix(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_upstreams(monkeypatch, time.time())

    def _boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("ontology db is gone")

    monkeypatch.setattr(entity, "get_registry", _boom)

    r = client.get(f"/api/entity/{_LIVE}")
    assert r.status_code == 200, r.text
    assert r.json()["registry"] == {"assertions": [], "tiers": {}, "degraded": True}
    # best-effort: the live kinematics still answer
    assert r.json()["registration"] == "EI-ABC"


def test_source_tier_prefixes() -> None:
    assert entity.source_tier("feed:ais") == "sensor"
    assert entity.source_tier("opensky-registry") == "registry"
    assert entity.source_tier("faa") == "registry"
    assert entity.source_tier("ted") == "filing"
    assert entity.source_tier("usaspending") == "filing"
    assert entity.source_tier("telegram") == "claim"
    assert entity.source_tier("hexdb.io") == "other"
    assert entity.source_tier("analyst") == "other"


def test_registry_block_rides_on_every_kind(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    # The join is appended once, after the per-kind dispatch: every branch
    # (including the sync feed path, `_enrich_feed`) must still resolve AND
    # carry the block. A feed object has no live fix → no lag, empty tiers.
    monkeypatch.setattr(entity, "store", ObservationStore())

    r = client.get("/api/entity/chokepoint:strait-of-hormuz")
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "/api/maritime/chokepoints"
    assert r.json()["registry"] == {"assertions": [], "tiers": {}, "degraded": False}
