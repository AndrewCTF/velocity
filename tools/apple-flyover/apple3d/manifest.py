"""ResourceManifest protobuf parsing, altitude XML, and session bootstrap."""

import math
import re
import secrets
import struct
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Optional

import httpx

from .auth import sign_url

# --- raw protobuf wire format parser (no dependency) ---

def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        b = data[pos]
        result |= (b & 0x7F) << shift
        pos += 1
        if not (b & 0x80):
            return result, pos
        shift += 7


def _parse_fields(data: bytes) -> dict[int, list[bytes]]:
    fields: dict[int, list[bytes]] = {}
    pos = 0
    while pos < len(data):
        tag, pos = _read_varint(data, pos)
        field_num = tag >> 3
        wire_type = tag & 0x07
        if wire_type == 0:  # varint
            val, pos = _read_varint(data, pos)
            fields.setdefault(field_num, []).append(struct.pack("<Q", val))
        elif wire_type == 2:  # length-delimited
            length, pos = _read_varint(data, pos)
            fields.setdefault(field_num, []).append(data[pos : pos + length])
            pos += length
        elif wire_type == 5:  # 32-bit
            fields.setdefault(field_num, []).append(data[pos : pos + 4])
            pos += 4
        elif wire_type == 1:  # 64-bit
            fields.setdefault(field_num, []).append(data[pos : pos + 8])
            pos += 8
        else:
            break
    return fields


# --- data classes ---

C3M_STYLE = 15
C3MM_STYLE = 14


@dataclass
class StyleConfig:
    url_prefix: str
    style_id: int


@dataclass
class ResourceManifest:
    token_p2: str = ""
    cache_base_url: str = ""
    style_configs: list[StyleConfig] = field(default_factory=list)
    cache_files: list[str] = field(default_factory=list)

    def url_prefix(self, style_id: int) -> str:
        for sc in self.style_configs:
            if sc.style_id == style_id:
                return sc.url_prefix
        raise ValueError(f"no url prefix for style {style_id}")


@dataclass
class Trigger:
    name: str
    lat: float
    lon: float
    radius: float
    region: int
    version: int


@dataclass
class Context:
    manifest: ResourceManifest
    triggers: list[Trigger]
    sid: str
    token_p1: str
    c3m_prefix: str
    c3mm_prefix: str

    def auth_url(self, url: str) -> str:
        return sign_url(url, self.sid, self.token_p1, self.manifest.token_p2)

    def find_region(self, lat: float, lon: float) -> Trigger:
        best, best_dist = None, math.inf
        for t in self.triggers:
            d = math.sqrt((lat - t.lat) ** 2 + (lon - t.lon) ** 2)
            if d <= t.radius and d < best_dist:
                best, best_dist = t, d
        if best is None:
            raise ValueError(f"no flyover region covers ({lat}, {lon})")
        return best


# --- parsing ---

def parse_manifest(data: bytes) -> ResourceManifest:
    fields = _parse_fields(data)
    rm = ResourceManifest()
    if 30 in fields:
        rm.token_p2 = fields[30][0].decode()
    if 31 in fields:
        rm.cache_base_url = fields[31][0].decode()
    if not rm.cache_base_url:
        # field 31 removed in newer manifests; sub-field 92.2.1 has it
        for raw92 in fields.get(92, []):
            sf92 = _parse_fields(raw92)
            for raw_inner in sf92.get(2, []):
                inner = _parse_fields(raw_inner)
                for raw_url in inner.get(1, []):
                    url_str = raw_url.decode()
                    if url_str.startswith("https://") and url_str.endswith("/"):
                        rm.cache_base_url = url_str
                        break
                if rm.cache_base_url:
                    break
            if rm.cache_base_url:
                break
    for raw in fields.get(2, []):
        sf = _parse_fields(raw)
        url = sf.get(1, [b""])[0].decode()
        sid_raw = sf.get(3, [b"\x00"])[0]
        sid_val = struct.unpack("<Q", sid_raw.ljust(8, b"\x00"))[0] if sid_raw else 0
        if url:
            rm.style_configs.append(StyleConfig(url, int(sid_val)))
    for raw in fields.get(72, []):
        sf = _parse_fields(raw)
        fn = sf.get(2, [b""])[0].decode()
        if fn:
            rm.cache_files.append(fn)
    for raw in fields.get(9, []):
        rm.cache_files.append(raw.decode())
    return rm


def parse_altitude_xml(data: bytes) -> list[Trigger]:
    root = ET.fromstring(data)
    triggers = []
    for t_el in root.iter("trigger"):
        triggers.append(Trigger(
            name=t_el.get("name", ""),
            lat=float(t_el.get("latitude", 0)) / math.pi * 180,
            lon=float(t_el.get("longitude", 0)) / math.pi * 180,
            radius=float(t_el.get("radius", 0)),
            region=int(t_el.get("region", 0)),
            version=int(t_el.get("version", 0)),
        ))
    return triggers


# --- bootstrap ---

_ALT_RE = re.compile(r"^altitude[a-zA-Z0-9-]*\.xml$")


async def bootstrap(manifest_url: str, token_p1: str) -> Context:
    sid = "".join(secrets.choice("0123456789") for _ in range(40))
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(manifest_url)
        r.raise_for_status()
        rm = parse_manifest(r.content)

        alt_file = next((f for f in rm.cache_files if _ALT_RE.match(f)), None)
        if not alt_file:
            raise ValueError(f"no altitude file in manifest (files: {rm.cache_files})")

        alt_url = rm.cache_base_url + "xml/" + alt_file
        r2 = await client.get(alt_url)
        r2.raise_for_status()
        triggers = parse_altitude_xml(r2.content)

    return Context(
        manifest=rm,
        triggers=triggers,
        sid=sid,
        token_p1=token_p1,
        c3m_prefix=rm.url_prefix(C3M_STYLE),
        c3mm_prefix=rm.url_prefix(C3MM_STYLE),
    )
