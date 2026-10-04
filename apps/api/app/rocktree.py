"""Google Earth "rocktree" → 3D Tiles, with no key of any kind.

`kh.google.com/rt/earth` is the unauthenticated channel Google Earth's own web
client reads: an octree of protobuf nodes carrying the same textured
photogrammetry the keyed Map Tiles API sells. This module turns it into a
3D Tiles tileset the Cesium globe loads like any other.

It is a private, undocumented endpoint and using it is outside Google's terms.
The operator chose that knowingly on 2026-10-03 (docs/decisions.md,
"Keyless Google Earth 3D"); the route stays behind GOOGLE_3D_KEYLESS and refuses
a commercial tier. Google can change or block it without notice — every
failure here must surface as a missing tile, never as a broken globe.

Wire format per the public notes in retroplasma/earth-reverse-engineering
(proto/rocktree.proto). Hand-rolled protobuf reader: five message types do not
earn a protobuf dependency.
"""

from __future__ import annotations

import json
import math
import struct
import time
from collections.abc import Iterator
from dataclasses import dataclass

import numpy as np

from app.upstream import get_client

_BASE = "https://kh.google.com/rt/earth/"

# NodeMetadata.Flags
_LEAF = 4
_NODATA = 8
_USE_IMAGERY_EPOCH = 16

_TEX_JPG = 1
_TEX_CRN_DXT1 = 6

# 3D Tiles geometricError per metre-per-texel. Cesium refines a tile while
# geometricError projects to more than maximumScreenSpaceError pixels, and the
# globe runs at 24, so this number IS texels per 24 screen pixels:
#   24 → one texel per pixel, the sharpest the source has (the default);
#   16 → 1.5 px a texel; 10 → 2.4 px a texel, which matches the triangle count
#   of Google's licensed tileset at that setting and reads as soft.
# The operator asked for speed, then for resolution, on consecutive days, so
# it is a setting: GOOGLE_3D_DETAIL. Tile count grows roughly with its square.
GE_PER_TEXEL = 24.0

# Google Earth's globe is a SPHERE of this radius: a point at geodetic
# (lat, lon) and height h above sea level sits at spherical (lat, lon, R + h).
# Measured 2026-10-03 on the Rheinturm: its 240 m shaft turns up at
# 51.2179 N under this reading and nowhere under a geocentric one.
_SPHERE_R = 6371010.0
_WGS84_A = 6378137.0
_WGS84_E2 = 6.69437999014e-3


def _to_wgs84(p: np.ndarray) -> np.ndarray:
    """Sphere-frame points (n,3) → WGS84 earth-fixed. The sphere's radial
    direction at a latitude IS the ellipsoid normal at that geodetic latitude,
    so only the distance along it changes. Heights stay sea-level heights used
    as ellipsoidal ones — the same convention the keyless terrain already has,
    so water sits at zero under both."""
    r = np.linalg.norm(p, axis=1)
    up = p / r[:, None]
    h = r - _SPHERE_R
    n = _WGS84_A / np.sqrt(1.0 - _WGS84_E2 * up[:, 2] ** 2)
    out = up * (n + h)[:, None]
    out[:, 2] = up[:, 2] * (n * (1.0 - _WGS84_E2) + h)
    return out


# ── protobuf wire format ─────────────────────────────────────────────────────


def _varint(b: bytes, i: int) -> tuple[int, int]:
    v = shift = 0
    while True:
        c = b[i]
        i += 1
        v |= (c & 0x7F) << shift
        shift += 7
        if c < 0x80:
            return v, i


def _fields(b: bytes) -> Iterator[tuple[int, int | bytes]]:
    """(field number, value) pairs; varints as int, everything else as bytes."""
    i, n = 0, len(b)
    while i < n:
        key, i = _varint(b, i)
        wire = key & 7
        if wire == 0:
            v, i = _varint(b, i)
            yield key >> 3, v
            continue
        if wire == 2:
            size, i = _varint(b, i)
        elif wire == 1:
            size = 8
        elif wire == 5:
            size = 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")
        if i + size > n:
            raise ValueError("truncated protobuf message")
        yield key >> 3, b[i : i + size]
        i += size


