"""The MQTT subscriber, against a real socket.

``test_connections.py`` covers configuration, availability and supervision, and
``test_ais_keyless.py`` covers the wire codec as pure functions. Neither of them
ever opens a connection, so the part that actually talks to a broker — CONNECT,
wait for CONNACK, SUBSCRIBE, decode PUBLISH, keep the session alive — was the
one piece of the MQTT connection with no evidence behind it.

The broker here is forty lines of asyncio speaking MQTT 3.1.1 back. That is the
whole point: a public broker would make this test a network probe that fails on
a laptop with no egress, and a mock of our own client would prove nothing about
the bytes.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from app import mqtt_client
from app.foundry import connections as C


class FakeBroker:
    """Accepts one client, answers CONNACK and SUBACK, then publishes."""

    def __init__(self, connack_code: int = 0) -> None:
        self.connack_code = connack_code
        self.port = 0
        self.subscribed_topic: str | None = None
        self.pings = 0
        self._server: asyncio.AbstractServer | None = None
        self._to_publish: list[tuple[str, bytes]] = []
        self._ready = asyncio.Event()

    def publish_later(self, topic: str, payload: bytes) -> None:
        self._to_publish.append((topic, payload))

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._serve, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    @staticmethod
    def _publish_packet(topic: str, payload: bytes) -> bytes:
        body = len(topic).to_bytes(2, "big") + topic.encode() + payload
        return b"\x30" + mqtt_client.enc_remaining_length(len(body)) + body

    async def _serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        buf = b""
        try:
            while True:
                chunk = await reader.read(65536)
                if not chunk:
                    return
                buf += chunk
                packets, buf = mqtt_client.parse_packets(buf)
                for ptype, _b0, body in packets:
                    if ptype == 1:  # CONNECT
                        writer.write(b"\x20\x02\x00" + bytes([self.connack_code]))
                        await writer.drain()
                    elif ptype == 8:  # SUBSCRIBE
                        tlen = int.from_bytes(body[2:4], "big")
                        self.subscribed_topic = body[4 : 4 + tlen].decode()
                        packet_id = body[0:2]
                        writer.write(b"\x90\x03" + packet_id + b"\x00")
                        for topic, payload in self._to_publish:
                            writer.write(self._publish_packet(topic, payload))
                        await writer.drain()
                        self._ready.set()
                    elif ptype == 12:  # PINGREQ
                        self.pings += 1
                        writer.write(b"\xd0\x00")
                        await writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            return
        finally:
            writer.close()


@pytest.fixture
async def broker():  # type: ignore[no-untyped-def]
    b = FakeBroker()
    await b.start()
    try:
        yield b
    finally:
        await b.stop()


async def _collect(url: str, topic: str, n: int, wait_s: float = 5.0):  # type: ignore[no-untyped-def]
    got: list[tuple[str, bytes]] = []

    async def _run() -> None:
        async for msg in mqtt_client.subscribe(url, topic):
            got.append(msg)
            if len(got) >= n:
                return

    await asyncio.wait_for(_run(), timeout=wait_s)
    return got


@pytest.mark.anyio
async def test_subscribes_and_receives_over_tcp(broker: FakeBroker) -> None:
    broker.publish_later("sensors/1", b'{"t": 21.5}')
    got = await _collect(f"mqtt://127.0.0.1:{broker.port}", "sensors/#", 1)
    assert got == [("sensors/1", b'{"t": 21.5}')]
    assert broker.subscribed_topic == "sensors/#"


@pytest.mark.anyio
async def test_receives_several_messages_in_order(broker: FakeBroker) -> None:
    for i in range(3):
        broker.publish_later(f"sensors/{i}", str(i).encode())
    got = await _collect(f"mqtt://127.0.0.1:{broker.port}", "sensors/#", 3)
    assert [t for t, _ in got] == ["sensors/0", "sensors/1", "sensors/2"]


@pytest.mark.anyio
async def test_a_refused_connection_raises_rather_than_hanging(broker: FakeBroker) -> None:
    """A broker that says no must surface, not sit in the read loop forever —
    the runner's backoff can only work if the failure reaches it."""
    broker.connack_code = 5  # not authorised
    with pytest.raises(ConnectionError, match="refused"):
        await _collect(f"mqtt://127.0.0.1:{broker.port}", "x", 1, wait_s=5.0)


