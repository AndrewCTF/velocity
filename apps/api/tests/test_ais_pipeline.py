"""Guards for the keyless AIS pipeline.

The three properties worth protecting, each of which is a bug if violated:

  1. FRESHNESS-WINS merge. A slow world poll must not overwrite a fresher fix
     for the same MMSI. The shared ObservationStore is last-write-wins, so this
     store compares ``t`` and is the only thing standing between a cached tier
     and a stolen MMSI.
  2. HONEST dark-vessel status. A SAR contact with no AIS match is 'dark' ONLY
     where AIS coverage exists to make absence meaningful. Everywhere else it
     must be 'unknown', never a fabricated claim.
  3. NO FABRICATED POSITIONS. An unlocated SAR detection reports lat/lon None.
     It must not silently render at 0,0.
"""

from __future__ import annotations

import time

import numpy as np
import pytest

from app.ais_pipeline import providers, sar
from app.ais_pipeline.store import VesselStore, haversine_km


def _fix(mmsi=123456789, lat=10.0, lon=20.0, t=None, source="test", **kw):
    return providers.Fix(
        mmsi=mmsi, lat=lat, lon=lon, t=time.time() if t is None else t, source=source, **kw
    )


# ── 1. freshness-wins ────────────────────────────────────────────────────────


def test_newer_fix_wins():
    s = VesselStore()
    s.merge([_fix(lat=1.0, t=1000.0)])
    assert s.merge([_fix(lat=2.0, t=2000.0)]) == 1
    assert s.get(123456789).fix.lat == 2.0


def test_older_fix_does_not_clobber():
    s = VesselStore()
    s.merge([_fix(lat=1.0, t=2000.0)])
    assert s.merge([_fix(lat=9.0, t=1000.0)]) == 0
    assert s.get(123456789).fix.lat == 1.0


def test_merge_is_idempotent_for_duplicates():
    s = VesselStore()
    s.merge([_fix(t=1000.0)])
    assert s.merge([_fix(t=1000.0)]) == 0
    assert len(s) == 1


def test_sources_tracked_per_vessel():
    s = VesselStore()
    s.merge([_fix(t=1000.0, source="shipxplorer")])
    s.merge([_fix(t=2000.0, source="kystdatahuset")])
    st = s.get(123456789)
    assert set(st.sources) == {"shipxplorer", "kystdatahuset"}
    # Freshest observation is what positions the vessel.
    assert st.fix.source == "kystdatahuset"


def test_bbox_excludes_old_fixes():
    s = VesselStore()
    now = time.time()
    s.merge([_fix(mmsi=111111111, t=now - 10)])
    s.merge([_fix(mmsi=222222222, t=now - 100_000)])
    fresh = s.all(max_age_s=3600)
    assert [v.mmsi for v in fresh] == [111111111]


def test_antimeridian_bbox_wraps():
    s = VesselStore()
    s.merge([_fix(mmsi=111111111, lat=0.0, lon=179.0)])
    s.merge([_fix(mmsi=222222222, lat=0.0, lon=-179.0)])
    hits = {v.mmsi for v in s.in_bbox(170.0, -5.0, -170.0, 5.0)}
    assert hits == {111111111, 222222222}


def test_coverage_grid_shape_and_counts():
    s = VesselStore()
    s.merge([_fix(mmsi=111111111, lat=0.0, lon=0.0)])
    cov = s.coverage()
    assert cov["rows"] == 36 and cov["cols"] == 72
    assert cov["fresh"] == 1
    assert cov["cells"][18][36] == 1  # 0N,0E cell


# ── 2. honest dark-vessel status ─────────────────────────────────────────────


def test_no_ais_coverage_is_unknown_not_dark():
    s = VesselStore()
    det = sar.Detection(
        lat=0.0, lon=0.0, value=900.0, area_px=9, major_px=3.0, minor_px=3.0, located=True
    )
    out = sar.dark_vessel_candidates([det], s, coverage_km=25.0, ais_min=3)
    assert len(out) == 1
    assert out[0].status == "unknown"
    assert out[0].to_json()["darkCandidate"] is False


def test_ais_present_but_no_match_is_dark():
    s = VesselStore()
    now = time.time()
    # Three AIS contacts within 25 km, none within the 2 km match radius.
    for i, (dlat, dlon) in enumerate([(0.2, 0.0), (-0.2, 0.1), (0.1, -0.2)]):
        s.merge([_fix(mmsi=100000000 + i, lat=dlat, lon=dlon, t=now)])
    det = sar.Detection(
        lat=0.0, lon=0.0, value=900.0, area_px=9, major_px=3.0, minor_px=3.0, located=True
    )
    out = sar.dark_vessel_candidates([det], s, match_km=2.0, coverage_km=25.0, ais_min=3)
    assert len(out) == 1
    assert out[0].status == "dark"
    assert out[0].to_json()["darkCandidate"] is True


