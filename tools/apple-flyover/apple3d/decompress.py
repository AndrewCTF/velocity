"""Huffman table + Edgebreaker mesh decompression for Apple C3M tiles.

Ported from retroplasma/flyover-reverse-engineering pkg/fly/c3m/internal/.
Dense bit manipulation — the variable names match the Go original for
traceability.
"""

import struct
from array import array
from dataclasses import dataclass


MASK32 = 0xFFFFFFFF
MASK64 = 0xFFFFFFFFFFFFFFFF


def _i32(v: int) -> int:
    v &= MASK32
    return v - 0x100000000 if v >= 0x80000000 else v


def _u32(v: int) -> int:
    return v & MASK32


# --- binary helpers (little-endian) ---

def _ri8(d, o):  return struct.unpack_from("<b", d, o)[0]
def _ru8(d, o):  return d[o]
def _ri16(d, o): return struct.unpack_from("<h", d, o)[0]
def _ri32(d, o): return struct.unpack_from("<i", d, o)[0]
def _ru32(d, o): return struct.unpack_from("<I", d, o)[0]
def _rf32(d, o): return struct.unpack_from("<f", d, o)[0]
def _rf64(d, o): return struct.unpack_from("<d", d, o)[0]
def _ru32be(d, o): return struct.unpack_from(">I", d, o)[0]

def _wi16(d, o, v): struct.pack_into("<H", d, o, v & 0xFFFF)
def _wi32(d, o, v): struct.pack_into("<i", d, o, v)
def _wu16(d, o, v): struct.pack_into("<H", d, o, v)
def _wu64(d, o, v): struct.pack_into("<Q", d, o, v)


# --- Huffman ---

@dataclass
class HuffmanParams:
    p0: int; p1: int; p2: int; p3: int


def read_huffman_params(data: bytes, offset: int) -> HuffmanParams:
    return HuffmanParams(
        _ri32(data, offset), _ri32(data, offset + 4),
        _ri32(data, offset + 8), _ri16(data, offset + 12),
    )


class HuffmanTable:
    __slots__ = ("data",)

    def __init__(self, data: list[bytearray]):
        self.data = data