def _f32(v: int | bytes) -> float:
    return struct.unpack("<f", v)[0]  # type: ignore[arg-type]


# ── metadata ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Node:
    flags: int
    epoch: int | None
    bulk_epoch: int | None
    obb: bytes | None
    mpt: float | None
    imagery_epoch: int | None
    tex_formats: int | None


@dataclass(frozen=True, slots=True)
class Bulk:
    """One BulkMetadata: up to four octree levels below its head node."""

    nodes: dict[str, Node]  # keyed by path relative to the head, 1-4 digits
    epoch: int
    center: tuple[float, float, float]
    mpt: tuple[float, ...]  # default metres-per-texel, by relative level - 1
    imagery_epoch: int
    tex_formats: int


def planetoid_epoch(buf: bytes) -> int:
    for f, v in _fields(buf):
        if f == 1:
            for g, w in _fields(v):  # type: ignore[arg-type]
                if g == 2:
                    return int(w)  # type: ignore[arg-type]
    raise ValueError("planetoid metadata carries no root epoch")


def parse_bulk(buf: bytes) -> Bulk:
    nodes: dict[str, Node] = {}
    epoch = imagery = formats = 0
    center = (0.0, 0.0, 0.0)
    mpt: tuple[float, ...] = ()
    for f, v in _fields(buf):
        if f == 1:
            d: dict[int, int | bytes] = dict(_fields(v))  # type: ignore[arg-type]
            pf = int(d.get(1, 0))  # type: ignore[arg-type]
            level = 1 + (pf & 3)
            pf >>= 2
            path = ""
            for _ in range(level):
                path += str(pf & 7)
                pf >>= 3
            nodes[path] = Node(
                flags=pf,
                epoch=d.get(2),  # type: ignore[arg-type]
                bulk_epoch=d.get(5),  # type: ignore[arg-type]
                obb=d.get(3),  # type: ignore[arg-type]
                mpt=_f32(d[4]) if 4 in d else None,
                imagery_epoch=d.get(7),  # type: ignore[arg-type]
                tex_formats=d.get(8),  # type: ignore[arg-type]
            )
        elif f == 2:
            epoch = int(dict(_fields(v)).get(2, 0))  # type: ignore[arg-type]
        elif f == 3:
            center = tuple(np.frombuffer(v, "<f8")[:3].tolist())  # type: ignore[arg-type,assignment]
        elif f == 4:
            mpt = tuple(np.frombuffer(v, "<f4").tolist())  # type: ignore[arg-type]
        elif f == 5:
            imagery = int(v)  # type: ignore[arg-type]
        elif f == 6:
            formats = int(v)  # type: ignore[arg-type]
    return Bulk(nodes, epoch, center, mpt, imagery, formats)


def _node_mpt(bulk: Bulk, rel: str, node: Node) -> float:
    return node.mpt if node.mpt is not None else bulk.mpt[len(rel) - 1]


def _box(bulk: Bulk, rel: str, node: Node) -> list[float]:
    """The node's oriented bounding box as a 3D Tiles `box` (centre + half axes)."""
    assert node.obb is not None
    mpt = _node_mpt(bulk, rel, node)
    cx, cy, cz = struct.unpack_from("<3h", node.obb, 0)
    ext = [node.obb[6] * mpt, node.obb[7] * mpt, node.obb[8] * mpt]
    e0, e1, e2 = struct.unpack_from("<3H", node.obb, 9)
    a0, a1, a2 = e0 * math.pi / 32768.0, e1 * math.pi / 65536.0, e2 * math.pi / 32768.0
    c0, s0, c1, s1, c2, s2 = (
        math.cos(a0), math.sin(a0), math.cos(a1), math.sin(a1), math.cos(a2), math.sin(a2),
    )  # fmt: skip
    axes = (
        (c0 * c2 - c1 * s0 * s2, c1 * c0 * s2 + c2 * s0, s2 * s1),
        (-c0 * s2 - c2 * c1 * s0, c0 * c1 * c2 - s0 * s2, c2 * s1),
        (s1 * s0, -c0 * s1, c1),
    )
    centre = np.array(
        [[cx * mpt + bulk.center[0], cy * mpt + bulk.center[1], cz * mpt + bulk.center[2]]]
    )
    out: list[float] = _to_wgs84(centre)[0].tolist()
    for axis, half in zip(axes, ext, strict=True):
        # Only the centre is re-projected; sphere and ellipsoid differ by under
        # half a percent in scale, which the 1.5 % covers. The one-texel floor
        # keeps a zero-thickness source box from being a degenerate volume.
        out += [a * max(half, mpt) * 1.015 for a in axis]
    return [round(v, 2) for v in out]