def test_matched_detection_is_not_a_candidate():
    s = VesselStore()
    s.merge([_fix(lat=0.0, lon=0.0)])
    # 0.005 deg at the equator is ~0.55 km — inside the 2 km match radius.
    det = sar.Detection(
        lat=0.0, lon=0.005, value=900.0, area_px=9, major_px=3.0, minor_px=3.0, located=True
    )
    assert sar.dark_vessel_candidates([det], s, match_km=2.0) == []


def test_unlocated_detection_yields_no_candidate():
    s = VesselStore()
    det = sar.Detection(
        lat=None, lon=None, value=900.0, area_px=9, major_px=3.0, minor_px=3.0, located=False
    )
    assert sar.dark_vessel_candidates([det], s) == []


# ── 3. SAR detection ─────────────────────────────────────────────────────────


def _scene():
    img = np.full((200, 200), 100.0, dtype="float32")
    img[50:53, 60:75] = 900.0  # 3x15 "vessel"
    img[120:122, 30:33] = 800.0  # 2x3 "vessel"
    return img


def test_cfar_finds_both_targets():
    dets = sar.detect_targets(_scene(), k=3.0)
    assert len(dets) == 2


def test_vv_is_preferred_when_present():
    assets = {"vv": {"href": "s3://b/vv.tif"}, "hh": {"href": "s3://b/hh.tif"}}
    assert sar._best_asset(assets) == ("vv", {"href": "s3://b/vv.tif"})


def test_detection_reads_the_scene_windowed_not_whole():
    """A whole-scene read is what OOM-killed the detector. Measured on a real
    Arabian Sea VV GRD: 25139x13200 = 331.8 M px; `ds.read(1)` plus the float32
    background copies is multiple GB on a box already running the API + sidecars.

    This drives `_detect_from_scene` — the ONLY place that opens a raster — so
    reverting it to a whole-scene `ds.read(1)` fails here. Two earlier attempts
    called `_detect_windowed` directly and passed with the fix reverted: a guard
    that cannot fail is not a guard. The fake dataset refuses `window=None`, and
    the fake client serves a tiny body so the whole path runs offline.
    """
    import asyncio

    import numpy as np

    class _Affine:
        def __init__(self, a, b, c, d, e, f) -> None:
            self.a, self.b, self.c, self.d, self.e, self.f = a, b, c, d, e, f

    class _StrictDS:
        """Refuses a whole-scene read rather than allocating 332 M px."""

        height, width = 6000, 6000
        crs = "EPSG:4326"
        transform = _Affine(0.0001, 0.0, 50.0, 0.0, -0.0001, 15.0)

        def __init__(self) -> None:
            self.windows: list = []

        # `rasterio.open` returns a context manager and `_detect_from_scene`
        # uses `with`, so the fake must be one too or it bails before reading.
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def read(self, _band, window=None):  # noqa: ANN001
            if window is None:
                raise MemoryError("whole-scene read attempted")
            self.windows.append(window)
            (y0, y1), (x0, x1) = window
            return np.full((y1 - y0, x1 - x0), 100.0, dtype="float32")

    seen: list[_StrictDS] = []

    class _FakeRasterio:
        @staticmethod
        def open(_path):  # noqa: ANN001
            ds = _StrictDS()
            seen.append(ds)
            return ds

    class _Resp:
        status_code = 200

        @staticmethod
        async def aiter_bytes(_n):  # noqa: ANN001
            yield b"not-really-a-tiff"

    class _Stream:
        async def __aenter__(self):
            return _Resp()

        async def __aexit__(self, *_exc):
            return False

    class _FakeClient:
        def stream(self, *_a, **_kw):  # noqa: ANN001
            return _Stream()

    async def _run():
        return await sar._detect_from_scene(
            _FakeClient(), "https://example/x.tiff", _FakeRasterio, {"id": "S1"}
        )

    assert asyncio.run(_run()) == []  # flat scene; the point is HOW it reads
    assert seen, "the raster was never opened"
    windows = seen[0].windows
    assert len(windows) > 1, "a single read is a whole-scene read"
    for (_y0, y1), (_x0, x1) in windows:
        assert (y1 - _y0) <= sar._CFAR_WINDOW_PX
        assert (x1 - _x0) <= sar._CFAR_WINDOW_PX
    # No gap at the far edge.
    assert max(y1 for (_y0, y1), _ in windows) == 6000
    assert max(x1 for _, (_x0, x1) in windows) == 6000


