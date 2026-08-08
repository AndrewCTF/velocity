"""Apple Maps satellite tiles, keyless.

Apple's geo service hands its own clients a session out of a public manifest and
then signs every tile URL with it. There is no API key and no account: the
manifest URL and the first third of the signing token are the same constants
every copy of Maps on macOS ships with, and the other two thirds are minted per
session (one from the manifest, one random per request).

So the flow is:

1. GET the ResourceManifest (protobuf). It carries `token_p2` and, for each
   style, the tile host and that style's data VERSION. Style 7 is satellite.
2. Mint a 40-digit session id.
3. For each tile, AES-CBC encrypt `<path+query>&sid=<sid><expiry><nonce>` under
   `sha256(token_p1 + token_p2 + nonce)` and append it as `accessKey`.

A tile requested without the style's current `v` answers 410, so the version has
to come from the manifest rather than a constant — it moves.

Licensing: Apple's Maps ToS is not a redistribution licence. This is wired the
same way the other non-commercial basemaps are (`docs/commercial-licensing.md`):
the route refuses a commercial-tier request rather than quietly serving it.

The Flyover 3D-mesh ripper in `tools/apple-flyover/` speaks the same protocol
and is where this parser came from; it stays a separate tool because the backend
must not import out of `tools/`.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import secrets
import string
import struct
import time
from dataclasses import dataclass
from urllib.parse import quote, urlparse

from app.upstream import get_client

# The constants a stock macOS Maps client uses. Not credentials: they identify
# the client build, and Apple serves them to anyone who asks.
MANIFEST_URL = (
    "https://gspe35-ssl.ls.apple.com/geo_manifest/dynamic/config"
    "?application=geod&application_version=1&country_code=US"
    "&hardware=MacBookPro11,2&os=osx&os_build=20B29&os_version=11.0.1"
)
TOKEN_P1 = "4cjLaD4jGRwlQ9U"
SAT_STYLE = 7

_NONCE_CHARS = string.ascii_letters + string.digits
_IV = b"\x00" * 16
# A signed URL is minted with a +4200 s expiry; re-bootstrap well inside that.
_SESSION_TTL_S = 3000.0
# Apple's CDN tolerates ~20 concurrent requests fine; gate higher bursts (a
# cold pan fires 50-70 unique tiles) so we never trigger throttling.
_FETCH_SEMAPHORE = asyncio.Semaphore(24)


# ── protobuf wire reader ────────────────────────────────────────────────────
# The manifest is protobuf with no published schema, so fields are read by
# number. Field 30 is token_p2; each field 2 is a style config (1 = tile host,
# 3 = style id, 5 = a submessage whose field 1 is the style's data version).


def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        result |= (b & 0x7F) << shift
        pos += 1
        if not b & 0x80:
            return result, pos
        shift += 7
    return result, pos


def _fields(data: bytes) -> dict[int, list[bytes]]:
    out: dict[int, list[bytes]] = {}
    pos = 0
    while pos < len(data):
        tag, pos = _read_varint(data, pos)
        num, wire = tag >> 3, tag & 0x07
        if wire == 0:
            val, pos = _read_varint(data, pos)
            out.setdefault(num, []).append(struct.pack("<Q", val))
        elif wire == 2:
            length, pos = _read_varint(data, pos)
            out.setdefault(num, []).append(data[pos : pos + length])
            pos += length
        elif wire == 5:
            out.setdefault(num, []).append(data[pos : pos + 4])
            pos += 4
        elif wire == 1:
            out.setdefault(num, []).append(data[pos : pos + 8])
            pos += 8
        else:
            break
    return out


def _u64(raw: bytes) -> int:
    return struct.unpack("<Q", raw.ljust(8, b"\x00")[:8])[0]


@dataclass(frozen=True)
class Session:
    """One signing session: where satellite tiles live, and how to sign for them."""

    host: str
    version: int
    token_p2: str
    sid: str
    minted_at: float

    def sign(self, url: str) -> str:
        parsed = urlparse(url)
        nonce = "".join(secrets.choice(_NONCE_CHARS) for _ in range(16))
        key = hashlib.sha256((TOKEN_P1 + self.token_p2 + nonce).encode()).digest()
        expiry = int(time.time()) + 4200
        path = parsed.path + ("?" + parsed.query if parsed.query else "")
        sep = "&" if "?" in url else "?"
        plaintext = f"{path}{sep}sid={self.sid}{expiry}{nonce}".encode()
        pad = 16 - len(plaintext) % 16
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        enc = Cipher(algorithms.AES(key), modes.CBC(_IV)).encryptor()
        ct = enc.update(plaintext + bytes([pad]) * pad) + enc.finalize()
        access_key = f"{expiry}_{nonce}_{base64.b64encode(ct).decode()}"
        return f"{url}{sep}sid={self.sid}&accessKey={quote(access_key)}"

    def tile_url(self, z: int, x: int, y: int) -> str:
        # size=2 → 512×512 tiles (retina); scale is ignored for satellite.
        return self.sign(
            f"{self.host}?style={SAT_STYLE}&size=2&scale=1"
            f"&x={x}&y={y}&z={z}&v={self.version}"
        )


def parse_manifest(data: bytes) -> tuple[str, int, str]:
    """(satellite tile host, style version, token_p2) out of the raw manifest."""
    top = _fields(data)
    token_p2 = top[30][0].decode() if 30 in top else ""
    host, version = "", 0
    for raw in top.get(2, []):
        sf = _fields(raw)
        if _u64(sf.get(3, [b""])[0] if sf.get(3) else b"") != SAT_STYLE:
            continue
        url = sf.get(1, [b""])[0].decode()
        if not url:
            continue
        # Field 5 is the style's config submessage; its field 1 is the data
        # version the tile URLs must carry. A stale version answers 410.
        ver = 0
        for raw5 in sf.get(5, []):
            inner = _fields(raw5)
            if 1 in inner:
                ver = _u64(inner[1][0])
                break
        if ver:
            host, version = url, ver
            break
    if not host or not version or not token_p2:
        raise RuntimeError("Apple manifest carried no usable satellite style")
    return host, version, token_p2


_session: Session | None = None
_lock = asyncio.Lock()


async def session(force: bool = False) -> Session:
    """The current signing session, bootstrapped (once) on first use."""
    global _session
    async with _lock:
        fresh = _session is not None and time.monotonic() - _session.minted_at < _SESSION_TTL_S
        if fresh and not force:
            assert _session is not None
            return _session
        r = await get_client().get(MANIFEST_URL)
        r.raise_for_status()
        host, version, token_p2 = parse_manifest(r.content)
        _session = Session(
            host=host,
            version=version,
            token_p2=token_p2,
            sid="".join(secrets.choice("0123456789") for _ in range(40)),
            minted_at=time.monotonic(),
        )
        return _session


async def fetch_tile(z: int, x: int, y: int) -> bytes | None:
    """One satellite tile, or None if Apple would not serve it.

    size=2 → 512×512 tiles (retina); the Cesium provider keeps its default 256
    tile grid so the extra pixels become sharper textures, same as the Carto @2x
    basemap already does.

    A 401/403/410 means the session or the style version has moved on, so the
    manifest is re-read once and the tile retried — the alternative is a basemap
    that goes blank until the process restarts.
    """
    async with _FETCH_SEMAPHORE:
        for attempt in (0, 1):
            s = await session(force=attempt == 1)
            try:
                r = await get_client().get(s.tile_url(z, x, y))
            except Exception:
                return None
            if r.status_code == 200 and r.content:
                return r.content
            if r.status_code not in (401, 403, 410):
                return None
        return None
