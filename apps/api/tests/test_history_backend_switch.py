"""The history backend switch — hermetic, no database anywhere near it.

`history._backend()` decides which store every public function in `history.py`
delegates to. Getting it wrong is not a degraded feature, it is an archive
written to the wrong place: keyless boxes must stay on SQLite and keep
recording (a product requirement, not a dev convenience), and an operator who
turned Timescale off must actually get SQLite back.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator

import pytest

import app.history as H
from app.config import get_settings

_DSN = "postgresql://velocity@127.0.0.1:5433/velocity"


@contextlib.contextmanager
def _env(monkeypatch: pytest.MonkeyPatch, *, backend: str | None, dsn: str | None) -> Iterator[None]:
    """Set HISTORY_BACKEND / HISTORY_PG_DSN and clear the cached Settings.

    Both are DELETED rather than blanked when not wanted, so a developer (or CI)
    with either exported cannot make this file pass for the wrong reason —
    `history.py` reads the cached `get_settings()`, so the cache has to be
    cleared on the way in and on the way out.
    """
    monkeypatch.delenv("HISTORY_BACKEND", raising=False)
    monkeypatch.delenv("HISTORY_PG_DSN", raising=False)
    if backend is not None:
        monkeypatch.setenv("HISTORY_BACKEND", backend)
    if dsn is not None:
        monkeypatch.setenv("HISTORY_PG_DSN", dsn)
    get_settings.cache_clear()
    try:
        yield
    finally:
        monkeypatch.delenv("HISTORY_BACKEND", raising=False)
        monkeypatch.delenv("HISTORY_PG_DSN", raising=False)
        get_settings.cache_clear()


def test_default_is_sqlite_without_a_dsn(monkeypatch: pytest.MonkeyPatch) -> None:
    """auto + no DSN → SQLite. This is the keyless box, and it is the default."""
    with _env(monkeypatch, backend=None, dsn=None):
        assert get_settings().history_backend == "auto"
        assert H._backend() == "sqlite"


def test_auto_picks_timescale_when_a_dsn_is_set(monkeypatch: pytest.MonkeyPatch) -> None:
    with _env(monkeypatch, backend=None, dsn=_DSN):
        assert H._backend() == "timescale"


def test_explicit_sqlite_wins_over_a_dsn(monkeypatch: pytest.MonkeyPatch) -> None:
    """HISTORY_BACKEND=sqlite forces SQLite even with a DSN configured, so
    moving back does not mean unsetting the connection string."""
    with _env(monkeypatch, backend="sqlite", dsn=_DSN):
        assert H._backend() == "sqlite"


def test_explicit_timescale_needs_a_dsn(monkeypatch: pytest.MonkeyPatch) -> None:
    """Asking for Timescale with nothing to connect to falls back to SQLite
    rather than failing the boot — start() is what says so out loud."""
    with _env(monkeypatch, backend="timescale", dsn=None):
        assert H._backend() == "sqlite"
    with _env(monkeypatch, backend="timescale", dsn=_DSN):
        assert H._backend() == "timescale"


def test_backend_resolver_does_not_log(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """_backend() is called on every read. The boot warning belongs in start()
    and nowhere else, or a busy dashboard fills the log with it."""
    with _env(monkeypatch, backend=None, dsn=None):
        with caplog.at_level("DEBUG", logger="app.history"):
            for _ in range(5):
                H._backend()
        assert caplog.records == []


async def test_start_warns_once_when_auto_falls_back_to_sqlite(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, tmp_path
) -> None:
    """One warning at start(), naming the fallback."""
    monkeypatch.setattr(H, "_flush_task", None)
    monkeypatch.setattr(H, "_flush_loop", lambda: _noop())
    H.override_db_path(str(tmp_path / "switch.db"))
    try:
        with _env(monkeypatch, backend=None, dsn=None):
            with caplog.at_level("WARNING", logger="app.history"):
                H.start()
            warnings = [r for r in caplog.records if r.levelname == "WARNING"]
            assert len(warnings) == 1, [r.message for r in warnings]
            assert "HISTORY_PG_DSN" in warnings[0].getMessage()
    finally:
        H.override_db_path(None)
        task, H._flush_task = H._flush_task, None
        if task is not None:
            task.cancel()


async def test_start_warns_when_timescale_is_asked_for_without_a_dsn(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, tmp_path
) -> None:
    """A misconfiguration must not be silent: the archive is not where the
    operator thinks it is, and they need to be told which file it went to."""
    monkeypatch.setattr(H, "_flush_task", None)
    monkeypatch.setattr(H, "_flush_loop", lambda: _noop())
    H.override_db_path(str(tmp_path / "switch2.db"))
    try:
        with _env(monkeypatch, backend="timescale", dsn=None):
            with caplog.at_level("WARNING", logger="app.history"):
                H.start()
            messages = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
            assert any("HISTORY_BACKEND=timescale" in m for m in messages), messages
            assert any("switch2.db" in m for m in messages), messages
    finally:
        H.override_db_path(None)
        task, H._flush_task = H._flush_task, None
        if task is not None:
            task.cancel()


def test_stats_names_the_sqlite_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    """The storage keys mean different things per backend, so the payload says
    which one it is describing."""
    with _env(monkeypatch, backend=None, dsn=None):
        st = H.stats()
        assert st["backend"] == "sqlite"
        assert "db_path" in st and "shards" in st


def test_stats_names_the_timescale_backend_without_leaking_the_dsn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """stats() is served to the browser. A DSN can carry a password, so only
    host:port/db may appear — and the Timescale payload still answers the keys
    the frontend already reads (`retention_hours`)."""
    secret = "postgresql://velocity:hunter2@127.0.0.1:5433/velocity"
    with _env(monkeypatch, backend=None, dsn=secret):
        st = H.stats()
        assert st["backend"] == "timescale"
        assert st["pg"] == "127.0.0.1:5433/velocity"
        assert st["retention_hours"] >= 1
        assert st["sharded"] is False
        blob = repr(st)
        assert "hunter2" not in blob
        assert secret not in blob


def test_timescale_stats_carry_the_chunk_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    """Even with no pool ever opened, the snapshot answers with zeros rather
    than missing keys, so a caller never has to guess whether 'no chunks' means
    'not connected'."""
    with _env(monkeypatch, backend=None, dsn=_DSN):
        st = H.stats()
        for key in (
            "archive_bytes", "row_count", "chunks", "compressed_chunks",
            "compressed_bytes", "uncompressed_bytes", "stats_age_s",
        ):
            assert key in st, key


def test_schema_file_splits_into_idempotent_statements() -> None:
    """history_pg applies infra/db/20_history_timescale.sql one statement at a
    time (a continuous aggregate cannot be created inside a transaction). Prove
    the splitter finds the statements and that the file stays free of the
    dollar-quoted bodies it deliberately does not parse."""
    from app import history_pg

    sql = history_pg._SCHEMA_SQL.read_text(encoding="utf-8")
    stmts = history_pg.split_sql(sql)
    joined = " ".join(s.lower() for s in stmts)
    assert "$$" not in joined, "no DO blocks: the splitter does not parse them"
    assert any(s.lower().startswith("create extension") for s in stmts)
    assert any("create_hypertable" in s for s in stmts)
    assert any("positions_hourly" in s for s in stmts)
    assert "--" not in joined, "comments must be stripped, not sent to the server"
    # Every statement must be safe to re-send; the backend re-applies on boot.
    for stmt in stmts:
        low = stmt.lower()
        assert (
            "if not exists" in low
            or "if_not_exists" in low
            or low.startswith("alter table")
        ), stmt


def test_split_sql_respects_quotes_and_comments() -> None:
    from app import history_pg

    out = history_pg.split_sql(
        "SELECT 'a;b' AS x; -- a trailing ; comment\nSELECT 2;\n"
    )
    assert out == ["SELECT 'a;b' AS x", "SELECT 2"]


def test_dsn_label_never_returns_the_dsn() -> None:
    from app import history_pg

    assert history_pg.dsn_label("postgresql://u:p@db.internal:6000/vel") == "db.internal:6000/vel"
    assert history_pg.dsn_label("postgresql://velocity@127.0.0.1:5433/velocity") == (
        "127.0.0.1:5433/velocity"
    )
    # A malformed DSN must still produce a label rather than raise — the label
    # is what a failure path logs, so it cannot be the thing that fails.
    assert history_pg.dsn_label("") == "?:5432/?"
    assert "hunter2" not in history_pg.dsn_label("postgresql://u:hunter2@h:1/d")


def test_dsn_for_database_refuses_an_injected_name() -> None:
    from app import history_pg

    assert history_pg.dsn_for_database(_DSN, "velocity_test_1") == (
        "postgresql://velocity@127.0.0.1:5433/velocity_test_1"
    )
    with pytest.raises(ValueError):
        history_pg.dsn_for_database(_DSN, 'v"; DROP DATABASE velocity; --')


async def _noop() -> None:
    return None