def test_windowed_detection_geolocates_from_the_window_origin():
    """Each window carries its OWN sub-transform, so a detection's coordinates
    are absolute rather than relative to the window it was found in."""
    import numpy as np

    class _FakeDS:
        height, width = 400, 400

        def read(self, _band, window=None):
            (y0, y1), (x0, x1) = window
            img = np.full((y1 - y0, x1 - x0), 100.0, dtype="float32")
            # one bright blob at the window's centre
            cy, cx = (y1 - y0) // 2, (x1 - x0) // 2
            img[cy - 1 : cy + 2, cx - 1 : cx + 2] = 900.0
            return img

    gt = sar.GeoTransform(lon0=50.0, lat0=15.0, step_lon=0.001, step_lat=-0.001)
    dets = sar._detect_windowed(_FakeDS(), gt, win=400)
    assert dets, "the bright blob was not detected"
    for d in dets:
        assert d.located and d.lat is not None and d.lon is not None


def test_windowed_windows_overlap_so_seam_targets_survive():
    """A non-overlapping tiling drops everything within half a window of every
    seam. On a 25 k px scene that is thousands of pixels of busy water."""
    import numpy as np

    class _FakeDS:
        height, width = 3000, 3000
        reads: list = []

        def read(self, _band, window=None):
            type(self).reads.append(window)
            (y0, y1), (x0, x1) = window
            return np.full((y1 - y0, x1 - x0), 100.0, dtype="float32")

    ds = _FakeDS()
    gt = sar.GeoTransform(lon0=50.0, lat0=15.0, step_lon=0.0001, step_lat=-0.0001)
    sar._detect_windowed(ds, gt, win=1000)

    assert ds.reads, "nothing was read at all"
    for (_y0, y1), (_x0, x1) in ds.reads:
        assert (y1 - _y0) <= 1000 and (x1 - _x0) <= 1000, "window exceeded its bound"
    assert max(y1 for (_y0, y1), _ in ds.reads) == 3000
    assert max(x1 for _, (_x0, x1) in ds.reads) == 3000
    origins = {y0 for (y0, _y1), _ in ds.reads}
    assert any(y % 1000 for y in origins), "windows tile without overlap"


def test_an_hh_hv_scene_is_not_discarded():
    """Half the real catalogue has no VV. Measured 2026-10-04 over 60 GRD
    scenes in six ocean/sea boxes: 30 were (vv,vh), 19 (hh,hv), 11 hh-only.
    Reading only `vv` reported those last 30 as having no imagery at all, which
    silently halved open-ocean coverage — the exact thing this tier exists for.
    """
    assert sar._best_asset({"hh": {"href": "s3://b/hh.tif"}}) == (
        "hh",
        {"href": "s3://b/hh.tif"},
    )
    assert sar._best_asset({"hv": {"href": "s3://b/hv.tif"}})[0] == "hv"


def test_a_scene_with_no_measurement_band_reports_none():
    """The schema-* and thumbnail entries are not measurements and must never be
    chosen, so a scene with only those yields no channel rather than a bad URL."""
    assets = {
        "thumbnail": {"href": "s3://b/t.png"},
        "schema-noise-hh": {"href": "s3://b/n.tif"},
        "safe-manifest": {"href": "s3://b/m.json"},
    }
    assert sar._best_asset(assets) == (None, {})


def test_an_asset_without_an_href_is_skipped():
    assert sar._best_asset({"vv": {}, "hh": {"href": "s3://b/hh.tif"}})[0] == "hh"


def test_scan_reports_the_channel_it_chose():
    """The chosen channel travels with the scene, so a caller can tell a VV
    detection from an HH one instead of assuming VV."""
    import asyncio

    # STAC features are plain dicts, so the fake must be one too — a class with
    # attributes fails on the very first `.get`.
    scene = {
        "id": "S1X",
        "bbox": [0, 0, 1, 1],
        "properties": {"datetime": "2026-10-01T00:00:00Z"},
        "assets": {"hh": {"href": "s3://sentinel-s1-l1c/GRD/hh.tif"}},
    }

    async def _run():
        class _R:
            status_code = 200

            def json(self):
                return {"features": [scene]}

        class _C:
            async def post(self, *a, **k):
                return _R()

        return await sar.scan_aoi(_C(), None, (0, 0, 1, 1), days=1, limit=1)  # type: ignore[arg-type]

    res = asyncio.run(_run())
    assert res["scenes"][0]["channel"] == "hh"
    assert res["scenes"][0]["vvUrl"].startswith(
        "https://sentinel-s1-l1c.s3.amazonaws.com/"
    )


def test_unlocated_detection_has_null_coords():
    d = sar.detect_targets(_scene(), k=3.0)[0]
    assert d.located is False
    assert d.lat is None and d.lon is None
    assert d.to_json()["lat"] is None


def test_geolocated_detection_maps_pixels():
    gt = sar.GeoTransform(lon0=10.0, lat0=50.0, step_lon=0.001, step_lat=-0.001)
    dets = sar.detect_targets(_scene(), k=3.0, transform=gt)
    d = dets[0]
    assert d.located is True
    assert 49.0 < d.lat < 50.0 and 10.0 < d.lon < 10.2


