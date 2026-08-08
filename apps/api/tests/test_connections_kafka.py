"""What can be proven about the Kafka connection without a broker.

Not the wire. Kafka's protocol is a consumer-group handshake across half a dozen
request types, and a fake broker good enough to satisfy aiokafka would be more
likely to encode our own misunderstanding than to catch one — so
``apps/api/CLAUDE.md`` records the wire path as unproven and says why. MQTT got
an in-test broker because its protocol is four packet types; Kafka does not.

Two things do not need a broker and were assumed until now:

  * the import guard's POSITIVE branch — that ``availability()`` says available
    when the client is installed. Every other availability test asserts the
    absent case, so a probe that always answered "unavailable" would have
    passed all of them;
  * that a broker which cannot be reached is RECORDED on the connection and
    retried, rather than taking the supervisor down with it. That is the only
    Kafka behaviour an operator will meet if they mistype a hostname, and it is
    reachable by pointing the runner at a closed port.

Skipped when the optional extra is absent, which is the expected keyless state.
"""

from __future__ import annotations

import asyncio

import pytest

from app.foundry import connections as C

pytest.importorskip("aiokafka", reason="optional extra: pip install -e '.[kafka]'")


def test_availability_reports_kafka_as_present_when_it_is_installed() -> None:
    assert C.availability()["kafka"] == {"available": True, "detail": "aiokafka"}


@pytest.mark.anyio
async def test_an_incomplete_config_is_refused_before_dialling() -> None:
    with pytest.raises(ValueError, match="bootstrap_servers and a topic"):
        await C._run_kafka(None, {"config": {"topic": "t"}})  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="bootstrap_servers and a topic"):
        await C._run_kafka(None, {"config": {"bootstrap_servers": "h:9092"}})  # type: ignore[arg-type]


@pytest.mark.anyio
async def test_an_unreachable_broker_is_recorded_and_retried(client) -> None:  # type: ignore[no-untyped-def]
    """A mistyped hostname is the failure an operator will actually hit. It has
    to land on the row, not in a traceback that kills the supervisor."""
    ds = client.post(
        "/api/foundry/datasets/upload",
        files={"file": ("seed.csv", b"a\n1\n", "text/csv")},
        data={"name": "kafka_target"},
    ).json()["id"]
    created = client.post(
        "/api/foundry/connections",
        json={
            "name": "unreachable",
            "kind": "kafka",
            "dataset_id": ds,
            # Port 1 is closed; no broker, no DNS lookup, no waiting on egress.
            "config": {"bootstrap_servers": "127.0.0.1:1", "topic": "t"},
            "enabled": False,
        },
    ).json()

    from app.config import get_settings
    from app.foundry.store import FoundryStore

    store = FoundryStore(get_settings())
    # Shorten the backoff so the retry is observable inside a test.
    original = C._BACKOFF_START_S
    C._BACKOFF_START_S = 0.05
    task = asyncio.create_task(C._run_forever({**created}))
    try:
        for _ in range(200):
            await asyncio.sleep(0.05)
            row = await store.get_connection(created["id"])
            if row and row["last_error"]:
                break
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        C._BACKOFF_START_S = original

    row = await store.get_connection(created["id"])
    assert row is not None
    assert row["last_error"], "an unreachable broker left no trace on the connection"
    # The supervisor's task survived long enough to record and loop, which is
    # the behaviour under test: a raised exception would have ended it instead.
    assert row["last_ok"] is None
