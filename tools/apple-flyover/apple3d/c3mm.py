"""C3MM octree metadata: LZMA-compressed tile index for region lookup."""

import lzma
import struct
from dataclasses import dataclass, field


@dataclass
class Tile:
    z: int
    y: int
    x: int
    h: int

    def zoomed_out(self) -> "Tile":
        return Tile(self.z - 1, self.y // 2, self.x // 2, self.h // 2)

    def zoomed_in(self, octant: int) -> "Tile":
        return Tile(
            self.z + 1,
            self.y * 2 | (octant >> 1) & 1,
            self.x * 2 | octant & 1,
            self.h * 2 | (octant >> 2) & 1,
        )

    def __lt__(self, other: "Tile") -> bool:
        return (self.z, self.y, self.x, self.h) < (other.z, other.y, other.x, other.h)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Tile):
            return NotImplemented
        return (self.z, self.y, self.x, self.h) == (other.z, other.y, other.x, other.h)

    def __hash__(self) -> int:
        return hash((self.z, self.y, self.x, self.h))


@dataclass
class Root:
    tile: Tile
    offset: int
    structure_type: int


@dataclass
class Octant:
    bits: int
    altitude_high: float
    altitude_low: float
    next: int


@dataclass
class C3MM:
    mult1: float = 0.0
    mult2: float = 0.0
    file_entries: list[int] = field(default_factory=list)
    roots: list[Root] = field(default_factory=list)
    smallest_z: int = 0
    data: bytes = b""


def _decompress_lzma(raw: bytes, uncompressed_size: int) -> bytes:
    # ponytail: the Go code patches bytes 5-12 with the uncompressed size
    # LZMA alone format: 5 bytes props + 8 bytes uncompressed size + compressed data
    patched = bytearray(raw)
    struct.pack_into("<q", patched, 5, uncompressed_size)
    return lzma.decompress(bytes(patched), format=lzma.FORMAT_ALONE)


def parse(data: bytes, part: int) -> C3MM:
    if data[:4] != b"C3MM":
        raise ValueError("invalid C3MM header")
    version = struct.unpack_from("<h", data, 4)[0]
    if version != 1:
        raise ValueError(f"C3MM v{version} not implemented")
    return _parse_v1(data, part)


def _parse_v1(data: bytes, part: int) -> C3MM:
    if data[:6] != b"C3MM\x01\x00":
        raise ValueError("invalid C3MM v1 header")

    c = C3MM()
    c.mult1 = struct.unpack_from("<f", data, 11)[0]
    c.mult2 = struct.unpack_from("<f", data, 15)[0]
    compressed_size = struct.unpack_from("<i", data, 19)[0]
    uncompressed_size = struct.unpack_from("<i", data, 23)[0]

    body = data[27:]
    if uncompressed_size != compressed_size:
        body = _decompress_lzma(body, uncompressed_size)

    off = 0

    if part == 0:
        # file index (type 2)
        if body[off] != 2:
            raise ValueError(f"expected type 2, got {body[off]}")
        size = struct.unpack_from("<i", body, off + 1)[0]
        seg = body[off + 5 : off + size]
        c.file_entries = [struct.unpack_from("<i", seg, i)[0] for i in range(0, len(seg), 4)]
        off += size

        # root index (type 0)
        if body[off] != 0:
            raise ValueError(f"expected type 0, got {body[off]}")
        size = struct.unpack_from("<i", body, off + 1)[0]
        seg = body[off + 5 : off + size]
        for i in range(0, len(seg), 17):
            z, y, x, offset_val = struct.unpack_from("<iiii", seg, i)
            st = seg[i + 16]
            if st != 1:
                raise ValueError(f"structure type {st} != 1")
            c.roots.append(Root(Tile(z, y, x, 0), offset_val, st))
        c.roots.sort(key=lambda r: r.tile)
        c.smallest_z = min(r.tile.z for r in c.roots) if c.roots else 0
        off += size

        # skip object tree (type 3)
        if off < len(body) and body[off] == 3:
            skip = struct.unpack_from("<i", body, off + 1)[0]
            off += skip

        # data section (type 1)
        if off < len(body) and body[off] == 1:
            off += 5

    c.data = body[off:]
    return c


def get_octant(c3mm: C3MM, octant_offset: int, part_offset: int) -> tuple[Octant, int]:
    off = octant_offset - part_offset
    s = c3mm.data[off:]
    bits = struct.unpack_from("<h", s, 0)[0]
    val_b = s[2]
    val_c = struct.unpack_from("<h", s, 3)[0]
    next_val = struct.unpack_from("<i", s, 5)[0]
    alt_low = float(val_c) * c3mm.mult1
    alt_high = (float(val_b) * c3mm.mult2) + alt_low
    return Octant(bits, alt_high, alt_low, next_val), octant_offset + 9


def get_part_number(file_entries: list[int], octant_offset: int) -> int:
    for i in range(len(file_entries) - 1):
        if octant_offset < file_entries[i + 1]:
            return i
    return len(file_entries) - 1


def check_tile(c3mm0: C3MM, tile: Tile, get_c3mm_fn) -> bool:
    """Check if a tile exists in the octree. get_c3mm_fn(part) -> C3MM."""
    if tile.z < c3mm0.smallest_z:
        return False

    chain = []
    t = tile
    while t.z >= c3mm0.smallest_z:
        chain.append(t)
        t = t.zoomed_out()

    import bisect
    list_idx = len(chain) - 1
    root = None
    while list_idx >= 0:
        t = chain[list_idx]
        idx = bisect.bisect_left(c3mm0.roots, t, key=lambda r: r.tile)
        if idx < len(c3mm0.roots) and c3mm0.roots[idx].tile == t:
            root = c3mm0.roots[idx]
            break
        list_idx -= 1

    if root is None:
        return False

    part_num = get_part_number(c3mm0.file_entries, root.offset)
    c3mm_part = get_c3mm_fn(part_num)
    octant, new_off = get_octant(c3mm_part, root.offset, c3mm0.file_entries[part_num])

    if chain[list_idx] == tile:
        return True
    if list_idx == 0:
        return False

    while octant.next > 0:
        list_idx -= 1
        zoomed_in_actual = chain[list_idx]
        parent = chain[list_idx + 1]
        bits = octant.bits
        oct_off = octant.next
        matched = False
        for o in range(8):
            if not (bits >> (o * 2)) & 1:
                continue
            part_num = get_part_number(c3mm0.file_entries, oct_off)
            c3mm_part = get_c3mm_fn(part_num)
            octant, oct_off = get_octant(c3mm_part, oct_off, c3mm0.file_entries[part_num])
            if parent.zoomed_in(o) == zoomed_in_actual:
                matched = True
                break
        if not matched:
            return False
        if tile == zoomed_in_actual:
            return True

    return False