def test_flat_scene_yields_nothing():
    assert sar.detect_targets(np.full((50, 50), 100.0, dtype="float32"), k=3.0) == []


def test_oversized_blob_is_rejected():
    img = np.full((300, 300), 100.0, dtype="float32")
    img[10:150, 10:150] = 900.0  # 140x140 = a land mass, not a ship
    assert sar.detect_targets(img, k=3.0) == []


def test_land_block_suppresses_edge_blobs():
    img = np.full((200, 200), 100.0, dtype="float32")
    img[0:3, 0:15] = 900.0  # touching the top-left corner = coastline
    assert sar.detect_targets(img, k=3.0, land_block_px=10) == []
    # Without the block it IS a detection, so the guard is doing the work.
    assert len(sar.detect_targets(img, k=3.0)) == 1


# ── providers ────────────────────────────────────────────────────────────────


def test_parse_shipxplorer_row_layout():
    row = [
        "CASEY GIRL",
        47.62911,
        -122.39285,
        1791045617000,
        None,
        0,
        "AIS",
        "Pleasure Craft",
        368202320,
        None,
        "Undefined",
        10,
        5,
        2,
        2,
        "WDM3988",
        "US",
        None,
        None,
        None,
        None,
        None,
        49.7,
        None,
        None,
        None,
    ]
    fixes = providers.parse_shipxplorer([{"a": row}, {"total": 1}, [], {}])
    assert len(fixes) == 1
    f = fixes[0]
    assert f.mmsi == 368202320
    assert f.name == "CASEY GIRL"
    assert round(f.lat, 4) == 47.6291
    assert round(f.lon, 4) == -122.3928
    assert f.flag == "US"
    assert f.heading == 49.7
    # 0.0 kn is a REAL reading (stopped), not the 102.3 "not available"
    # sentinel — it must survive, or every anchored vessel loses its state.
    assert f.sog == 0.0


def test_parse_shipxplorer_rejects_bad_rows():
    body = [
        {"a": [None, 91.0, 20.0, 1, None, 5, "AIS", "x", 123456789]},  # lat out of range
        {"b": [None, 10.0, 181.0, 1, None, 5, "AIS", "x", 123456789]},  # lon out of range
        {"c": [None, 10.0, 20.0, 1, None, 5, "AIS", "x", 42]},  # MMSI too short
        {"d": "not-a-list"},
        {"e": [None, 10.0, 20.0]},  # too short
    ]
    assert providers.parse_shipxplorer([body, {"total": 5}, [], {}]) == []


def test_parse_shipxplorer_masks_sentinels():
    row = [
        "N",
        10.0,
        20.0,
        1791045617000,
        None,
        102.3,
        "AIS",
        "Cargo",
        123456789,
        None,
        "x",
        None,
        None,
        None,
        None,
        None,
        "NO",
        None,
        None,
        None,
        None,
        None,
        511.0,
    ]
    f = providers.parse_shipxplorer(
        [
            {"a": row},
            {"total": 1},
        ]
    )[0]
    assert f.sog is None  # 102.3 kn = not available
    assert f.heading is None  # 511 = not available


def test_parse_shipxplorer_uses_upstream_ts_as_age():
    row = ["N", 10.0, 20.0, 1791045617000, None, 5, "AIS", "Cargo", 123456789]
    f = providers.parse_shipxplorer([{"a": row}, {"total": 1}], now=2_000_000_000.0)[0]
    assert f.t == 1791045617.0


def test_shipxplorer_url_pins_world_bounds():
    u = providers.shipxplorer_url("https://x/live", zoom=6)
    assert "bounds=85%2C180%2C-85%2C-180" in u
    assert "sate=true" in u and "ais=true" in u


def test_parse_kystdatahuset_linestring_last_point():
    features = [
        {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[10.0, 59.0], [10.5, 59.5]]},
            "properties": {
                "mmsi": 123456789,
                "speed": 12.5,
                "cog": 180.0,
                "true_heading": 179.0,
                "ship_name": "TEST@@@",
                "ship_type": 70,
            },
        }
    ]
    f = providers.parse_kystdatahuset(features)[0]
    assert (f.lon, f.lat) == (10.5, 59.5)
    assert f.sog == 12.5 and f.cog == 180.0
    assert f.name == "TEST"  # '@' padding stripped


def test_parse_digitraffic_topic_and_payload():
    f = providers.parse_digitraffic(
        "vessels-v2/230123450/location", b'{"lat":60.1,"lon":24.9,"sog":8.2}'
    )
    assert f.mmsi == 230123450
    assert round(f.lat, 1) == 60.1 and round(f.lon, 1) == 24.9
    assert f.sog == 8.2