def _drawable(node: Node) -> bool:
    return node.obb is not None and len(node.obb) == 15


def has_child_bulk(rel: str, node: Node) -> bool:
    return len(rel) == 4 and not node.flags & _LEAF


def tileset(
    head: str,
    bulk: Bulk,
    parent: tuple[Bulk, str, Node] | None,
    detail: float = GE_PER_TEXEL,
) -> dict:
    """One bulk as a 3D Tiles tileset. `parent` locates the head node in the
    bulk above (None for the planet root); deeper bulks hang off as external
    tilesets, so the browser only ever pulls the branch it is looking at."""
    tiles: dict[str, dict] = {}
    for rel, node in bulk.nodes.items():
        if not _drawable(node) or (node.flags & _NODATA and node.flags & _LEAF):
            continue
        tile: dict = {
            "boundingVolume": {"box": _box(bulk, rel, node)},
            "geometricError": _node_mpt(bulk, rel, node) * detail,
            "children": [],
        }
        if not node.flags & _NODATA:
            tile["content"] = {"uri": f"n{head}{rel}.glb"}
        if has_child_bulk(rel, node):
            tile["children"].append(
                {
                    "boundingVolume": tile["boundingVolume"],
                    "geometricError": tile["geometricError"],
                    "content": {"uri": f"t{head}{rel}.json"},
                }
            )
        tiles[rel] = tile

    if parent is None:
        root: dict = {
            "boundingVolume": {"sphere": [0, 0, 0, 6.5e6]},
            "geometricError": 1e7,
            "children": [],
        }
        head_has_data = False
    else:
        pbulk, prel, pnode = parent
        root = {
            "boundingVolume": {"box": _box(pbulk, prel, pnode)},
            "geometricError": _node_mpt(pbulk, prel, pnode) * detail,
            "children": [],
        }
        head_has_data = not pnode.flags & _NODATA
    root["refine"] = "REPLACE"

    octants: dict[str, int] = {}  # parent rel path → bitmask of octants with a child
    for rel in sorted(tiles, key=len):
        up = rel[:-1]
        while up and up not in tiles:
            up = up[:-1]
        (tiles[up] if up else root)["children"].append(tiles[rel])
        if up == rel[:-1]:
            octants[up] = octants.get(up, 0) | 1 << int(rel[-1])

    # REPLACE drops a parent whole once its children load, but Google only
    # ships children for the octants that have finer data and masks the parent
    # per octant. Each partly refined node gets one extra LEAF child carrying
    # its own triangles for the rest — a leaf, because anything that refines
    # would drop them again one level down.
    # ponytail: that is a fifth of all requests and over a dense city every one
    # is empty (93 of 455, measured 2026-10-04). Folding them into a sibling is
    # wrong (it refines); chaining the masks down a child line is the upgrade.
    for up, mask in octants.items():
        owner = tiles[up] if up else root
        if mask == 0xFF or not (("content" in owner) if up else head_has_data):
            continue
        owner["children"].append(
            {
                "boundingVolume": owner["boundingVolume"],
                "geometricError": 0,
                "content": {"uri": f"n{head}{up}.glb?keep={0xFF & ~mask}"},
            }
        )

    for tile in tiles.values():
        if not tile["children"]:
            del tile["children"]
            tile["geometricError"] = 0
    return {"asset": {"version": "1.0"}, "geometricError": root["geometricError"], "root": root}


# ── node data → glb ──────────────────────────────────────────────────────────


