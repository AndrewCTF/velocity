"""Multi-root daily shards + change-based (complete) recording.

Two operator complaints drive this file: "backing up on a single disc is really
bad and the user cannot choose the place", and "the data is not complete, you
just cut a lot of it to save usage". Both were defaults, and both are pinned
here so they cannot drift back.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from app import history
from app.config import get_settings


@pytest.fixture(autouse=True)
def _clean():
    history.override_db_path(None)
    history._buffer.clear()
    history._last.clear()
    yield
    history.override_db_path(None)
    history._buffer.clear()
    history._last.clear()
    get_settings.cache_clear()


def _roots(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *dirs: Path) -> None:
    """Configure storage roots AND point the legacy path somewhere isolated.

    Without the second half the repo's real ./data/history.db joins the union as
    the "legacy" shard — which is correct in production (switching to roots must
    not strand existing history) and ruinous in a test.
    """
    get_settings.cache_clear()
    monkeypatch.setenv("HISTORY_ROOTS", ",".join(str(d) for d in dirs))
    get_settings.cache_clear()
    history.override_db_path(str(tmp_path / "legacy-absent.db"))


# ── completeness ─────────────────────────────────────────────────────────────


def test_a_moved_contact_is_recorded_every_time_it_is_seen() -> None:
    """The old rule dropped any fix inside 5 s that had moved under ~1.1 km, so
    a 1 Hz tick recorded one fix in five. Every distinct fix is now kept."""
    t0 = time.time()
    for i in range(5):
        history._buffer_point(
            "aircraft", "abc123", t0 + i, 10.0 + i * 0.0001, 50.0, 90.0, {}
        )
    assert len(history._buffer) == 5


def test_an_identical_observation_is_not_recorded_twice() -> None:
    """Completeness is 'every observation', not 'every poll'. A contact that has
    not moved between polls is not new information and costs nothing."""
    t0 = time.time()
    for i in range(5):
        history._buffer_point("aircraft", "abc123", t0 + i, 10.0, 50.0, 90.0, {})
    assert len(history._buffer) == 1


def test_a_turn_without_translation_is_a_new_observation() -> None:
    """track is part of the identity: a contact that turns in place has done
    something, and dropping it would lose the manoeuvre."""
    t0 = time.time()
    history._buffer_point("aircraft", "abc123", t0, 10.0, 50.0, 90.0, {})
    history._buffer_point("aircraft", "abc123", t0 + 1, 10.0, 50.0, 180.0, {})
    assert len(history._buffer) == 2


def test_sampling_is_opt_in_not_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """An operator can still trade completeness for disk — deliberately."""
    settings = get_settings()
    assert settings.history_min_interval_s == 0.0
    assert settings.history_min_move_deg == 0.0

    get_settings.cache_clear()
    monkeypatch.setenv("HISTORY_MIN_INTERVAL_S", "5")
    monkeypatch.setenv("HISTORY_MIN_MOVE_DEG", "0.01")
    get_settings.cache_clear()
    t0 = time.time()
    for i in range(5):
        history._buffer_point(
            "aircraft", "x", t0 + i, 10.0 + i * 0.0001, 50.0, 90.0, {}
        )
    assert len(history._buffer) == 1


# ── multi-root sharding ──────────────────────────────────────────────────────


def test_no_roots_configured_keeps_the_single_legacy_file() -> None:
    """An existing install must be unchanged until the operator asks."""
    assert history.sharded() is False


def test_a_new_day_opens_in_the_root_with_the_most_free_space(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    small, big = tmp_path / "small", tmp_path / "big"
    _roots(monkeypatch, tmp_path, small, big)
    monkeypatch.setattr(
        history, "_free_bytes", lambda p: 10 if str(p).startswith(str(big)) else 1
    )
    chosen = history._shard_path_for(time.time())
    assert str(chosen).startswith(str(big)), chosen
    assert chosen.name == f"{history._shard_day(time.time())}.db"


def test_an_existing_day_wins_over_free_space(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A root list reordered between boots must never split one day in two."""
    a, b = tmp_path / "a", tmp_path / "b"
    _roots(monkeypatch, tmp_path, a, b)
    day = history._shard_day(time.time())
    (a / "history").mkdir(parents=True)
    (a / "history" / f"{day}.db").write_bytes(b"")
    monkeypatch.setattr(history, "_free_bytes", lambda p: 10**9)  # b looks better
    assert history._shard_path_for(time.time()) == a / "history" / f"{day}.db"


def test_writes_land_in_a_chosen_root_and_read_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "chosen"
    _roots(monkeypatch, tmp_path, root)
    con = history._connect()
    con.execute(
        "INSERT INTO positions VALUES (?,?,?,?,?,?,?)",
        ("aircraft", "abc", time.time(), 1.0, 2.0, 3.0, "{}"),
    )
    con.commit()
    con.close()

    day = history._shard_day(time.time())
    assert (root / "history" / f"{day}.db").exists()

    read = history._read_connect()
    assert read.execute("SELECT COUNT(*) FROM positions").fetchone()[0] == 1
    read.close()


def test_a_read_spans_every_shard(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The whole point of the union view: an old day and today answer one query."""
    a, b = tmp_path / "a", tmp_path / "b"
    _roots(monkeypatch, tmp_path, a, b)
    now = time.time()
    for offset, root in ((-86400 * 3, a), (0, b)):
        path = root / "history" / f"{history._shard_day(now + offset)}.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        con = history._connect(str(path))
        con.execute(
            "INSERT INTO positions VALUES (?,?,?,?,?,?,?)",
            ("aircraft", "abc", now + offset, 1.0, 2.0, 3.0, "{}"),
        )
        con.commit()
        con.close()

    read = history._read_connect()
    assert read.execute("SELECT COUNT(*) FROM positions").fetchone()[0] == 2
    read.close()


def test_prune_unlinks_whole_days_instead_of_deleting_rows(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Retention by os.remove is what removes the DELETE+VACUUM path that
    produced the 49.6 GB WAL runaway (docs/decisions.md, 2026-07-16)."""
    root = tmp_path / "r"
    _roots(monkeypatch, tmp_path, root)
    now = time.time()
    old = root / "history" / f"{history._shard_day(now - 86400 * 10)}.db"
    cur = root / "history" / f"{history._shard_day(now)}.db"
    for path in (old, cur):
        path.parent.mkdir(parents=True, exist_ok=True)
        con = history._connect(str(path))
        con.commit()
        con.close()

    history.prune(retention_hours=48)
    assert not old.exists(), "a day entirely older than the cutoff should be gone"
    assert cur.exists(), "today must survive — the recorder is writing to it"


def test_budget_drops_oldest_shards_but_never_today(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "r"
    _roots(monkeypatch, tmp_path, root)
    now = time.time()
    days = [history._shard_day(now - 86400 * n) for n in (3, 2, 1, 0)]
    for day in days:
        path = root / "history" / f"{day}.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x" * 1000)

    dropped = history.enforce_budget(max_bytes=2500)
    assert dropped >= 1
    assert (root / "history" / f"{days[-1]}.db").exists(), "today is never dropped"
    assert history.archive_bytes() <= 2500 or dropped == 3


def test_stats_reports_where_the_archive_lives(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "r"
    _roots(monkeypatch, tmp_path, root)
    history._connect().close()
    st = history.stats()
    assert st["sharded"] is True
    assert st["roots"] == [str(root)]
    assert len(st["shards"]) == 1
    assert st["min_interval_s"] == 0.0 and st["min_move_deg"] == 0.0