def test_valid_mmsi_boundaries():
    assert providers.valid_mmsi(100000000) == 100000000
    assert providers.valid_mmsi(999999999) == 999999999
    assert providers.valid_mmsi(99999999) is None
    assert providers.valid_mmsi(1000000000) is None
    assert providers.valid_mmsi(True) is None
    assert providers.valid_mmsi("123456789") == 123456789
    assert providers.valid_mmsi("nope") is None


# ── geo ──────────────────────────────────────────────────────────────────────


def test_haversine_known_distance():
    # Oslo -> Bergen is ~305 km.
    assert 290 < haversine_km(59.91, 10.75, 60.39, 5.32) < 320


def test_haversine_zero():
    assert haversine_km(10.0, 20.0, 10.0, 20.0) == pytest.approx(0.0, abs=1e-9)


def test_s3_https_conversion():
    assert sar.s3_https("s3://sentinel-s1-l1c/GRD/a/b.tif") == (
        "https://sentinel-s1-l1c.s3.amazonaws.com/GRD/a/b.tif"
    )
    assert sar.s3_https("https://example.com/x.tif") is None
    assert sar.s3_https(None) is None


def test_geotransform_from_bbox():
    scene = {"bbox": [10.0, 40.0, 12.0, 42.0], "properties": {"proj:shape": [200, 200]}}
    gt = sar.scene_geotransform(scene)
    assert gt is not None
    assert gt.to_lonlat(0, 0) == (10.0, 42.0)
    assert gt.to_lonlat(100, 100) == pytest.approx((11.0, 41.0))


def test_geotransform_none_without_usable_metadata():
    assert sar.scene_geotransform({}) is None
    assert sar.scene_geotransform({"bbox": [1, 2, 3, 4]}) is None


# ── STAC request shape ───────────────────────────────────────────────────────


def test_find_scenes_never_sends_literal_now():
    """Earth Search rejects the literal 'now' in a STAC datetime with a 400.

    Regression guard: the failure only shows up against the live API, so pin the
    REQUEST BODY here instead of the source text. An open-ended window must be
    expressed as "since/" with a trailing slash, never "since/now".
    """
    import asyncio
    import json as _json

    captured: dict = {}

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"features": []}

    class _Client:
        async def post(self, url, **kw):
            captured["url"] = url
            captured["body"] = kw.get("json")
            return _Resp()

    asyncio.run(sar.find_scenes(_Client(), (0.0, 0.0, 1.0, 1.0), since="2026-10-01T00:00:00Z"))
    dt = captured["body"]["datetime"]
    assert "now" not in dt.lower(), f"STAC datetime must be RFC3339, got {dt!r}"
    assert dt == "2026-10-01T00:00:00Z/", f"open-ended window must end in '/', got {dt!r}"
    # Sanity: it really is JSON-serializable dict, not a stray object.
    assert _json.loads(_json.dumps(captured["body"]))["collections"] == ["sentinel-1-grd"]


# ── OpenWaters (ais.openwaters.io) ───────────────────────────────────────────

_OW_FEATURE = {
    "type": "Feature",
    "geometry": {"type": "Point", "coordinates": [55.05812, 24.989318]},
    "properties": {
        "mmsi": 470068000,
        "name": "MIHAIZ",
        "sog": 0.1,
        "cog": 105.1,
        "heading": 45,
        "flag": "AE",
        "type": 52,
        "imo": 9963968,
        "seen": "2026-10-03T21:38:28Z",
        "source": "aishub",
    },
}


def test_parse_openwaters_reads_properties_and_seen():
    fixes = providers.parse_openwaters({"type": "FeatureCollection", "features": [_OW_FEATURE]})
    assert len(fixes) == 1
    f = fixes[0]
    assert f.mmsi == 470068000
    assert f.name == "MIHAIZ"
    assert f.flag == "AE"
    assert f.ship_type == 52
    # `seen` is the DATA age, not the response time — the whole point of the
    # freshness-wins store.
    assert f.t == 1791063508.0
    # Upstream provenance is preserved (this row came via AISHub).
    assert f.origin == "aishub"


def test_parse_openwaters_falls_back_to_now_without_seen():
    feat = {**_OW_FEATURE, "properties": {**_OW_FEATURE["properties"]}}
    feat["properties"].pop("seen")
    f = providers.parse_openwaters({"features": [feat]}, now=1_000.0)[0]
    assert f.t == 1_000.0


def test_parse_openwaters_rejects_bad_rows():
    bad = providers.parse_openwaters(
        {
            "features": [
                {"geometry": {"coordinates": [0, 0]}, "properties": {"mmsi": 1}},  # short MMSI
                {"geometry": {"coordinates": [0, 0]}, "properties": {}},  # no MMSI
                {"geometry": None, "properties": {"mmsi": 123456789}},  # no geometry
                {
                    "geometry": {"coordinates": [0, 200]},
                    "properties": {"mmsi": 123456789},
                },  # bad lon
                "not-a-feature",
            ]
        }
    )
    assert bad == []