def _strip(packed: bytes) -> np.ndarray:
    """Delta-coded triangle strip → vertex indices."""
    n, i = _varint(packed, 0)
    out = np.empty(n, dtype=np.int64)
    zeros = 0
    for k in range(n):
        val, i = _varint(packed, i)
        out[k] = zeros - val
        if val == 0:
            zeros += 1
    return out


def _mesh(
    fields: dict[int, list],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, bytes | None]:
    """→ positions (n,3) f32, uvs (n,2) f32, triangles (m,3), octant per vertex, jpeg."""
    raw = np.frombuffer(fields[1][0], np.uint8)
    n = len(raw) // 3
    pos = np.cumsum(raw[: 3 * n].reshape(3, n), axis=1, dtype=np.uint8).T.astype(np.float32)

    tc = np.frombuffer(fields[7][0], np.uint8)
    u_mod, v_mod = (1 + int(m) for m in tc[:4].view("<u2"))
    d = tc[4 : 4 + 4 * n].reshape(4, n).astype(np.int64)
    u = np.cumsum(d[0] + (d[2] << 8)) % u_mod
    v = np.cumsum(d[1] + (d[3] << 8)) % v_mod
    # glTF puts v = 0 at the top row of the image. An explicit offset/scale
    # (terrain) counts v from the bottom row; the packed default (the
    # photogrammetry atlases) already counts from the top. Measured 2026-10-04:
    # the other way round, every atlas triangle samples black padding.
    if 10 in fields and len(fields[10][0]) == 16:
        ou, ov, su, sv = np.frombuffer(fields[10][0], "<f4").tolist()
        uv = np.stack([(u + ou) * su, 1.0 - (v + ov) * sv], axis=1).astype(np.float32)
    else:
        uv = np.stack([(u + 0.5) / u_mod, (v + 0.5) / v_mod], axis=1).astype(np.float32)

    strip = _strip(fields[3][0])
    octant = np.zeros(n, dtype=np.int64)
    bound = len(strip)
    if 8 in fields:
        packed = fields[8][0]
        count, i = _varint(packed, 0)
        runs = []
        for _ in range(count):
            run, i = _varint(packed, i)
            runs.append(run)
        per_index = np.repeat(np.arange(count) & 7, runs)[: len(strip)]
        octant[strip[: len(per_index)]] = per_index
        # Layers 0-2 are the visible surface; hidden terrain, water and skirts follow.
        bound = min(len(strip), sum(runs[:24]))

    s = strip[:bound]
    if len(s) < 3:
        tri = np.empty((0, 3), dtype=np.int64)
    else:
        tri = np.stack([s[:-2], s[1:-1], s[2:]], axis=1)
        tri[1::2, [0, 1]] = tri[1::2, [1, 0]]  # strips alternate winding
        a, b, c = tri.T
        tri = tri[(a != b) & (b != c) & (a != c)]

    jpeg = None
    for tex in fields.get(6, []):
        t: dict[int, list] = {}
        for f, val in _fields(tex):
            t.setdefault(f, []).append(val)
        if t.get(2, [_TEX_JPG])[0] == _TEX_JPG and t.get(1):
            jpeg = t[1][0]
            break
    return pos, uv, tri, octant, jpeg


def _pad(b: bytes, fill: bytes = b"\0") -> bytes:
    return b + fill * (-len(b) % 4)


