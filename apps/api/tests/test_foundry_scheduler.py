"""Guard: the schedule/orchestration layer.

Covers the `due_schedules()` timestamp-parsing edge cases (fresh, elapsed,
disabled, malformed-self-repair) and `_tick()`'s always-advance / never-raise
contract (success path, then a broken transform). Direct FoundryStore /
scheduler calls, no HTTP — mirrors `test_binding_direct_registry_roundtrip`'s
style in `test_foundry.py`. `OSINT_DISABLE_BACKGROUND=1` (set in conftest)
keeps the real background loop off; `_tick()` is called directly.
"""

from __future__ import annotations

import asyncio

from app.foundry import scheduler
from app.foundry import store as store_mod
from app.foundry.store import FoundryStore


def _set_schedule_fields(schedule_id: str, **fields: object) -> None:
    """White-box helper: patch schedule columns directly, bypassing the
    store's normal write paths, to construct edge-case timestamps a real
    caller never would."""
    con = store_mod._connect()
    try:
        set_clause = ", ".join(f"{k}=?" for k in fields)
        con.execute(
            f"UPDATE schedules SET {set_clause} WHERE id=?",
            (*fields.values(), schedule_id),
        )
        con.commit()
    finally:
        con.close()


async def _make_transform(store: FoundryStore) -> dict:
    ds_in = await store.create_dataset("sched_in", "")
    await store.add_version(
        ds_in["id"],
        [{"id": "1", "v": "a"}, {"id": "2", "v": "b"}],
        [{"name": "id", "type": "str"}, {"name": "v", "type": "str"}],
        source="upload",
    )
    ds_out = await store.create_dataset("sched_out", "", kind="derived")
    return await store.create_transform(
        "sched_tf", "", [ds_in["id"]], ds_out["id"], []
    )


# ── due_schedules() ─────────────────────────────────────────────────────────


def test_due_schedules_fresh_not_due_until_interval_elapses() -> None:
    async def run() -> None:
        store = FoundryStore()
        tf = await _make_transform(store)
        sched = await store.create_schedule(tf["id"], interval_s=3600)
        due = await store.due_schedules()
        assert sched["id"] not in {s["id"] for s in due}

    asyncio.run(run())


def test_due_schedules_elapsed_is_due() -> None:
    async def run() -> None:
        store = FoundryStore()
        tf = await _make_transform(store)
        sched = await store.create_schedule(tf["id"], interval_s=1)
        _set_schedule_fields(sched["id"], last_run="2020-01-01T00:00:00Z")
        due = await store.due_schedules()
        assert sched["id"] in {s["id"] for s in due}

    asyncio.run(run())


def test_due_schedules_disabled_never_due() -> None:
    async def run() -> None:
        store = FoundryStore()
        tf = await _make_transform(store)
        sched = await store.create_schedule(tf["id"], interval_s=1, enabled=False)
        _set_schedule_fields(sched["id"], last_run="2020-01-01T00:00:00Z")
        due = await store.due_schedules()
        assert sched["id"] not in {s["id"] for s in due}

    asyncio.run(run())


def test_due_schedules_malformed_last_run_due_once_then_self_repairs() -> None:
    async def run() -> None:
        store = FoundryStore()
        tf = await _make_transform(store)
        sched = await store.create_schedule(tf["id"], interval_s=3600)
        _set_schedule_fields(sched["id"], last_run="not-a-timestamp")

        due1 = await store.due_schedules()
        assert sched["id"] in {s["id"] for s in due1}

        # due_schedules() self-repairs last_run to now on the malformed hit,
        # so an immediate second call must NOT fire again (a malformed
        # timestamp can never make a schedule "always due").
        due2 = await store.due_schedules()
        assert sched["id"] not in {s["id"] for s in due2}

        schedules = await store.list_schedules()
        repaired = next(s for s in schedules if s["id"] == sched["id"])
        assert repaired["last_run"] != "not-a-timestamp"

    asyncio.run(run())


# ── _tick() ──────────────────────────────────────────────────────────────────


def test_tick_runs_due_schedule_and_records_success() -> None:
    async def run() -> None:
        store = FoundryStore()
        tf = await _make_transform(store)
        sched = await store.create_schedule(tf["id"], interval_s=0)

        await scheduler._tick()

        builds = await store.list_builds()
        assert len(builds) == 1
        assert builds[0]["status"] == "succeeded"

        schedules = await store.list_schedules()
        ran = next(s for s in schedules if s["id"] == sched["id"])
        assert ran["last_run"] is not None
        assert ran["last_error"] is None

    asyncio.run(run())


def test_tick_advances_last_run_and_records_error_on_broken_transform() -> None:
    async def run() -> None:
        store = FoundryStore()
        tf = await _make_transform(store)
        sched = await store.create_schedule(tf["id"], interval_s=0)

        # first tick: succeeds, primes last_run.
        await scheduler._tick()
        schedules = await store.list_schedules()
        first = next(s for s in schedules if s["id"] == sched["id"])
        assert first["last_run"] is not None
        assert first["last_error"] is None

        # break the transform: point its output at a dataset that doesn't exist.
        await store.update_transform(
            tf["id"], tf["name"], tf["description"], tf["inputs"], "ds_does_not_exist", tf["steps"]
        )

        # interval_s=0 keeps it due immediately; _tick must not raise.
        await scheduler._tick()

        builds = await store.list_builds()
        assert len(builds) == 2
        statuses = sorted(b["status"] for b in builds)
        assert statuses == ["failed", "succeeded"]

        schedules = await store.list_schedules()
        ran = next(s for s in schedules if s["id"] == sched["id"])
        assert ran["last_error"]
        assert ran["last_run"] is not None

    asyncio.run(run())