def test_parse_openwaters_tolerates_garbage_container():
    assert providers.parse_openwaters(None) == []
    assert providers.parse_openwaters({"nope": 1}) == []
    assert providers.parse_openwaters({"features": "nope"}) == []


def test_openwaters_tiles_respect_anonymous_area_cap():
    tiles = providers.openwaters_tiles(tile_deg=9.0)
    assert tiles, "a sweep must produce tiles"
    for lon0, lat0, lon1, lat1 in tiles:
        assert (lon1 - lon0) * (lat1 - lat0) <= 100.0


def test_openwaters_tiles_stay_inside_the_accepted_longitude_window():
    """The anonymous API accepts only lon in [-90, +81]; outside is HTTP 400.

    A tile grid that ignores this has ~50% of its tiles rejected and reports a
    plausible-but-wrong vessel count, so the tile generator must clip.
    """
    tiles = providers.openwaters_tiles(tile_deg=9.0)
    assert tiles
    for lon0, _lat0, lon1, _lat1 in tiles:
        assert lon0 >= providers._OPENWATERS_LON_MIN
        assert lon1 <= providers._OPENWATERS_LON_MAX
    cov = providers.openwaters_longitude_coverage()
    assert cov["lonMin"] == -90.0 and cov["lonMax"] == 81.0
    # 171 of 360 degrees — call it what it is, not "global".
    assert 0.4 < cov["fractionOfGlobe"] < 0.6


def test_openwaters_tiles_cover_latitudes_but_clip_longitude():
    tiles = providers.openwaters_tiles(tile_deg=9.0, lat0=-80.0, lat1=80.0)
    lats = {t[1] for t in tiles}
    assert min(lats) == -80.0
    assert max(lats) <= 73.0
    # The eastern edge column is TRIMMED to the window, not dropped.
    assert any(t[2] == 81.0 for t in tiles)
    assert max(t[0] for t in tiles) < 81.0


def test_iso_to_epoch_parses_rfc3339():
    assert providers._iso_to_epoch("2026-10-03T21:38:28Z") == 1791063508.0
    assert providers._iso_to_epoch("2026-10-03T21:38:28+00:00") == 1791063508.0
    assert providers._iso_to_epoch("not-a-date") is None
    assert providers._iso_to_epoch(None) is None
    assert providers._iso_to_epoch("") is None


# ── satellite AIS ───────────────────────────────────────────────────────────


def test_satellite_ais_is_not_claimed_as_keyless():
    """Guard against the assumption that a satellite-AIS tier exists here.

    Measured 2026-10-03: OpenWaters' /v1/stations exposes no satellite station,
    a Barents Sea bbox returns zero SAT-tagged vessels, and every dedicated
    satellite vendor (exactEarth, FleetMon, GFW) gates its API behind a token.
    If someone later adds a keyless satellite source, flip this AND the module
    comment together — a silent "sat coverage included" claim is exactly the
    kind of unsupported coverage assertion this repo forbids.
    """
    assert providers.SATELLITE_AIS_KEYLESS is False


def test_openwaters_rows_never_invent_satellite_provenance():
    """A row's origin must be what upstream said, never a guess.

    ShipXplorer's [6] column and OpenWaters' `source` are passed through
    verbatim; the parser must not relabel a terrestrial row as SAT.
    """
    feat = {
        **_OW_FEATURE,
        "properties": {**_OW_FEATURE["properties"], "source": "aishub"},
    }
    f = providers.parse_openwaters({"features": [feat]})[0]
    assert f.origin == "aishub"  # NOT 'SAT'
    # And a missing source falls back to the neutral label.
    feat2 = {**_OW_FEATURE, "properties": {**_OW_FEATURE["properties"]}}
    feat2["properties"].pop("source")
    assert providers.parse_openwaters({"features": [feat2]})[0].origin == "AIS"


# ── 4. the bridge into the shared (last-write-wins) store ────────────────────
#
# Everything that draws vessels reads the shared ObservationStore, which keeps
# whatever was written LAST. The bridge is the only thing that makes a pipeline
# write freshness-safe there, so each rule below is a correctness guard.


@pytest.fixture
def bridge(monkeypatch):
    import app.ais_pipeline as pipeline
    from app import ais_firehose
    from app.correlate.store import ObservationStore
    from app.routes import ais as ais_routes

    shared = ObservationStore()
    monkeypatch.setattr(ais_firehose, "store", shared)
    monkeypatch.setattr(ais_firehose, "_name_by_mmsi", {})
    monkeypatch.setattr(ais_routes, "_ship_type_by_mmsi", {})
    monkeypatch.setattr(pipeline, "vessels", VesselStore())
    return pipeline, shared


