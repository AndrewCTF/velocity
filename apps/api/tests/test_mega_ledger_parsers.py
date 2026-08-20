"""The four wire formats of the mega-ledger wave that are not what they look like.

Each of these shipped with a reader written against the shape somebody expected
and was empty or 500 against the shape the upstream actually serves. The fixtures
below are trimmed from live responses on 2026-08-07.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.routes import _feedgeo as fg
from app.routes import civil_defense, deepstate, mega_feeds
from app.routes import source_catalog as sc


@pytest.fixture(autouse=True)
def _no_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """`fg.cached` would serve one test's fixture to the next."""

    async def passthrough(key: str, ttl: float, load: Any) -> Any:
        return await load()

    monkeypatch.setattr(fg, "cached", passthrough)


def _json(monkeypatch: pytest.MonkeyPatch, payload: Any) -> None:
    async def fake(url: str, **kw: Any) -> Any:
        return payload

    monkeypatch.setattr(fg, "fetch_json", fake)


def _text(monkeypatch: pytest.MonkeyPatch, payload: str) -> None:
    async def fake(url: str, **kw: Any) -> str:
        return payload

    monkeypatch.setattr(fg, "fetch_text", fake)


def test_deepstate_fires_reads_positional_triples(monkeypatch: pytest.MonkeyPatch) -> None:
    """The feed is `[[lat, lon, weight], …]`, not a list of objects. Reading it
    as objects raised AttributeError and the route answered 500."""
    _json(monkeypatch, {"updated_at": 1786095902, "data": [[51.14358, 37.94635, 0.25]]})
    fc = asyncio.run(deepstate.deepstate_firms())
    assert len(fc["features"]) == 1
    f = fc["features"][0]
    assert f["geometry"]["coordinates"] == [37.94635, 51.14358]
    assert f["properties"]["weight"] == 0.25