def create_table(hp: HuffmanParams) -> HuffmanTable:
    class Node:
        __slots__ = ("index", "weight", "code", "depth", "left", "right")
        def __init__(self, index=-1, weight=0):
            self.index = index; self.weight = weight
            self.code = 0; self.depth = 0
            self.left = None; self.right = None

    nodes = []
    hp1 = hp.p1
    for i in range(hp.p3):
        n = Node(i, _i32(_u32(0xFFFFFFFF) // _u32(hp.p2 + hp1 * i)))
        nodes.append(n)
        hp1 += hp.p0

    while len(nodes) > 1:
        b1, b2 = nodes[-1], nodes[-2]
        parent = Node()
        parent.weight = _i32(b1.weight + b2.weight)
        parent.left = b1
        parent.right = b2
        nodes.pop()
        nodes.pop()
        # insertion sort
        ins = len(nodes)
        while ins > 0 and parent.weight > nodes[ins - 1].weight:
            ins -= 1
        nodes.insert(ins, parent)

    # assign codes + depths
    stack = [nodes[0]]

    class Info:
        __slots__ = ("code", "depth")
        def __init__(self): self.code = 0; self.depth = 0

    infos = [None] * hp.p3
    while stack:
        node = stack.pop()
        if node.index >= 0:
            info = Info()
            info.code = node.code
            info.depth = node.depth
            infos[node.index] = info
        if node.left:
            node.left.code = node.code * 2
            node.left.depth = node.depth + 1
            stack.append(node.left)
        if node.right:
            node.right.code = node.code * 2 + 1
            node.right.depth = node.depth + 1
            stack.append(node.right)

    # build lookup tables
    max_depths = bytearray(0x10001)
    secondary_idx = array("h", [0] * (0x20000 // 2))
    counter = 1

    for i in range(hp.p3):
        info = infos[i]
        if info.depth >= 17:
            dm16 = info.depth - 16
            idx5 = info.code >> dm16
            idx4 = secondary_idx[idx5]
            if idx4 == 0:
                secondary_idx[idx5] = counter
                idx4 = counter
                counter += 1
            if dm16 > max_depths[idx4]:
                max_depths[idx4] = dm16

    max_depths[0] = 16
    tables = []
    for j in range(counter):
        d = max_depths[j] if j < len(max_depths) else 16
        count = 1 << d
        buf = bytearray(8 * count)
        for c in range(count):
            _wu16(buf, 8 * c, 0xFFFF)
        tables.append(buf)

    for i in range(hp.p3):
        info = infos[i]
        if info.depth > 16:
            mod = info.code >> (info.depth - 16)
            b5val = secondary_idx[mod]
            _wi32(tables[0], 8 * mod, b5val)
            _wi32(tables[0], 8 * mod + 4, -max_depths[b5val])
            b4val = max_depths[b5val]
            dm16 = info.depth - 16
            lob = info.code & 0xFF
            ptr = (lob & ((1 << dm16) - 1)) << (b4val - dm16)
            ptr &= 0xFF
            _wi32(tables[b5val], 8 * ptr, i)
            _wi32(tables[b5val], 8 * ptr + 4, info.depth)
        else:
            ptr = info.code << (16 - info.depth)
            _wi32(tables[0], 8 * ptr, i)
            _wi32(tables[0], 8 * ptr + 4, info.depth)

    # fill gaps
    for j in range(counter):
        d = max_depths[j] if j < len(max_depths) else 16
        if d != 0:
            buf = tables[j]
            fill_val = struct.unpack_from("<Q", buf, 0)[0]
            count = 1 << d
            for c in range(1, count):
                if struct.unpack_from("<H", buf, c * 8)[0] == 0xFFFF:
                    _wu64(buf, c * 8, fill_val)
                else:
                    fill_val = struct.unpack_from("<Q", buf, c * 8)[0]

    return HuffmanTable(tables)


def _huff_decode(table: HuffmanTable, data: bytes, len1: int, len2: int) -> bytearray:
    read_buf = bytearray(len2 + 4)
    read_buf[:len2] = data[:len2]
    out = bytearray(len1 + 4)
    if len1 < 2:
        return out

    len2x8 = 8 * len2
    half = len1 // 2
    tbl0 = table.data[0]
    rs = 0
    inp = 0
    roff = 0
    woff = 0

    for _ in range(half):
        if rs <= 0:
            inp |= (_ru32be(read_buf, roff) << (32 - rs)) & MASK64
            rs += 32
            roff += 4
        neg = (inp >> 63) & 1
        rs2 = rs - 1
        inp2 = (inp * 2) & MASK64
        st = len2x8 - (8 * roff - (rs - 1))

        if st > 15:
            if rs <= 16:
                inp2 |= (_ru32be(read_buf, roff) << (33 - rs)) & MASK64
                roff += 4
                rs2 = rs + 31
            idx = (inp2 >> 48) & 0xFFFF
        else:
            if rs <= st:
                inp2 |= (_ru32be(read_buf, roff) << (33 - rs)) & MASK64
                roff += 4
                rs2 = rs + 31
            idx = ((inp2 >> (64 - st)) << (16 - st)) & 0xFFFF if st > 0 else 0

        fst_val = _ri8(tbl0, 8 * idx + 4)
        if fst_val <= 0:
            fst_neg = -fst_val
            tbl_idx = _ri32(tbl0, 8 * idx)
            if rs2 <= 15:
                inp2 |= (_ru32be(read_buf, roff) << (32 - rs2)) & MASK64
                rs2 += 32
                roff += 4
            rs3 = rs2 - 16
            inp3 = (inp2 << 16) & MASK64
            if rs2 - 16 < fst_neg:
                inp3 |= (_ru32be(read_buf, roff) << (48 - rs2)) & MASK64
                roff += 4
                rs3 = rs2 + 16
            oth_idx = (inp3 >> (64 - fst_neg)) & MASK64
            tbl_oth = table.data[tbl_idx]
            oth_val = _ri8(tbl_oth, 8 * int(oth_idx) + 4) - 16
            if rs3 < oth_val:
                inp3 |= (_ru32be(read_buf, roff) << (32 - rs3)) & MASK64
                rs3 += 32
                roff += 4
            rs = rs3 - oth_val
            inp = (inp3 << oth_val) & MASK64
            out_val = -_ri32(tbl_oth, 8 * int(oth_idx)) if neg else _ri32(tbl_oth, 8 * int(oth_idx))
            _wi16(out, woff, out_val & 0xFFFF)
        else:
            if rs2 < fst_val:
                inp2 |= (_ru32be(read_buf, roff) << (32 - rs2)) & MASK64
                rs2 += 32
                roff += 4
            inp = (inp2 << fst_val) & MASK64
            out_val = -_ri32(tbl0, 8 * idx) if neg else _ri32(tbl0, 8 * idx)
            _wi16(out, woff, out_val & 0xFFFF)
            rs = rs2 - fst_val

        woff += 2

    return out


# --- Edgebreaker ---

def _align3(x: int) -> int:
    return 3 * (x // 3)


def _decompress_list(out_buf, length: int, in_buf: bytes, sh: int) -> None:
    rs = 0
    ioff = 0
    ooff = 0
    inp = 0
    if length > 0:
        while True:
            if rs < sh:
                inp |= (_ru32be(in_buf, ioff) << (32 - rs)) & MASK64
                rs += 32
                ioff += 4
            result = (inp >> (64 - sh)) & MASK64
            rs -= sh
            inp = (inp << sh) & MASK64
            out_buf[ooff] = _i32(int(result))
            ooff += 1
            length -= 1
            if length == 0:
                break


def _decode_clers(b2: bytes, res9: int, b5unkn32: int, adj_a):
    buf_meta = array("i", [0] * res9)
    buf_clers = bytearray(res9 * 3)
    write_off = 0
    if b5unkn32 == 0:
        write_off = 0
        if res9 > 0:
            write_off = 1
            buf_clers[0] = ord("P")

    if write_off >= res9:
        raise ValueError("no decoding of data2")

    inp = 0
    rs = 0
    bmc = 0
    updown = 0
    roff = 0
    buf_meta_ctr = bmc

    while True:  # BIG_LOOP
        tri_ctr = 3 * write_off
        wbo = write_off
        oth_ctr = 0
        read_shift = rs

        while True:
            if read_shift <= 0:
                inp |= (_ru32be(b2, roff) << (32 - read_shift)) & MASK64
                read_shift += 32
                roff += 4
            rs = read_shift - 1
            out_val = ord("C")
            flag = 1 if (inp & 0x8000000000000000) else 0
            inp = (inp * 2) & MASK64
            if flag:
                if read_shift <= 2:
                    inp |= (_ru32be(b2, roff) << (33 - read_shift)) & MASK64
                    roff += 4
                    rs = read_shift + 31
                code = (inp >> 62) & 3
                rs -= 2
                inp = (inp * 4) & MASK64
                if code == 0:
                    break  # S
                if code == 3:
                    write_off += oth_ctr + 1
                    buf_clers[wbo + oth_ctr] = ord("E")
                    if updown > 0:
                        updown -= 1
                        if write_off < res9:
                            break  # continue BIG_LOOP via flag
                        return buf_meta_ctr, buf_meta, write_off, buf_clers
                    bmc = buf_meta_ctr + 1
                    if write_off < res9:
                        if bmc >= b5unkn32:
                            buf_clers[wbo + 1 + oth_ctr] = ord("P")
                            write_off = wbo + oth_ctr + 2
                        else:
                            buf_meta[buf_meta_ctr + 1] = write_off
                    if write_off >= res9:
                        buf_meta_ctr += 1
                        return buf_meta_ctr, buf_meta, write_off, buf_clers
                    buf_meta_ctr = bmc
                    break  # continue BIG_LOOP
                out_val = ord("L") if code == 2 else ord("R")

            buf_clers[write_off + oth_ctr] = out_val
            oth_ctr += 1
            tri_ctr += 3
            read_shift = rs
            if oth_ctr + write_off >= res9:
                write_off += oth_ctr
                return buf_meta_ctr, buf_meta, write_off, buf_clers
        else:
            continue

        if flag and code == 3:
            if updown > 0 and write_off < res9:
                continue
            continue
        if flag and code == 0:
            buf_clers[write_off + oth_ctr] = ord("S")
            idx = tri_ctr + 2 - _align3(tri_ctr + 2) + _align3(tri_ctr)
            if adj_a[idx] == -1:
                updown += 1
            write_off += oth_ctr + 1
            if write_off < res9:
                continue
            break

    return buf_meta_ctr, buf_meta, write_off, buf_clers


def _close_star(adj_a, adj_b, start, t2):
    tmp1 = _align3(start)
    tmp2 = tmp1 + start + 2 - _align3(start + 2)
    tmp3 = tmp2
    tmp4 = adj_a[tmp2]
    tmp5 = start

    while True:
        tmp6 = tmp5 + 1
        if tmp4 < 0:
            result = tmp1 + tmp6 - _align3(tmp6)
            adj_b[result] = t2
            break
        result = tmp1 + tmp6 - _align3(tmp6)
        adj_b[result] = t2
        if tmp4 == start:
            break
        tmp5 = adj_a[tmp3]
        tmp1 = _align3(tmp5)
        tmp2 = tmp1 + tmp5 + 2 - _align3(tmp5 + 2)
        tmp3 = tmp2
        tmp4 = adj_a[tmp2]

    if tmp2 >= 0:
        adj_a[tmp3] = start
    if start >= 0:
        adj_a[start] = tmp2


def _read_boundary(adj_a, adj_b, some_idx, out_num_ref):
    tmp1 = _align3(some_idx) + some_idx + 1 - _align3(some_idx + 1)
    result = 0
    while True:
        result = _align3(tmp1) + tmp1 + 1 - _align3(tmp1 + 1)
        tmp1 = adj_a[result]
        if tmp1 < 0:
            break

    tmp2 = out_num_ref[0]
    while True:
        tmp3 = _align3(result)
        adj_b[tmp3 + result + 1 - _align3(result + 1)] = tmp2
        result = tmp3 + result + 2 - _align3(result + 2)
        tmp4 = adj_a[result]
        i = out_num_ref[0]
        while tmp4 >= 0:
            tmp5 = _align3(tmp4)
            adj_b[tmp5 + tmp4 + 1 - _align3(tmp4 + 1)] = i
            result = tmp5 + tmp4 + 2 - _align3(tmp4 + 2)
            tmp4 = adj_a[result]
            i = out_num_ref[0]
        tmp2 = i - 1
        out_num_ref[0] = tmp2
        if adj_b[_align3(result) + result + 1 - _align3(result + 1)] != -1:
            break


def _process_clers(buf_meta, buf_meta_ctr, buf_clers, write_buf_off, _b5unkn32, res1, adj_a, adj_b):
    b5unkn32 = _b5unkn32
    if buf_meta_ctr <= 0:
        raise ValueError("bufMetaCtr <= 0")
    if write_buf_off <= 0:
        raise ValueError("writeBufOff <= 0")

    res1v = [0]
    res1v_min1 = [res1 - 1]
    tmp_buf = array("i", [0] * (3 * write_buf_off))
    write_buf_off -= 1

    while True:
        res9v = b5unkn32
        buf_meta_ctr -= 1
        tmp1 = -1

        while buf_meta_ctr >= b5unkn32 or (buf_meta_ctr >= 0 and write_buf_off >= buf_meta[buf_meta_ctr]):
            cv = buf_clers[write_buf_off]
            wm3 = 3 * write_buf_off

            if cv == ord("C"):
                if tmp1 >= 0:
                    adj_a[tmp1] = wm3 + 1
                if wm3 >= -1:
                    adj_a[wm3 + 1] = tmp1
                t2 = res1v_min1[0]
                res1v_min1[0] -= 1
                _close_star(adj_a, adj_b, wm3 + 2, t2)
                b5unkn32 = res9v
            elif cv == ord("L"):
                if tmp1 >= 0:
                    adj_a[tmp1] = wm3 + 1
                if wm3 >= -1:
                    adj_a[wm3 + 1] = tmp1
            elif cv == ord("E"):
                if tmp1 > 0:
                    tmp_buf[res1v[0]] = tmp1
                    res1v[0] += 1
            elif cv == ord("R"):
                t3 = wm3 + 2
                if tmp1 >= 0:
                    adj_a[tmp1] = t3
                if t3 >= 0:
                    adj_a[wm3 + 2] = tmp1
            elif cv == ord("S"):
                if tmp1 >= 0:
                    adj_a[tmp1] = wm3 + 1
                if wm3 >= -1:
                    adj_a[wm3 + 1] = tmp1
                t4 = wm3 + 2
                t5 = adj_a[wm3 + 2]
                if t5 == -1:
                    t6 = tmp_buf[res1v[0] - 1]
                    if t4 >= 0:
                        adj_a[wm3 + 2] = t6
                    res1v[0] -= 1
                    if t6 >= 0:
                        adj_a[t6] = t4
                elif t5 <= -2:
                    t7 = -t5
                    if t4 >= 0:
                        adj_a[wm3 + 2] = t7
                    adj_a[t7] = t4
                    while True:
                        t4 = _align3(t4) + t4 + 1 - _align3(t4 + 1)
                        t4_v = adj_a[t4]
                        if t4_v < 0:
                            break
                        t4 = t4_v
                    _read_boundary(adj_a, adj_b, t4, res1v_min1)
            elif cv == ord("P"):
                if tmp1 >= 0:
                    adj_a[tmp1] = wm3
                if write_buf_off >= 0:
                    adj_a[wm3] = tmp1
                _close_star(adj_a, adj_b, wm3 + 1, res1v_min1[0] - 2)
                _close_star(adj_a, adj_b, wm3 + 2, res1v_min1[0] - 1)
                _close_star(adj_a, adj_b, wm3, res1v_min1[0])
                res1v_min1[0] -= 3
                buf_meta_ctr -= 1
                b5unkn32 = res9v

            tmp1 = wm3
            write_buf_off -= 1

        if b5unkn32 != 0:
            _read_boundary(adj_a, adj_b, 3 * buf_meta[buf_meta_ctr] + 1, res1v_min1)
            b5unkn32 -= 1
        else:
            b5unkn32 = 0

        if buf_meta_ctr <= 0:
            break

    if res1v_min1[0] != -1:
        raise ValueError(f"res1v_min1ag not -1: {res1v_min1[0]}")


# --- main decompress ---

@dataclass
class RawMeshData:
    vertices: array    # float32, len = vertices_count*3
    vertices_count: int
    uv: array          # float32, len = uv_count*2
    uv_count: int
    faces: array       # int32
    res5: array        # int32
    res6: array        # int32
    res7: array        # int32
    res8: array        # int32
    faces_count: int


def _read_10_mesh_bufs(data: bytes, data_offset: int, ebta: HuffmanTable, ebtb: HuffmanTable):
    bufs = [None] * 10
    off = 120
    for i in range(10):
        len1 = _ru32(data, data_offset + 12 * i)
        len2 = _ru32(data, data_offset + 12 * i + 4)
        val = _ru8(data, data_offset + 12 * i + 8)

        out_buf = bytearray(len1 + 4)
        if val == 0:
            buf = data[data_offset + off : data_offset + off + len2]
            out_buf[:len2] = buf
        elif val == 3:
            buf = data[data_offset + off : data_offset + off + len2]
            hp = ebta if i != 7 else ebtb
            out_buf = _huff_decode(hp, buf, len1, len2)
        else:
            raise ValueError(f"unsupported buf type {val}")
        bufs[i] = out_buf
        off += len2
    return bufs


def decompress(data: bytes, data_offset: int, ebta: HuffmanTable, ebtb: HuffmanTable) -> RawMeshData:
    bufs = _read_10_mesh_bufs(data, data_offset, ebta, ebtb)

    b0 = bufs[0]
    i32_0 = _ri32(b0, 0)
    f64_0 = _rf64(b0, 4)
    f64_1 = _rf64(b0, 12)
    f64_2 = _rf64(b0, 20)
    f32_0 = _rf32(b0, 28)
    f32_1 = _rf32(b0, 32)
    f32_2 = _rf32(b0, 36)
    i8_0 = _ru8(b0, 40)
    res3 = _ri32(b0, 41)
    i32_1 = _ri32(b0, 45)
    i32_2 = _ri32(b0, 49)
    i8_1 = _ru8(b0, 53)
    i32_3 = _ri32(b0, 54)
    i32_4 = _ru32(b0, 58)

    if i32_0 < 0 or i8_0 == 0 or (i32_1 | i32_2) < 0 or i8_1 == 0 or (i32_4 & 0x80000000):
        raise ValueError("incorrect values in buf 0")

    b5 = bufs[5]
    res9 = _ri32(b5, 0)
    if res9 < 0:
        raise ValueError("res9 < 0")

    i32_0min32 = i32_0 - 32
    fst = i32_0min32
    snd = 32
    adj_a = array("i", [-1] * (res9 * 3))
    adj_b = array("i", [-1] * (res9 * 3))

    if i32_0min32 >= 128:
        while True:
            va = _ri32(b5, snd // 8)
            vb = _ri32(b5, snd // 8 + 4)
            if va >= 0:
                adj_a[va] = vb
            if vb >= 0:
                adj_a[vb] = va
            fst -= 64
            snd += 64
            if fst <= 127:
                break

    res1 = _ri32(b5, snd // 8)
    b5unkn32 = _ri32(b5, snd // 8 + 4)

    if (res1 | b5unkn32) < 0:
        raise ValueError("incorrect values in buf 5")

    buf_meta_ctr, buf_meta, write_buf_off, buf_clers = _decode_clers(bufs[2], res9, b5unkn32, adj_a)
    _process_clers(buf_meta, buf_meta_ctr, buf_clers, write_buf_off, b5unkn32, res1, adj_a, adj_b)
    res4 = adj_b

    # res7
    res7 = array("i", [0] * res9)
    _decompress_list(res7, i32_1, bufs[3], 1)
    if res9 <= 0:
        raise ValueError("res9 <= 0")

    bufres94 = array("i", [0] * res9)
    bufres94ptr = 1
    res9v_min1 = res9 - 1
    bufres94_tmp = 0
    tri_off = 2
    ctr = 0
    ctr2 = 0
    ctr3 = 0
    bufres94_res = 0

    while True:
        if bufres94_tmp == 0:
            ctr3 = 3 * ctr
            other = False
            if adj_a[tri_off - 2] == -1:
                other = True
            elif adj_a[tri_off - 1] == -1:
                ctr3 += 1
                other = True
            else:
                bufres94_res = 0
                ctr3 = tri_off
                if adj_a[tri_off] == -1:
                    other = True
            if other:
                res7_idx = ctr2
                ctr2 += 1
                bufres94_res = res7[res7_idx]
                if bufres94_res != 0:
                    inner = adj_a[_align3(ctr3) + ctr3 + 2 - _align3(ctr3 + 2)]
                    bufres94[inner // 3] = bufres94_res
                else:
                    bufres94_res = 0
            bufres94[bufres94ptr - 1] = bufres94_res

        if res9v_min1 == 0:
            break
        ctr += 1
        bufres94_tmp = bufres94[bufres94ptr]
        bufres94ptr += 1
        res9v_min1 -= 1
        tri_off += 3

    # res6
    res6 = array("i", [0] * res9)
    _decompress_list(res6, i32_2, bufs[4], i8_1)
    if i32_2 == 1 and res9 >= 2:
        for ii in range(1, res9):
            res6[ii] = res6[0]

    # res8
    d9dec = array("i", [0] * res1)
    _decompress_list(d9dec, i32_3, bufs[9], 1)
    bufoth_a = array("i", [0] * res1)
    bufoth_b = array("i", [0] * res1)
    for ii in range(3 * res9):
        if adj_a[ii] == -1:
            bufoth_b[res4[_align3(ii) + ii + 2 - _align3(ii + 2)]] = 1
            bufoth_b[res4[_align3(ii) + ii + 1 - _align3(ii + 1)]] = 1

    read_idx = 0
    for ii in range(res1):
        if bufoth_b[ii] != 0:
            bufoth_a[ii] = d9dec[read_idx]
            read_idx += 1
    res8 = bufoth_a

    # d8dec, d1dec
    d8dec = array("i", [0] * res1)
    _decompress_list(d8dec, res1, bufs[8], 1)
    d1dec = array("i", [0] * i32_4)
    _decompress_list(d1dec, i32_4, bufs[1], 1)

    # raw UV and vertex data
    data_6_uv = array("h", [0] * (len(bufs[6]) // 2))
    for ii in range(len(data_6_uv)):
        data_6_uv[ii] = _ri16(bufs[6], ii * 2)
    data_7_vtx = array("h", [0] * (len(bufs[7]) // 2))
    for ii in range(len(data_7_vtx)):
        data_7_vtx[ii] = _ri16(bufs[7], ii * 2)

    uv_unpacked = array("h", [0] * (res3 * 2))
    res5 = array("i", [0] * (res9 * 3))
    bf_res1_a = array("i", [0] * res1)
    bf_res1_b = array("i", [-1] * res1)
    bf_res9_a = array("i", [0] * res9)
    bf_res9_12b = array("i", [0] * (res9 * 3))
    bf_res9_12c = array("i", [0] * (res9 * 3))
    vtx_unpacked = array("h", [0] * (res1 * 3))
    bf_res6t = array("i", [0] * res9)

    res3 = 0
    ctr_a, ctr_c, ctr_b, ctr_d, ctd = 0, 0, 0, 0, 0

    def _unpack_uv(ctr_c_mul3):
        nonlocal res3
        for idx in [
            _align3(ctr_c_mul3) + ctr_c_mul3 + 2 - _align3(ctr_c_mul3 + 2),
            ctr_c_mul3,
            _align3(ctr_c_mul3) + ctr_c_mul3 + 1 - _align3(ctr_c_mul3 + 1),
        ]:
            uv_unpacked[2 * res3] = data_6_uv[2 * res3]
            uv_unpacked[2 * res3 + 1] = data_6_uv[2 * res3 + 1]
            res5[idx] = res3
            bf_res1_b[res4[idx]] = res5[idx]
            res3 += 1

    def _unpack_vtx(a_val):
        idx3 = adj_a[a_val]
        vh = 3 * res4[_align3(idx3) + idx3 + 1 - _align3(idx3 + 1)]
        vi = 3 * res4[_align3(idx3) + idx3 + 2 - _align3(idx3 + 2)]
        vj = 3 * res4[idx3]
        k = res4[a_val]
        vk = 3 * k
        vtx_unpacked[vk] = _i32(vtx_unpacked[vh] + vtx_unpacked[vi] - vtx_unpacked[vj] - data_7_vtx[vk]) & 0xFFFF
        vtx_unpacked[vk + 1] = _i32(vtx_unpacked[vh + 1] + vtx_unpacked[vi + 1] - vtx_unpacked[vj + 1] - data_7_vtx[vk + 1]) & 0xFFFF
        vtx_unpacked[vk + 2] = _i32(vtx_unpacked[vh + 2] + vtx_unpacked[vi + 2] - vtx_unpacked[vj + 2] - data_7_vtx[vk + 2]) & 0xFFFF
        # ponytail: int16 wrapping — mask to signed 16-bit via struct
        for off in (vk, vk + 1, vk + 2):
            vtx_unpacked[off] = struct.unpack("<h", struct.pack("<H", vtx_unpacked[off] & 0xFFFF))[0]
        bf_res1_a[k] = 1

    while True:
        # a: find next unvisited triangle
        if ctr_c < res9:
            while ctr_c < res9 and bf_res9_a[ctr_c] != 0:
                ctr_c += 1
        if ctr_c == res9:
            break

        # b: seed triangle
        bf_res9_12b[ctr_a] = 3 * ctr_c
        ctr_a += 1
        e1 = res4[_align3(3 * ctr_c) + 3 * ctr_c + 2 - _align3(3 * ctr_c + 2)]
        e2 = res4[3 * ctr_c]
        e3 = res4[_align3(3 * ctr_c) + 3 * ctr_c + 1 - _align3(3 * ctr_c + 1)]
        for e in (e1, e2, e3):
            vtx_unpacked[e * 3] = data_7_vtx[e * 3]
            vtx_unpacked[e * 3 + 1] = data_7_vtx[e * 3 + 1]
            vtx_unpacked[e * 3 + 2] = data_7_vtx[e * 3 + 2]
            bf_res1_a[e] = 1
        _unpack_uv(3 * ctr_c)

        # c: mark visited
        bf_res9_a[ctr_c] = 1
        bf_res6t[ctr_c] = res6[ctr_b]
        ctr_b += 1

        if ctd | ctr_a == 0:
            continue

        ctr_b_plus1 = ctr_b
        while True:
            cbp1o1 = -1
            if ctr_a != 0:
                cbp1o1 = ctr_b_plus1
            else:
                cntdwn = ctd - 1
                v = x = 0
                while True:
                    v = bf_res9_12c[cntdwn]
                    x = bf_res9_a[v // 3]
                    ctd -= 1
                    if ctd == 0 or x == 0:
                        break
                    cntdwn -= 1
                if x != 0:
                    ctr_a = 0
                    ctr_b = ctr_b_plus1
                    break  # continue BIG_LOOP

                for kk in range(res1):
                    bf_res1_b[kk] = -1
                if bf_res1_a[res4[v]] == 0:
                    _unpack_vtx(v)
                _unpack_uv(v)
                ctr_a = 1
                bf_res9_a[v // 3] = 1
                cbp1o1 = ctr_b_plus1 + 1
                bf_res6t[v // 3] = res6[ctr_b_plus1]
                bf_res9_12b[0] = v

            ctr_b_plus1 = cbp1o1
            ctr_a_min1 = ctr_a - 1
            cond = bf_res9_12b[ctr_a - 1]
            r6idx = cbp1o1 - 1
            ii = bf_res9_12b[ctr_a - 1]

            while True:
                a_val = adj_a[ii]
                if a_val >= 0 and bf_res9_a[a_val // 3] == 0:
                    idx1 = _align3(ii) + ii + 2 - _align3(ii + 2)
                    idx2 = _align3(ii) + ii + 1 - _align3(ii + 1)
                    other = True
                    if d8dec[res4[idx1]] != 0 and d8dec[res4[idx2]] != 0:
                        ctr_d += 1
                        if d1dec[ctr_d - 1] != 0:
                            bf_res9_12c[ctd] = a_val
                            ctd += 1
                            other = False
                    if other:
                        tmp1 = res4[a_val]
                        if bf_res1_a[tmp1] == 0:
                            _unpack_vtx(a_val)
                        r3tmp = bf_res1_b[tmp1]
                        if r3tmp == -1:
                            a_nxt = adj_a[a_val]
                            ni1 = res5[_align3(a_nxt) + a_nxt + 1 - _align3(a_nxt + 1)]
                            ni2 = res5[_align3(a_nxt) + a_nxt + 2 - _align3(a_nxt + 2)]
                            ni3 = res5[a_nxt]
                            nu = uv_unpacked[2 * ni1] + uv_unpacked[2 * ni2] - uv_unpacked[2 * ni3]
                            nv = uv_unpacked[2 * ni1 + 1] + uv_unpacked[2 * ni2 + 1] - uv_unpacked[2 * ni3 + 1]
                            r3tmp = res3
                            uv_unpacked[2 * r3tmp] = struct.unpack("<h", struct.pack("<H", (nu - data_6_uv[2 * r3tmp]) & 0xFFFF))[0]
                            uv_unpacked[2 * r3tmp + 1] = struct.unpack("<h", struct.pack("<H", (nv - data_6_uv[2 * r3tmp + 1]) & 0xFFFF))[0]
                            res3 += 1
                            bf_res1_b[res4[a_val]] = r3tmp
                        res5[a_val] = r3tmp
                        res5[_align3(a_val) + a_val + 2 - _align3(a_val + 2)] = res5[idx2]
                        res5[_align3(a_val) + a_val + 1 - _align3(a_val + 1)] = res5[idx1]
                        bf_res9_a[a_val // 3] = 1
                        bf_res6t[a_val // 3] = res6[r6idx]
                        bf_res9_12b[ctr_a_min1] = a_val
                        ctr_a_min1 += 1

                ii = _align3(ii) + ii + 1 - _align3(ii + 1)
                if ii == cond:
                    break

            ctr_a = ctr_a_min1
            if (ctd | ctr_a_min1) == 0:
                ctr_b = ctr_b_plus1
                break  # continue BIG_LOOP

    # final vertex/UV assembly
    vtx_buff = array("f", [0.0] * (res1 * 3))
    for ii in range(0, res1 * 3, 3):
        vtx_buff[ii] = float(vtx_unpacked[ii]) * f64_0 + f32_0
        vtx_buff[ii + 1] = float(vtx_unpacked[ii + 1]) * f64_1 + f32_1
        vtx_buff[ii + 2] = float(vtx_unpacked[ii + 2]) * f64_2 + f32_2

    scale = 1.0 / ((1 << i8_0) - 1)
    uv_buff = array("f", [0.0] * (res3 * 2))
    for ii in range(0, res3 * 2, 2):
        uv_buff[ii] = float(uv_unpacked[ii]) * scale
        uv_buff[ii + 1] = float(uv_unpacked[ii + 1]) * scale

    res6 = bf_res6t
    return RawMeshData(vtx_buff, res1, uv_buff, res3, res4, res5, res6, res7, res8, res9)