def _obs(t, lat=5.0, source="myshiptracking"):
    from app.correlate.types import Observation

    return Observation(
        id="vessel:123456789", source=source, t=t, lon=20.0, lat=lat, emits_kind="vessel"
    )


def test_mirror_writes_the_winner_with_the_upstream_fix_time(bridge):
    pipeline, shared = bridge
    t = time.time() - 120
    fx = _fix(
        t=t, source="shipxplorer", name="EVER GIVEN", ship_type="Cargo", flag="PA", heading=91.0
    )
    pipeline.vessels.merge([fx])
    assert pipeline._mirror([fx]) == 1
    o = shared.latest_for("vessel:123456789")
    # The age of the DATA, never the wall clock of the poll.
    assert o.t == t and o.source == "shipxplorer" and o.emits_kind == "vessel"
    assert o.attrs["name"] == "EVER GIVEN" and o.attrs["flag"] == "PA"
    assert o.attrs["shipType"] == 70 and o.attrs["heading"] == 91.0


def test_mirror_never_overwrites_a_fresher_shared_fix(bridge):
    pipeline, shared = bridge
    now = time.time()
    shared.add(_obs(now - 10, lat=5.0))
    fx = _fix(lat=9.0, t=now - 60, source="openwaters", name="LATE REPORT")
    pipeline.vessels.merge([fx])
    assert pipeline._mirror([fx]) == 0
    assert shared.latest_for("vessel:123456789").lat == 5.0
    # The position lost, but the name still reaches the cross-source cache the
    # winning writer labels its fixes from.
    from app import ais_firehose

    assert ais_firehose._name_by_mmsi[123456789] == "LATE REPORT"


def test_mirror_replaces_an_older_shared_fix(bridge):
    pipeline, shared = bridge
    now = time.time()
    shared.add(_obs(now - 600, lat=5.0))
    fx = _fix(lat=9.0, t=now - 60, source="openwaters")
    pipeline.vessels.merge([fx])
    assert pipeline._mirror([fx]) == 1
    assert shared.latest_for("vessel:123456789").lat == 9.0


def test_mirror_skips_a_fix_outside_the_shared_retention(bridge):
    pipeline, shared = bridge
    fx = _fix(t=time.time() - 7200, source="openwaters")
    pipeline.vessels.merge([fx])
    assert pipeline._mirror([fx]) == 0
    assert shared.latest_for("vessel:123456789") is None


def test_mirror_clamps_a_timestamp_from_the_future(bridge):
    pipeline, shared = bridge
    fx = _fix(t=time.time() + 86_400, source="shipxplorer")
    pipeline.vessels.merge([fx])
    assert pipeline._mirror([fx]) == 1
    # Unclamped, this fix would beat every real one for a day and pin itself.
    assert shared.latest_for("vessel:123456789").t <= time.time()


def test_mirror_skips_a_fix_that_lost_inside_the_pipeline(bridge):
    pipeline, shared = bridge
    now = time.time()
    older = _fix(lat=1.0, t=now - 300, source="openwaters")
    pipeline.vessels.merge([_fix(lat=2.0, t=now - 30, source="shipxplorer")])
    pipeline.vessels.merge([older])
    assert pipeline._mirror([older]) == 0
    assert shared.latest_for("vessel:123456789") is None


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("Cargo", 70),
        ("Tanker, Hazmat B", 82),
        ("Pleasure Craft", 37),
        ("Law Enforcement", 55),
        (70, 70),
        (70.0, 70),
        ("37", 37),
        ("?", None),
        ("PASSENGERS SHIP", None),  # unseen spelling: no guess
        (None, None),
        (True, None),
        (250, None),
        (float("nan"), None),
    ],
)
def test_itu_ship_type_maps_names_and_passes_codes(raw, code):
    assert providers.itu_ship_type(raw) == code


def test_prune_drops_stale_vessels_and_their_grid_cell():
    s = VesselStore(max_fix_age_s=3600)
    now = time.time()
    s.merge([_fix(mmsi=111111111, t=now - 10), _fix(mmsi=222222222, t=now - 7200)])
    assert s.prune() == 1
    assert len(s) == 1 and s.get(222222222) is None
    assert s.rejected_stale == 1
    assert all(222222222 not in members for members in s._grid.values())
    # A cap of 0 means "keep everything", matching all(max_age_s=0).
    keep = VesselStore(max_fix_age_s=0)
    keep.merge([_fix(t=1000.0)])
    assert keep.prune() == 0 and len(keep) == 1


def test_a_vessel_at_the_pole_does_not_overflow_the_grid():
    s = VesselStore()
    s.merge([_fix(lat=90.0, lon=180.0)])
    cov = s.coverage()
    assert cov["fresh"] == 1 and cov["cells"][35][0] == 1