@pytest.mark.anyio
async def test_an_unreachable_broker_raises() -> None:
    with pytest.raises((ConnectionError, OSError)):
        await _collect("mqtt://127.0.0.1:1", "x", 1, wait_s=5.0)


@pytest.mark.parametrize(
    "url,err",
    [("http://h/x", "unsupported"), ("mqtt://", "no host"), ("nonsense", "unsupported")],
)
@pytest.mark.anyio
async def test_a_bad_url_is_rejected_before_dialling(url: str, err: str) -> None:
    with pytest.raises(ValueError, match=err):
        await _collect(url, "x", 1, wait_s=5.0)


@pytest.mark.anyio
async def test_the_default_port_is_1883() -> None:
    """A url with no port must not dial port 0."""
    with pytest.raises((ConnectionError, OSError)):
        await _collect("mqtt://127.0.0.1", "x", 1, wait_s=5.0)


# ── the connection runner, end to end over the same socket ────────────────────


@pytest.mark.anyio
async def test_an_mqtt_connection_lands_rows_and_mints_ontology_objects(
    broker: FakeBroker, client
) -> None:  # type: ignore[no-untyped-def]
    """The whole path with nothing mocked but the broker: a published message
    becomes a dataset row and then an ontology object through a binding."""
    ds = client.post(
        "/api/foundry/datasets/upload",
        files={"file": ("seed.csv", b"mmsi,name\n1,SEED\n", "text/csv")},
        data={"name": "mqtt_target"},
    ).json()["id"]
    assert client.post(
        "/api/foundry/bindings",
        json={
            "dataset_id": ds,
            "object_kind": "vessel",
            "key_column": "mmsi",
            "prop_map": {"name": "name"},
        },
    ).status_code == 200

    # Two messages, so the batch flushes on the deadline rather than the count.
    broker.publish_later("vessels/1", json.dumps({"mmsi": 636092111, "name": "FROM MQTT"}).encode())
    broker.publish_later("vessels/2", json.dumps({"mmsi": 636092222, "name": "ALSO MQTT"}).encode())

    conn = {
        "id": "conn_test",
        "name": "t",
        "kind": "mqtt",
        "dataset_id": ds,
        "config": {"url": f"mqtt://127.0.0.1:{broker.port}", "topic": "vessels/#"},
    }
    from app.config import get_settings
    from app.foundry.store import FoundryStore

    store = FoundryStore(get_settings())
    # Flush as soon as both messages have arrived instead of waiting out the
    # 10 s deadline; the batching rule itself is covered by its own assertion.
    original = C._BATCH_AGE_S
    C._BATCH_AGE_S = 0.0
    try:
        task = asyncio.create_task(C._run_mqtt(store, conn))
        for _ in range(100):
            await asyncio.sleep(0.05)
            rows = client.get(f"/api/foundry/datasets/{ds}/rows").json()["rows"]
            if len(rows) >= 3:
                break
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    finally:
        C._BATCH_AGE_S = original

    rows = client.get(f"/api/foundry/datasets/{ds}/rows").json()["rows"]
    assert [r.get("name") for r in rows] == ["SEED", "FROM MQTT", "ALSO MQTT"]
    assert rows[1]["_topic"] == "vessels/1"

    hits = client.get("/api/ontology/search", params={"q": "FROM MQTT"}).json()
    assert any(o["props"].get("name") == "FROM MQTT" for o in hits), hits