def node_glb(buf: bytes, keep: int = 0xFF) -> bytes:
    """NodeData → binary glTF, keeping only triangles in the `keep` octants."""
    matrix = np.eye(4)
    meshes = []
    for f, v in _fields(buf):
        if f == 1:
            matrix = np.frombuffer(v, "<f8")[:16].reshape(4, 4).T  # type: ignore[arg-type]
        elif f == 2:
            fields: dict[int, list] = {}
            for g, w in _fields(v):  # type: ignore[arg-type]
                fields.setdefault(g, []).append(w)
            if 1 in fields and 3 in fields and 7 in fields:
                meshes.append(_mesh(fields))

    bin_ = b""
    views: list[dict] = []
    accessors: list[dict] = []
    gltf: dict = {
        "asset": {"version": "2.0", "copyright": "Google"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": []}],
        "materials": [],
        "extensionsUsed": ["KHR_materials_unlit"],
    }

    def view(data: bytes, target: int | None = None) -> int:
        nonlocal bin_
        views.append({"buffer": 0, "byteOffset": len(bin_), "byteLength": len(data)})
        if target:
            views[-1]["target"] = target
        bin_ += _pad(data)
        return len(views) - 1

    def accessor(arr: np.ndarray, ctype: int, kind: str, target: int, bounds: bool = False) -> int:
        acc = {
            "bufferView": view(arr.tobytes(), target),
            "componentType": ctype,
            "count": len(arr),
            "type": kind,
        }
        if bounds:
            acc["min"], acc["max"] = arr.min(axis=0).tolist(), arr.max(axis=0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    centre: np.ndarray | None = None
    for pos, uv, tri, octant, jpeg in meshes:
        if keep != 0xFF:
            tri = tri[((keep >> octant[tri]) & 1).all(axis=1)]
        if not len(tri) or not len(pos):
            continue
        world = _to_wgs84((np.c_[pos, np.ones(len(pos))] @ matrix.T)[:, :3])
        if centre is None:
            # float32 cannot hold earth-fixed metres; vertices ride relative
            # to the first mesh and the node carries the offset in doubles.
            # glTF is Y-up and Cesium rotates tile content back to Z-up.
            centre = world.mean(axis=0)
            gltf["nodes"][0]["translation"] = [centre[0], centre[2], -centre[1]]
        local = world - centre
        pos = np.stack([local[:, 0], local[:, 2], -local[:, 1]], axis=1).astype(np.float32)
        material: dict = {
            "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1},
            "extensions": {"KHR_materials_unlit": {}},
        }
        if jpeg is not None:
            # ponytail: JPEG only. Google also serves crunch-compressed DXT1;
            # add a decoder if a region ever stops offering JPEG.
            tex = len(gltf.setdefault("textures", []))
            gltf.setdefault("images", []).append(
                {"bufferView": view(jpeg), "mimeType": "image/jpeg"}
            )
            gltf["textures"].append({"source": tex, "sampler": 0})
            # Plain LINEAR, no mipmaps, on purpose. Cesium gives glTF textures
            # no anisotropic filtering, so trilinear picks a coarse mip on every
            # facade seen at an angle: windows blurred away and textures cost a
            # third more memory (compared on Morningside Heights, 2026-10-05).
            gltf["samplers"] = [
                {"magFilter": 9729, "minFilter": 9729, "wrapS": 33071, "wrapT": 33071}
            ]
            material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tex}
        gltf["materials"].append(material)
        wide = len(pos) > 0xFFFF
        gltf["meshes"][0]["primitives"].append(
            {
                "attributes": {
                    "POSITION": accessor(pos, 5126, "VEC3", 34962, bounds=True),
                    "TEXCOORD_0": accessor(uv, 5126, "VEC2", 34962),
                },
                "indices": accessor(
                    tri.astype("<u4" if wide else "<u2").reshape(-1),
                    5125 if wide else 5123,
                    "SCALAR",
                    34963,
                ),
                "material": len(gltf["materials"]) - 1,
            }
        )

    if not gltf["meshes"][0]["primitives"]:
        # ponytail: Cesium has no "empty content" response for an explicit
        # tileset, so an octant mask that leaves nothing ships one zero-area
        # triangle rather than a 204 the tile would log as a failure.
        zero = np.zeros((3, 3), dtype=np.float32)
        gltf["materials"].append({})
        gltf["meshes"][0]["primitives"].append(
            {
                "attributes": {"POSITION": accessor(zero, 5126, "VEC3", 34962, bounds=True)},
                "material": 0,
            }
        )

    gltf["bufferViews"], gltf["accessors"] = views, accessors
    gltf["buffers"] = [{"byteLength": len(bin_)}]
    js = _pad(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    total = 12 + 8 + len(js) + 8 + len(bin_)
    return b"".join(
        (
            struct.pack("<4sII", b"glTF", 2, total),
            struct.pack("<I4s", len(js), b"JSON"), js,
            struct.pack("<I4s", len(bin_), b"BIN\0"), bin_,
        )
    )  # fmt: skip


# ── fetching ─────────────────────────────────────────────────────────────────

_BULK_TTL = 3600.0
_bulks: dict[str, tuple[float, Bulk]] = {}


async def _get(path: str) -> bytes:
    r = await get_client().get(_BASE + path)
    if r.status_code != 200:
        raise LookupError(f"rocktree {path.split('/')[0]} answered {r.status_code}")
    return r.content


def split(path: str) -> tuple[str, str]:
    """Octree path → (head of the bulk that describes it, path within that bulk)."""
    cut = (len(path) - 1) // 4 * 4
    return path[:cut], path[cut:]


async def bulk(head: str) -> Bulk:
    """The bulk headed at `head` (length a multiple of 4), walking the epoch
    chain down from the planet root. Raises LookupError for a path Google does
    not have."""
    hit = _bulks.get(head)
    if hit and time.monotonic() - hit[0] < _BULK_TTL:
        return hit[1]
    if head:
        up = await bulk(head[:-4])
        node = up.nodes.get(head[-4:])
        if node is None or not has_child_bulk(head[-4:], node):
            raise LookupError(f"no bulk at {head}")
        epoch = node.bulk_epoch if node.bulk_epoch is not None else up.epoch
    else:
        epoch = planetoid_epoch(await _get("PlanetoidMetadata"))
    got = parse_bulk(await _get(f"BulkMetadata/pb=!1m2!1s{head}!2u{epoch}"))
    if len(_bulks) > 4096:
        # ponytail: wholesale flush; an LRU if a long session ever thrashes it.
        _bulks.clear()
    _bulks[head] = (time.monotonic(), got)
    return got


_json: dict[tuple[str, float], tuple[float, bytes]] = {}


async def tileset_json(head: str, detail: float = GE_PER_TEXEL) -> bytes:
    """The serialized tileset for one bulk. Cached: building it is ~30 ms of
    event loop per request, and a view pulls two dozen of them."""
    hit = _json.get((head, detail))
    if hit and time.monotonic() - hit[0] < _BULK_TTL:
        return hit[1]
    here = await bulk(head)
    if head:
        up = await bulk(head[:-4])
        doc = tileset(head, here, (up, head[-4:], up.nodes[head[-4:]]), detail)
    else:
        doc = tileset(head, here, None, detail)
    out = json.dumps(doc, separators=(",", ":")).encode()
    if len(_json) > 512:
        _json.clear()
    _json[(head, detail)] = (time.monotonic(), out)
    return out


# A filler is cut from its parent's NodeData, which the browser asked for a
# moment earlier. Small on purpose: tens of KB an entry.
_raw: dict[str, bytes] = {}


async def node_data(path: str) -> bytes:
    hit = _raw.get(path)
    if hit is not None:
        return hit
    head, rel = split(path)
    b = await bulk(head)
    node = b.nodes.get(rel)
    if node is None or node.flags & _NODATA:
        raise LookupError(f"no node data at {path}")
    formats = node.tex_formats if node.tex_formats is not None else b.tex_formats
    fmt = _TEX_JPG if formats & (1 << (_TEX_JPG - 1)) else _TEX_CRN_DXT1
    url = f"NodeData/pb=!1m2!1s{path}!2u{node.epoch if node.epoch is not None else b.epoch}!2e{fmt}"
    if node.flags & _USE_IMAGERY_EPOCH:
        imagery = node.imagery_epoch if node.imagery_epoch is not None else b.imagery_epoch
        url += f"!3u{imagery}"
    got = await _get(url + "!4b0")
    if len(_raw) >= 512:
        del _raw[next(iter(_raw))]
    _raw[path] = got
    return got


async def glb(path: str, keep: int = 0xFF) -> bytes:
    """One node as binary glTF; `keep` is the octant mask of a filler (see
    `tileset`), every octant otherwise."""
    return node_glb(await node_data(path), keep)