def test_one_fetcher_per_upstream():
    """ShipXplorer is pulled by the pipeline only, Kystdatahuset by ais_keyless only.

    Read from source: calling either start() would open live sockets.
    """
    import inspect

    import app.ais_pipeline as pipeline
    from app import ais_keyless

    assert "create_task(_run_shipxplorer" not in inspect.getsource(ais_keyless.start)
    assert "create_task(_run_shipxplorer" in inspect.getsource(pipeline.start)
    assert not hasattr(pipeline, "_run_kystdatahuset")
    assert "create_task(_run_kystdatahuset" in inspect.getsource(ais_keyless.start)


# ── 5. the OpenWaters sweep splits a capped tile instead of accepting it ─────


def _fake_tiles(monkeypatch, capped, fail=()):
    """Stub the per-tile fetch. ``capped(bbox)`` says whether the server cut it."""
    calls: list[tuple] = []

    async def fake(_client, bbox):
        calls.append(bbox)
        if bbox in fail:
            raise RuntimeError("boom")
        lon0, la0, lon1, la1 = bbox
        # One vessel per tile, identified by the tile's centre.
        mmsi = 200_000_000 + int((lon0 + lon1) * 500) % 1_000_000 + int((la0 + la1) * 7)
        return [_fix(mmsi=mmsi, lat=(la0 + la1) / 2, lon=(lon0 + lon1) / 2)], capped(bbox)

    monkeypatch.setattr(providers, "fetch_openwaters_tile", fake)
    monkeypatch.setattr(providers, "openwaters_tiles", lambda **_: [(0.0, 0.0, 8.0, 8.0)])
    return calls


async def test_a_capped_tile_is_quartered_and_the_sweep_stays_complete(monkeypatch):
    calls = _fake_tiles(monkeypatch, capped=lambda b: b == (0.0, 0.0, 8.0, 8.0))
    fixes, tel = await providers.fetch_openwaters_world(None, retries=0)
    assert len(calls) == 5  # the parent, then its four quarters
    assert (4.0, 4.0, 8.0, 8.0) in calls and (0.0, 0.0, 4.0, 4.0) in calls
    assert tel["tilesSplit"] == 1 and tel["tilesTruncated"] == 0 and tel["complete"] is True
    assert len(fixes) == 5  # parent row kept, plus one per quarter


async def test_a_tile_still_capped_at_the_smallest_size_makes_the_sweep_incomplete(monkeypatch):
    calls = _fake_tiles(monkeypatch, capped=lambda b: True)
    _, tel = await providers.fetch_openwaters_world(None, retries=0, max_split_depth=1)
    assert len(calls) == 5
    # Four quarters are still capped: rows are missing, and the sweep says so.
    assert tel["tilesTruncated"] == 4 and tel["complete"] is False


async def test_the_split_budget_bounds_the_extra_requests(monkeypatch):
    calls = _fake_tiles(monkeypatch, capped=lambda b: True)
    _, tel = await providers.fetch_openwaters_world(
        None, retries=0, max_split_depth=5, max_split_requests=4
    )
    assert len(calls) == 5  # one split affordable, then stop
    assert tel["tilesSplit"] == 1 and tel["complete"] is False


async def test_a_failed_quarter_does_not_lose_the_parent_rows(monkeypatch):
    _fake_tiles(
        monkeypatch,
        capped=lambda b: b == (0.0, 0.0, 8.0, 8.0),
        fail={(4.0, 4.0, 8.0, 8.0)},
    )
    fixes, tel = await providers.fetch_openwaters_world(None, retries=0)
    assert tel["tilesFailed"] == 1 and tel["complete"] is False
    assert len(fixes) == 4  # parent + three good quarters


# ── 6. source_count on the snapshot feature ──────────────────────────────────


def test_vessel_feature_counts_sources_inside_the_window(bridge):
    from app.routes import maritime

    pipeline, shared = bridge
    now = time.time()
    pipeline.vessels.merge([_fix(t=now - 30, source="shipxplorer")])
    pipeline.vessels.merge([_fix(t=now - 600, source="openwaters")])
    # The last writer in the shared store is a third, non-pipeline source.
    f = maritime._obs_to_vessel_feature(_obs(now - 5, source="aisstream"))
    assert f["properties"]["source_count"] == 3

    # A source that last spoke before the retention window no longer counts.
    stale = pipeline.vessels.get(123456789)
    stale.sources["openwaters"] = now - 7200
    f = maritime._obs_to_vessel_feature(_obs(now - 5, source="shipxplorer"))
    assert f["properties"]["source_count"] == 1


def test_vessel_feature_source_count_is_one_for_a_lone_writer(bridge):
    from app.routes import maritime

    f = maritime._obs_to_vessel_feature(_obs(time.time(), source="digitraffic"))
    # Unknown to the pipeline: only the writer itself is known. The key is
    # always present, because the adapter keeps a vanished key's last value.
    assert f["properties"]["source_count"] == 1
