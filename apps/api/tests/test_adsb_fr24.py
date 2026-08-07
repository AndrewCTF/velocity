"""The FR24 tier: positional-row decoding, the world grid, and the union wiring.

Every field here is an ARRAY INDEX into somebody else's undocumented response.
A shifted index is silent — the aircraft still render, at the wrong altitude,
with the vertical rate as the ground flag — so the row below is a real response
row captured 2026-08-07 and each index is asserted by name.
"""

from __future__ import annotations

import time

from app import adsb_fr24
from app.routes import adsb as adsb_routes

# hex, lat, lon, track, alt ft, gs kt, squawk, radar, type, reg, epoch,
# origin, dest, flight no, on-ground, vertical rate, callsign, …
ROW = [
    "a6bf5a", 54.79, -132.65, 133, 37000, 440, "1234", "T-F-EGLL1", "B738",
    "N534AS", 1786102730, "SEA", "ANC", "AS98", 0, -64, "ASA98", 0, "ASA",
]


def test_row_decodes_by_name_not_by_luck() -> None:
    ac = adsb_fr24.parse_feed({"2f1a3b": ROW}, now=1786102734.0)
    assert len(ac) == 1
    a = ac[0]
    assert a["hex"] == "a6bf5a"
    assert (a["lat"], a["lon"]) == (54.79, -132.65)
    assert a["track"] == 133.0
    assert a["alt_baro"] == 37000  # index 4, not the vertical rate at 15
    assert a["gs"] == 440.0
    assert a["t"] == "B738"
    assert a["r"] == "N534AS"
    assert a["flight"] == "ASA98"  # index 16, the callsign, not "AS98" at 13
    assert a["squawk"] == "1234"
    # Index 10 is the position epoch: 4 s before the pull.
    assert abs(a["seen_pos"] - 4.0) < 0.01


def test_on_ground_is_index_14() -> None:
    row = list(ROW)
    row[14] = 1
    a = adsb_fr24.parse_feed({"k": row})[0]
    assert a["alt_baro"] == "ground"


def test_a_row_with_no_position_time_is_stale_not_fresh() -> None:
    """A missing epoch must lose the freshest-wins union, never win it. Stamping
    it `now` is how a cached tier becomes immortal (docs/decisions.md 2026-07-15)."""
    row = list(ROW)
    row[10] = None
    a = adsb_fr24.parse_feed({"k": row})[0]
    assert a["seen_pos"] > 1e8


def test_rows_without_an_icao_address_are_dropped() -> None:
    """FLARM and satellite tracks carry an empty address. They cannot be deduped
    against any other tier, so they are dropped rather than minted under an id
    nothing would match."""
    glider = list(ROW)
    glider[0] = ""
    assert adsb_fr24.parse_feed({"k": glider}) == []
    short = list(ROW)
    short[0] = "abc"
    assert adsb_fr24.parse_feed({"k": short}) == []


def test_envelope_keys_are_not_aircraft() -> None:
    ac = adsb_fr24.parse_feed({"full_count": 20683, "version": 4, "stats": {}, "k": ROW})
    assert len(ac) == 1


def test_world_grid_covers_the_world_and_splits_the_busy_parts() -> None:
    boxes = adsb_fr24.world_grid()
    # Every box is north-of-south and west-of-east, in the order FR24 wants.
    for north, west, south, east in boxes:
        assert north > south and east > west
    # Europe is subdivided (a 30-degree box there saturates the 1500-row cap).
    over_london = [b for b in boxes if b[2] <= 51.5 <= b[0] and b[1] <= -0.1 <= b[3]]
    assert over_london, "no box covers London"
    assert min(b[0] - b[2] for b in over_london) <= 15.0
    # The mid-Pacific is not, and is still covered.
    assert any(b[2] <= 0 <= b[0] and b[1] <= -160 <= b[3] for b in boxes)


def test_the_tier_survives_sidecar_only_mode(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """`adsb_sidecar_only` sheds the multi-MB mirror pulls on a starved box. The
    FR24 tier is ~100 small requests with a trivial parse, so it is NOT that
    load — and gating it on that flag meant the deployment that most needs the
    extra coverage was the one that never got it. Only its own flag stops it."""
    from app.config import get_settings

    base = get_settings()
    for sidecar_only in (False, True):
        monkeypatch.setattr(
            "app.routes.adsb.get_settings",
            lambda so=sidecar_only: base.model_copy(
                update={"adsb_sidecar_only": so, "adsb_fr24_enabled": True}
            ),
        )
        assert adsb_routes.FR24_FEED_KEY in adsb_routes._feed_urls(), sidecar_only
    monkeypatch.setattr(
        "app.routes.adsb.get_settings",
        lambda: base.model_copy(update={"adsb_fr24_enabled": False}),
    )
    assert adsb_routes.FR24_FEED_KEY not in adsb_routes._feed_urls()
    # Slower than the readsb mirrors: one pull is ~100 requests to somebody's
    # map backend, not one document fetch.
    assert adsb_routes._feed_interval(adsb_routes.FR24_FEED_KEY) >= 10.0


def test_parse_is_cheap_enough_for_the_cadence() -> None:
    payload = {str(i): ROW for i in range(3000)}
    t0 = time.perf_counter()
    ac = adsb_fr24.parse_feed(payload)
    # parse_feed does not dedupe — fetch_world does, across boxes.
    assert len(ac) == 3000
    assert time.perf_counter() - t0 < 1.0