def test_deepstate_news_takes_its_position_from_the_link(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A history entry has no lat/lon field. Its position is the map pin in the
    description, and the newest entries are at the END of the upstream list."""
    _json(
        monkeypatch,
        [
            {"id": 1, "descriptionEn": "Old, no pin.", "createdAt": "2022-04-03T00:00:00Z"},
            {
                "id": 2,
                "descriptionEn": (
                    'The enemy has advanced near <a href="https://deepstatemap.live/en'
                    '#14/48.4562458/37.2700882">Nove Shakhove</a>.'
                ),
                "createdAt": "2026-08-05T12:47:50.000Z",
            },
        ],
    )
    fc = asyncio.run(deepstate.deepstate_news(200))
    assert len(fc["features"]) == 1
    f = fc["features"][0]
    assert f["geometry"]["coordinates"] == [37.2700882, 48.4562458]
    # Markup stripped, words kept.
    assert f["properties"]["title"] == "The enemy has advanced near Nove Shakhove."


def test_kiwisdr_reads_a_js_literal_and_always_answers_a_collection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The mirror serves a JS array with a trailing comma, which json rejects,
    and `gps` is the string "(lat, lon)". Every failure path must still be a
    FeatureCollection: this route backs a map layer."""
    _text(
        monkeypatch,
        '// header\nvar kiwisdr_com =\n[\n\t{\n\t\t"id":"abc",\n\t\t"name":"Kiwi",\n'
        '\t\t"gps":"(37.669714, 140.492137)",\n\t\t"url":"http://x:8073"\n\t},\n]\n',
    )
    fc = asyncio.run(sc.kiwisdr_stations())
    assert fc["type"] == "FeatureCollection"
    assert fc["features"][0]["geometry"]["coordinates"] == [140.492137, 37.669714]

    def boom(url: str, **kw: Any) -> str:
        raise RuntimeError("upstream down")

    monkeypatch.setattr(fg, "fetch_text", boom)
    dead = asyncio.run(sc.kiwisdr_stations())
    # Still a well-formed collection, so the adapter never breaks -- but it now
    # says WHY it is empty. "No receivers here" and "we could not ask" used to be
    # the same response; see tests/test_feed_honesty.py.
    assert dead["type"] == "FeatureCollection"
    assert dead["features"] == []
    assert dead["degraded"] is True
    assert "KiwiSDR" in dead["note"]


def test_ukraine_alt_lists_only_alerting_regions(monkeypatch: pytest.MonkeyPatch) -> None:
    """The v3 relay reports only regions WITH an active alert, keyed on
    `regionName`, and it goes quiet rather than erroring when it is down."""
    _json(
        monkeypatch,
        [
            {
                "regionId": "16",
                "regionName": "Луганська область",
                "regionEngName": "Luhanska region",
                "lastUpdate": "2026-08-07T09:00:00Z",
                "activeAlerts": [{"type": "AIR"}],
            },
            {"regionName": "Nowhere oblast", "activeAlerts": [{"type": "AIR"}]},
        ],
    )
    fc = asyncio.run(civil_defense.ukraine_alerts_alt())
    assert len(fc["features"]) == 1
    p = fc["features"][0]["properties"]
    assert p["alert"] is True and p["alert_type"] == "AIR"

    def boom(url: str, **kw: Any) -> Any:
        raise RuntimeError("relay down")

    monkeypatch.setattr(fg, "fetch_json", boom)
    assert asyncio.run(civil_defense.ukraine_alerts_alt())["features"] == []


def test_every_wave_id_prefix_resolves_a_dossier() -> None:
    """Clicking a contact asks `/api/entity/<prefix>:<id>`, and the prefix a feed
    MINTS is what arrives — not its ontology kind. A prefix missing from the feed
    table 404s the dossier for every contact on that layer."""
    from app.routes import entity as entity_routes

    minted = {
        "ua_alert", "ua_siren", "fema", "spc", "ds_fire", "ds_rad", "ds_event",
        "satnogs_obs", "satnogs_stn", "sonde", "kiwisdr", "mine", "osm_mil",
        "wikimapia",
    }
    missing = sorted(minted - set(entity_routes._FEED_SOURCES))
    assert missing == [], f"id prefixes with no enrichment: {missing}"


def test_ukraine_ids_are_ascii(monkeypatch: pytest.MonkeyPatch) -> None:
    """An oblast id has to survive a URL and the ASCII-only feed id regex, so it
    is a slug and never the Cyrillic name."""
    _json(monkeypatch, [{"name": "Львівська область", "alert": True}])
    fc = asyncio.run(civil_defense.ukraine_alerts())
    fid = fc["features"][0]["id"]
    assert fid == "ua_alert:lvivska"
    assert entity_id_ok(fid)


def entity_id_ok(fid: str) -> bool:
    from app.routes.entity import FEED_ID_RE

    return bool(FEED_ID_RE.match(fid.split(":", 1)[1]))


MRDS_GML = """<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs"
   xmlns:ms="http://mapserver.gis.umn.edu/mapserver"
   xmlns:gml="http://www.opengis.net/gml">
  <gml:featureMember>
    <ms:mrds fid="mrds.92277">
      <ms:geometry><gml:Point srsName="EPSG:4326">
        <gml:coordinates>-97.997560,36.558680</gml:coordinates>
      </gml:Point></ms:geometry>
      <ms:dep_id>10094847</ms:dep_id>
      <ms:site_name>Liming Prospect</ms:site_name>
      <ms:dev_stat>Occurrence</ms:dev_stat>
      <ms:code_list> CU</ms:code_list>
    </ms:mrds>
  </gml:featureMember>
</wfs:FeatureCollection>"""


def test_mines_parse_wfs_gml(monkeypatch: pytest.MonkeyPatch) -> None:
    """MapServer refuses `application/json` for this layer, so GML is the only
    format on offer."""
    _text(monkeypatch, MRDS_GML)
    fc = asyncio.run(mega_feeds.mineral_sites(bbox="-100,35,-95,40", commodity="", limit=500))
    f = fc["features"][0]
    assert f["geometry"]["coordinates"] == [-97.99756, 36.55868]
    assert f["properties"]["name"] == "Liming Prospect"
    # The commodity filter matches the MRDS code, not a name.
    filtered = asyncio.run(
        mega_feeds.mineral_sites(bbox="-100,35,-95,40", commodity="AU", limit=500)
    )
    assert filtered["features"] == []


METEOALARM_ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <entry>
    <cap:areaDesc>Cote-d'Or</cap:areaDesc>
    <cap:event>Moderate high-temperature warning</cap:event>
    <cap:severity>Moderate</cap:severity>
    <cap:identifier>2.49.0.0.250.0.FR.20260807060038.131026</cap:identifier>
    <title>Yellow High-temperature Warning issued for France</title>
  </entry>
</feed>"""


def test_meteoalarm_reads_the_atom_feed(monkeypatch: pytest.MonkeyPatch) -> None:
    """No JSON feed exists, and a warning carries a NUTS3 area name and no
    coordinates — so this answers a list, not a FeatureCollection."""
    _text(monkeypatch, METEOALARM_ATOM)
    out = asyncio.run(civil_defense.meteoalarm(country="France"))
    assert out["country"] == "france"
    assert out["count"] == 1
    assert out["warnings"][0]["severity"] == "Moderate"
    assert "features" not in out
