"""A minimal MQTT 3.1.1 subscriber, over WebSocket or plain TCP.

The wire codec here was extracted verbatim from ``app/ais_keyless.py``, where it
was written to reach one hard-coded broker (Digitraffic). Nothing about encoding
a CONNECT packet is Digitraffic-specific, so a user-configurable MQTT connection
needs no new dependency and no second implementation — ``ais_keyless`` imports
these same functions and its existing guard test still exercises them, which is
what makes the move provably behaviour-preserving.

Only what a consumer needs: CONNECT, SUBSCRIBE, PINGREQ keepalive, and PUBLISH
decoding at QoS 0/1/2. No publishing, no session resumption, no MQTT 5. If a
broker ever needs those, that is the moment to weigh a real dependency.

Backoff and reconnection are the CALLER's: ``subscribe`` raises on a broken
transport rather than retrying, because how long to wait before dialling again
is a policy that differs per broker (see the 429-storm note in ``ais_keyless``).
"""

from __future__ import annotations

import asyncio
import ssl
import time
from collections.abc import AsyncIterator
from urllib.parse import urlparse

import websockets

MQTT_KEEPALIVE_S = 60.0
# Wake at least this often to send a PINGREQ, comfortably inside the keepalive.
_PING_EVERY_S = 25.0

# Packet types we act on.
_CONNACK = 2
_PUBLISH = 3
_SUBACK = 9
_PINGREQ = b"\xc0\x00"


# ── wire codec ────────────────────────────────────────────────────────────────


def enc_remaining_length(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        if n > 0:
            b |= 0x80
        out.append(b)
        if n == 0:
            break
    return bytes(out)


def connect_packet(client_id: str = "osint-geoint") -> bytes:
    # variable header: proto name "MQTT", level 4, clean-session flag, keepalive 60
    vh = b"\x00\x04MQTT\x04\x02\x00\x3c"
    payload = len(client_id).to_bytes(2, "big") + client_id.encode()
    body = vh + payload
    return b"\x10" + enc_remaining_length(len(body)) + body


def subscribe_packet(topic: str, packet_id: int = 1) -> bytes:
    body = packet_id.to_bytes(2, "big") + len(topic).to_bytes(2, "big") + topic.encode() + b"\x00"
    return b"\x82" + enc_remaining_length(len(body)) + body


def parse_packets(buf: bytes) -> tuple[list[tuple[int, int, bytes]], bytes]:
    """Parse complete MQTT packets from ``buf``.

    Returns ``([(packet_type, byte0, body), …], remainder)``. A frame may carry
    partial / multiple MQTT packets, so the caller accumulates the remainder
    across reads.
    """
    out: list[tuple[int, int, bytes]] = []
    i, n = 0, len(buf)
    while i < n:
        b0 = buf[i]
        ptype = b0 >> 4
        mult, rl, j = 1, 0, i + 1
        while True:
            if j >= n:
                return out, buf[i:]  # length incomplete
            d = buf[j]
            rl += (d & 0x7F) * mult
            mult *= 128
            j += 1
            if not (d & 0x80):
                break
            if mult > 128**4:
                return out, b""  # malformed; drop
        if j + rl > n:
            return out, buf[i:]  # body incomplete
        out.append((ptype, b0, buf[j : j + rl]))
        i = j + rl
    return out, b""


def decode_publish(byte0: int, body: bytes) -> tuple[str, bytes] | None:
    """Extract ``(topic, payload)`` from a PUBLISH packet body."""
    if len(body) < 2:
        return None
    qos = (byte0 >> 1) & 3
    tlen = int.from_bytes(body[0:2], "big")
    if len(body) < 2 + tlen:
        return None
    topic = body[2 : 2 + tlen].decode("utf-8", "replace")
    off = 2 + tlen + (2 if qos > 0 else 0)
    return topic, body[off:]


# ── transports ────────────────────────────────────────────────────────────────
# MQTT is the same byte stream either way; only how it is carried differs, so a
# two-method link is the whole abstraction.


class _Link:
    async def send(self, data: bytes) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    async def recv(self, wait_s: float) -> bytes | None:  # pragma: no cover
        raise NotImplementedError

    async def close(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError


class _WsLink(_Link):
    def __init__(self, ws: object) -> None:
        self._ws = ws

    async def send(self, data: bytes) -> None:
        await self._ws.send(data)  # type: ignore[attr-defined]

    async def recv(self, wait_s: float) -> bytes | None:
        try:
            msg = await asyncio.wait_for(self._ws.recv(), timeout=wait_s)  # type: ignore[attr-defined]
        except TimeoutError:
            return None
        return msg if isinstance(msg, bytes) else str(msg).encode()

    async def close(self) -> None:
        await self._ws.close()  # type: ignore[attr-defined]


class _TcpLink(_Link):
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._r, self._w = reader, writer

    async def send(self, data: bytes) -> None:
        self._w.write(data)
        await self._w.drain()

    async def recv(self, wait_s: float) -> bytes | None:
        try:
            chunk = await asyncio.wait_for(self._r.read(65536), timeout=wait_s)
        except TimeoutError:
            return None
        if chunk == b"":
            raise ConnectionError("broker closed the connection")
        return chunk

    async def close(self) -> None:
        self._w.close()
        try:
            await self._w.wait_closed()
        except OSError:
            pass


async def _open(url: str) -> _Link:
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    if scheme in ("ws", "wss"):
        ctx = ssl.create_default_context() if scheme == "wss" else None
        ws = await websockets.connect(
            url, subprotocols=["mqtt"], ssl=ctx, ping_interval=None
        )
        return _WsLink(ws)
    if scheme in ("mqtt", "mqtts", "tcp"):
        host = parsed.hostname
        if not host:
            raise ValueError(f"MQTT url has no host: {url!r}")
        port = parsed.port or (8883 if scheme == "mqtts" else 1883)
        ctx = ssl.create_default_context() if scheme == "mqtts" else None
        reader, writer = await asyncio.open_connection(host, port, ssl=ctx)
        return _TcpLink(reader, writer)
    raise ValueError(
        f"unsupported MQTT url scheme {scheme!r}: use mqtt, mqtts, ws or wss"
    )


async def subscribe(
    url: str, topic: str, *, client_id: str = "osint-geoint"
) -> AsyncIterator[tuple[str, bytes]]:
    """Yield ``(topic, payload)`` for every message on ``topic``.

    Runs until the caller stops consuming or the transport breaks, at which
    point the underlying exception propagates — reconnect policy belongs to the
    caller.
    """
    link = await _open(url)
    try:
        await link.send(connect_packet(client_id))
        buf = b""
        subscribed = False
        last_send = time.monotonic()
        while True:
            chunk = await link.recv(_PING_EVERY_S)
            if chunk:
                buf += chunk
                packets, buf = parse_packets(buf)
                for ptype, b0, body in packets:
                    if ptype == _CONNACK:
                        if len(body) > 1 and body[1] != 0:
                            raise ConnectionError(
                                f"broker refused the connection (code {body[1]})"
                            )
                        if not subscribed:
                            await link.send(subscribe_packet(topic))
                            last_send = time.monotonic()
                    elif ptype == _SUBACK:
                        subscribed = True
                    elif ptype == _PUBLISH:
                        pub = decode_publish(b0, body)
                        if pub is not None:
                            yield pub
            if time.monotonic() - last_send > _PING_EVERY_S:
                await link.send(_PINGREQ)
                last_send = time.monotonic()
    finally:
        await link.close()
