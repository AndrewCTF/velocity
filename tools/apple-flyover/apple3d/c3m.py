"""C3M tile parser: header (transform), materials (JPEG textures), meshes."""

import struct
from dataclasses import dataclass, field

from .decompress import (
    RawMeshData, HuffmanTable, decompress,
    read_huffman_params, create_table,
    _ri32, _ru32, _rf32, _rf64, _ru8,
)


def _quat_to_matrix(qx, qy, qz, qw):
    return (
        1 - 2*qy*qy - 2*qz*qz, 2*qx*qy - 2*qw*qz, 2*qx*qz + 2*qw*qy,
        2*qx*qy + 2*qw*qz, 1 - 2*qx*qx - 2*qz*qz, 2*qy*qz - 2*qw*qx,
        2*qx*qz - 2*qw*qy, 2*qy*qz + 2*qw*qx, 1 - 2*qx*qx - 2*qy*qy,
    )


@dataclass
class Header:
    translation: tuple[float, float, float]
    rotation: tuple  # 9 floats (3x3 matrix)


@dataclass
class Material:
    jpeg: bytes  # raw texture bytes (JPEG or HEIF)
    is_heif: bool = False


@dataclass
class Vertex:
    x: float; y: float; z: float; u: float; v: float


@dataclass
class Face:
    a: int; b: int; c: int


@dataclass
class Group:
    material: int
    faces: list[Face]


@dataclass
class Mesh:
    vertices: list[Vertex]
    groups: dict[int, Group]


@dataclass
class C3M:
    header: Header = field(default_factory=lambda: Header((0, 0, 0), (1, 0, 0, 0, 1, 0, 0, 0, 1)))
    materials: list[Material] = field(default_factory=list)
    meshes: list[Mesh] = field(default_factory=list)


def parse(data: bytes) -> C3M:
    if len(data) < 6 or data[:3] != b"C3M":
        raise ValueError("invalid C3M header")
    if data[3] != 0x03:
        raise ValueError(f"C3M v{data[3]} not implemented (only v3)")
    return _parse_v3(data)


def _parse_v3(data: bytes) -> C3M:
    n_items = data[5]
    offset = 6
    c3m = C3M()

    for _ in range(n_items):
        item_type = data[offset]
        if item_type == 0:
            c3m.header, offset = _parse_header(data, offset)
        elif item_type == 1:
            c3m.materials, offset = _parse_materials(data, offset)
        elif item_type == 2:
            meshes, offset = _parse_meshes(data, offset)
            c3m.meshes.extend(meshes)
        elif item_type == 3:
            break  # animation/scene graph — can't skip
        else:
            raise ValueError(f"unknown item type {item_type}")
    return c3m


def _parse_header(data: bytes, offset: int) -> tuple[Header, int]:
    qx = _rf64(data, offset + 9)
    qy = _rf64(data, offset + 17)
    qz = _rf64(data, offset + 25)
    qw = _rf64(data, offset + 33)
    x = _rf64(data, offset + 41)
    y = _rf64(data, offset + 49)
    z = _rf64(data, offset + 57)
    rot = _quat_to_matrix(qx, qy, qz, qw)
    return Header((x, y, z), rot), offset + 113


def _parse_materials(data: bytes, offset: int) -> tuple[list[Material], int]:
    offset += 5
    n = _ri32(data, offset)
    offset += 4
    materials = []
    for _ in range(n):
        mat_type = data[offset]
        if mat_type > 10:
            raise ValueError(f"material type {mat_type}")
        tex_fmt = data[offset + 3]
        tex_off = _ri32(data, offset + 4)
        tex_len2 = _ri32(data, offset + 12)
        if tex_fmt not in (0, 13):
            raise ValueError(f"unsupported texture format {tex_fmt}")
        materials.append(Material(bytes(data[tex_off : tex_off + tex_len2]), is_heif=(tex_fmt == 13)))
        offset += 16
    return materials, offset


def _parse_meshes(data: bytes, offset: int) -> tuple[list[Mesh], int]:
    offset += 5
    n = _ri32(data, offset)
    offset += 4
    meshes = []

    for _ in range(n):
        mesh_type = data[offset]
        u12 = data[offset + 1] + (data[offset + 2] << 8)

        if mesh_type != 2:
            raise ValueError(f"mesh type {mesh_type} (expected 2)")

        off3 = offset + 3
        hpa = read_huffman_params(data, off3 + 1)
        ebta = create_table(hpa)
        hpb = read_huffman_params(data, off3 + 15)
        ebtb = create_table(hpb)

        g_uv_count = _ri32(data, off3 + 29)
        g_faces_count = _ri32(data, off3 + 33)
        group_count = _ri32(data, off3 + 37)
        data_offset = _ri32(data, off3 + 41)

        rmd = decompress(data, data_offset, ebta, ebtb)
        if rmd.uv_count != g_uv_count or rmd.faces_count != g_faces_count:
            raise ValueError("decompressed counts != header counts")

        # post-process: remap vertices/UVs
        tmp_fst = [0] * rmd.uv_count
        for ctr in range(3 * rmd.faces_count):
            tmp_fst[rmd.res5[ctr]] = rmd.faces[ctr]
        tmp_snd = [0] * rmd.uv_count

        pre_idx = 0
        off = 0
        uv1 = rmd.uv_count
        uv2 = rmd.uv_count
        vertices = [None] * uv2

        while uv2 > 0:
            tmp_fst_itm = tmp_fst[off]
            uv_min1 = uv1 - 1
            if rmd.res8[tmp_fst_itm] != 0:
                uv1 = uv_min1
            else:
                uv_min1 = pre_idx
                pre_idx += 1
            tmp_snd[off] = uv_min1
            idx = uv_min1
            vertices[idx] = Vertex(
                rmd.vertices[3 * tmp_fst_itm],
                rmd.vertices[3 * tmp_fst_itm + 1],
                rmd.vertices[3 * tmp_fst_itm + 2],
                rmd.uv[off * 2],
                rmd.uv[off * 2 + 1],
            )
            off += 1
            uv2 -= 1

        for ctr in range(3 * rmd.faces_count):
            rmd.res5[ctr] = tmp_snd[rmd.res5[ctr]]

        # group faces by material
        gm: dict[int, int] = {}
        for i in range(len(rmd.res6)):
            e = rmd.res6[i]
            gm[e] = gm.get(e, 0) + 1

        groups: dict[int, Group] = {}
        gm_remaining = dict(gm)
        for i in range(len(rmd.res6)):
            e = rmd.res6[i]
            if gm_remaining.get(e, 0) > 0:
                if e not in groups:
                    groups[e] = Group(e, [None] * gm[e])
                g = groups[e]
                face_idx = gm[e] - gm_remaining[e]
                g.faces[face_idx] = Face(rmd.res5[i * 3], rmd.res5[i * 3 + 1], rmd.res5[i * 3 + 2])
                gm_remaining[e] -= 1

        meshes.append(Mesh(vertices, groups))
        offset += u12

    return meshes, offset
