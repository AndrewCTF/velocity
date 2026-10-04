"""Keyless Google Earth 3D (`app/rocktree.py`, `/tiles/g3d`).

Synthetic protobuf only — the suite never talks to Google. What is pinned:
the wire decode, the sphere → WGS84 frame, the texture V direction, the
no-holes rule (a partly refined parent keeps a leaf for its other octants),
and that the route is dark unless the operator opted in.
"""

from __future__ import annotations

import json
import struct

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import rocktree as rt
from app.config import Settings, get_settings
from app.main import app

# ── a ten-line protobuf writer, so the fixtures read as the format does ──


def _vint(n: int) -> bytes:
    out = bytearray()
    while True:
        out.append(n & 0x7F | (0x80 if n > 0x7F else 0))
        n >>= 7
        if not n:
            return bytes(out)


def _f(num: int, value: int | bytes, wire: int | None = None) -> bytes:
    if isinstance(value, int):
        return _vint(num << 3) + _vint(value)
    if wire in (1, 5):
        return _vint(num << 3 | wire) + value
    return _vint(num << 3 | 2) + _vint(len(value)) + value


def _path_and_flags(path: str, flags: int) -> int:
    digits = sum(int(d) << 3 * i for i, d in enumerate(path))
    return (flags << 3 * len(path) | digits) << 2 | len(path) - 1


def _node_meta(path: str, flags: int = 0) -> bytes:
    obb = struct.pack("<3h3B3H", 1, 2, 3, 10, 10, 10, 0, 0, 0)
    return _f(1, _f(1, _path_and_flags(path, flags)) + _f(3, obb))


def _bulk(*nodes: bytes) -> rt.Bulk:
    return rt.parse_bulk(
        b"".join(nodes)
        + _f(2, _f(1, b"") + _f(2, 900))
        + _f(3, np.array([6371010.0, 0.0, 0.0]).tobytes())
        + _f(4, np.array([8.0, 4.0, 2.0, 1.0], dtype="<f4").tobytes())
        + _f(6, 1)
    )


def _node_data(octants: tuple[int, int] = (0, 0), with_uv_scale: bool = False) -> bytes:
    """Two triangles on four vertices; `octants` assigns each triangle's octant."""
    verts = np.array([[0, 10, 0, 10], [0, 0, 10, 10], [0, 0, 0, 0]], dtype=np.uint8)
    deltas = np.diff(np.c_[np.zeros((3, 1), dtype=np.uint8), verts], axis=1).astype(np.uint8)
    uv = np.array([[0, 255, 0, 255], [0, 0, 255, 255]], dtype=np.int64)
    d = (np.diff(np.c_[np.zeros((2, 1), dtype=np.int64), uv], axis=1) % 256).astype(np.uint8)
    texcoords = struct.pack("<2H", 255, 255) + d[0].tobytes() + d[1].tobytes() + bytes(8)
    # strip 0,1,2 then 1,3,2 as a second strip run → two triangles
    strip = [0, 1, 2, 2, 1, 1, 3, 2]
    packed, zeros = bytearray(_vint(len(strip))), 0
    for idx in strip:
        val = zeros - idx
        packed += _vint(val)
        zeros += val == 0
    runs = [0] * 8
    runs[octants[0]] += 3
    runs[octants[1]] += 5
    mesh = (
        _f(1, deltas.tobytes())
        + _f(7, texcoords)
        + _f(3, bytes(packed))
        + _f(8, _vint(8) + b"".join(_vint(r) for r in runs))
        + _f(6, _f(1, b"\xff\xd8\xff-not-a-real-jpeg") + _f(2, 1))
    )
    if with_uv_scale:
        mesh += _f(10, np.array([0.0, 0.0, 1 / 256, 1 / 256], dtype="<f4").tobytes())
    matrix = np.eye(4)
    matrix[:3, 3] = [6371010.0 + 100.0, 0.0, 0.0]  # 100 m up, lat 0 lon 0
    return _f(1, matrix.T.tobytes()) + _f(2, mesh)


def _gltf(glb: bytes) -> dict:
    magic, version, total = struct.unpack_from("<4sII", glb, 0)
    assert (magic, version, total) == (b"glTF", 2, len(glb))
    size = struct.unpack_from("<I", glb, 12)[0]
    return json.loads(glb[20 : 20 + size])


# ── decode ──


def test_bulk_paths_flags_and_defaults() -> None:
    b = _bulk(_node_meta("305", flags=16), _node_meta("7"))
    assert set(b.nodes) == {"305", "7"}
    assert b.nodes["305"].flags == 16 and b.nodes["7"].flags == 0
    assert b.epoch == 900 and b.tex_formats == 1 and b.mpt == (8.0, 4.0, 2.0, 1.0)


def test_truncated_protobuf_is_an_error_not_garbage() -> None:
    with pytest.raises(ValueError, match="truncated"):
        list(rt._fields(_f(1, b"abcdef")[:-2]))


def test_sphere_frame_lands_on_the_wgs84_ellipsoid() -> None:
    r = 6371010.0
    out = rt._to_wgs84(np.array([[r + 100, 0, 0], [0, 0, r + 100]]))
    assert out[0] == pytest.approx([6378137.0 + 100, 0, 0], abs=1e-3)  # equator
    assert out[1] == pytest.approx([0, 0, 6356752.314 + 100], abs=1e-2)  # pole


