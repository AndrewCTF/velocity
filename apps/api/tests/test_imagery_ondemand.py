"""Unit tests for app.imagery.ondemand — pure helpers, no network."""

from __future__ import annotations

from app.imagery import ondemand as O
from app.intel.geo import BBox


def test_aoi_bbox_from_center_radius() -> None:
    b = O.aoi_bbox(lat=21.97, lon=96.08, radius_km=5)
    assert b.min_lon < 96.08 < b.max_lon
    assert b.min_lat < 21.97 < b.max_lat


def test_aoi_bbox_explicit_overrides_and_normalises() -> None:
    # corners given in the "wrong" order are normalised to W/S/E/N
    b = O.aoi_bbox(bbox=(96.2, 22.1, 96.0, 21.9))
    assert b == BBox(96.0, 21.9, 96.2, 22.1)


def test_aoi_bbox_requires_inputs() -> None:
    try:
        O.aoi_bbox()
    except ValueError:
        pass
    else:  # pragma: no cover
        raise AssertionError("expected ValueError when neither bbox nor lat/lon given")


def test_bbox_overlap() -> None:
    a = BBox(0, 0, 10, 10)
    assert O._bbox_overlap(a, BBox(5, 5, 15, 15))  # overlapping
    assert not O._bbox_overlap(a, BBox(20, 20, 30, 30))  # disjoint
    assert O._bbox_overlap(a, BBox(10, 10, 11, 11))  # touching edge counts


def test_abs_href_resolution() -> None:
    parent = "https://x/events/catalog.json"
    assert O._abs_href(parent, "https://y/z.json") == "https://y/z.json"
    assert O._abs_href(parent, "./acme/collection.json") == "https://x/events/acme/collection.json"
    # one level up
    assert O._abs_href("https://x/events/acme/collection.json", "../other/c.json") == (
        "https://x/events/other/c.json"
    )


def test_to_epoch() -> None:
    assert O._to_epoch("2025-03-28") is not None
    assert O._to_epoch("2025-03-28T12:00:00Z") is not None
    assert O._to_epoch("not-a-date") is None
    assert O._to_epoch(None) is None


def test_collection_extent_parse() -> None:
    col = {
        "extent": {
            "spatial": {"bbox": [[96.0, 21.9, 96.3, 22.2]]},
            "temporal": {"interval": [["2025-03-01T00:00:00Z", "2025-04-01T00:00:00Z"]]},
        }
    }
    out = O._collection_extent(col)
    assert out is not None
    box, t0, t1 = out
    assert box == BBox(96.0, 21.9, 96.3, 22.2)
    assert t0 < t1
    assert O._collection_extent({"extent": {}}) is None


def test_item_if_match() -> None:
    aoi = BBox(96.0, 21.9, 96.3, 22.2)
    t = O._to_epoch("2025-03-28")
    assert t is not None
    item = {
        "id": "scene1",
        "bbox": [96.05, 21.95, 96.2, 22.1],
        "properties": {"datetime": "2025-03-28T03:00:00Z"},
        "assets": {"visual": {"href": "https://x/scene1.tif"}, "x": {}},
    }
    out = O._item_if_match(item, "https://x/scene1.json", aoi, t - 86400, t + 86400)
    assert out is not None
    assert out["assets"] == {"visual": "https://x/scene1.tif"}  # href-less asset dropped

    # outside the time window
    assert O._item_if_match(item, "u", aoi, t + 10 * 86400, t + 20 * 86400) is None
    # outside the AOI
    far = BBox(0, 0, 1, 1)
    assert O._item_if_match(item, "u", far, t - 86400, t + 86400) is None
    # missing fields
    assert O._item_if_match({"bbox": item["bbox"]}, "u", aoi, t - 1, t + 1) is None


def test_sentinel_size_aspect() -> None:
    wide = O._sentinel_size(BBox(0, 0, 4, 1))  # 4:1 → width capped
    assert wide[0] == 2048 and wide[1] < 2048
    tall = O._sentinel_size(BBox(0, 0, 1, 4))  # 1:4 → height capped
    assert tall[1] == 2048 and tall[0] < 2048