# ── glb ──


def test_node_becomes_a_textured_glb_in_the_earth_frame() -> None:
    g = _gltf(rt.node_glb(_node_data()))
    (prim,) = g["meshes"][0]["primitives"]
    assert g["accessors"][prim["indices"]]["count"] == 6  # two triangles
    assert g["images"][0]["mimeType"] == "image/jpeg"
    assert g["asset"]["copyright"] == "Google"
    # glTF is Y-up: earth-fixed (x, y, z) is stored as (x, z, -y).
    x, y, z = g["nodes"][0]["translation"]
    assert x == pytest.approx(6378137.0 + 100, abs=20) and abs(y) < 20 and abs(z) < 20


def test_texture_v_runs_top_down_for_atlases_and_is_flipped_for_terrain() -> None:
    """The scramble of 2026-10-04: with these swapped, every atlas triangle
    sampled the black padding between charts."""

    def v_of_first_and_last(raw: bytes) -> tuple[float, float]:
        glb = rt.node_glb(raw)
        g = _gltf(glb)
        acc = g["accessors"][g["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"]]
        view = g["bufferViews"][acc["bufferView"]]
        start = 20 + struct.unpack_from("<I", glb, 12)[0] + 8 + view["byteOffset"]
        uv = np.frombuffer(glb[start : start + view["byteLength"]], "<f4").reshape(-1, 2)
        return float(uv[0, 1]), float(uv[-1, 1])

    first, last = v_of_first_and_last(_node_data())  # packed default: v counts from the top
    assert first < 0.01 and last > 0.99
    first, last = v_of_first_and_last(_node_data(with_uv_scale=True))  # explicit: from the bottom
    assert first > 0.99 and last < 0.01


def test_octant_mask_keeps_only_the_parents_leftovers() -> None:
    raw = _node_data(octants=(0, 5))
    count = lambda g, i: g["accessors"][g["meshes"][0]["primitives"][i]["indices"]]["count"]  # noqa: E731
    assert count(_gltf(rt.node_glb(raw)), 0) == 6
    assert count(_gltf(rt.node_glb(raw, 1 << 5)), 0) == 3  # the octant-5 triangle only
    # Nothing left: still a loadable glb (Cesium has no "empty tile" response).
    empty = _gltf(rt.node_glb(raw, 1 << 3))
    assert "indices" not in empty["meshes"][0]["primitives"][0]


# ── tileset ──


def test_tileset_links_branches_and_never_leaves_a_hole() -> None:
    bulk = _bulk(
        _node_meta("0"),
        _node_meta("00"),
        _node_meta("01"),  # "0" is refined in octants 0 and 1 only
        _node_meta("000"),
        _node_meta("0000"),  # depth 4, not a leaf → the next bulk hangs here
        _node_meta("3", flags=4 | 8),  # leaf with no data: nothing to draw
    )
    doc = rt.tileset("", bulk, None)
    root = doc["root"]
    assert root["refine"] == "REPLACE"
    (zero,) = root["children"]  # "3" is gone
    uris = {c["content"]["uri"]: c for c in zero["children"]}
    # "0" keeps a filler for its other six octants. It must be a LEAF: REPLACE
    # drops whatever refines, so leftovers folded into a child that refines
    # would vanish one level down (the 2026-10-04 carrier mistake).
    assert set(uris) == {"n00.glb", "n01.glb", "n0.glb?keep=252"}
    filler = uris["n0.glb?keep=252"]
    assert filler["geometricError"] == 0 and "children" not in filler
    assert filler["boundingVolume"] == zero["boundingVolume"]
    by_uri = {c["content"]["uri"]: c for c in uris["n00.glb"]["children"]}
    assert set(by_uri) == {"n000.glb", "n00.glb?keep=254"}
    deep = by_uri["n000.glb"]["children"]
    assert {c["content"]["uri"] for c in deep} == {"n0000.glb", "n000.glb?keep=254"}
    link = next(c for c in deep if c["content"]["uri"] == "n0000.glb")["children"][0]
    assert link["content"]["uri"] == "t0000.json"
    assert uris["n01.glb"]["geometricError"] == 0  # a real leaf stops refining


def test_split_finds_the_bulk_that_describes_a_node() -> None:
    assert rt.split("3") == ("", "3")
    assert rt.split("3060") == ("", "3060")
    assert rt.split("30604") == ("3060", "4")
    assert rt.split("30604250") == ("3060", "4250")


# ── route ──


def test_route_is_dark_unless_the_operator_opted_in(client: TestClient) -> None:
    assert client.get("/tiles/g3d/root.json").status_code == 404
    assert client.get("/tiles/g3d/n3060.glb").status_code == 404
    # ENABLE_GOOGLE_3D alone (the licensed stream) must not turn scraping on.
    app.dependency_overrides[get_settings] = lambda: Settings(
        enable_google_3d=True, google_3d_keyless=False
    )
    assert client.get("/tiles/g3d/root.json").status_code == 404


def test_route_rejects_anything_that_is_not_an_octree_path(client: TestClient) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(google_3d_keyless=True)
    for bad in ("n8.glb", "n30a.glb", "n3_0.glb", "t306.json", "t9999.json", "n3060.glb?keep=0"):
        assert client.get(f"/tiles/g3d/{bad}").status_code == 422, bad
