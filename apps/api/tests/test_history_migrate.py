"""Unit guard for scripts/history_migrate_sqlite_to_pg.py.

Hermetic: a throwaway SQLite archive is built in ``tmp_path`` and the script's
two pure seams are driven directly —

* ``row_to_record`` — one legacy row -> the target record tuple in
  ``history_pg._COLUMNS`` order, with the unit mapping (micro-degrees, tenths of
  a degree/knot, whole metres) and the optional zlib ``extra`` blob decoded; and
* ``iter_rows`` — the stream is ``ORDER BY t`` and honours ``t > since``.

No Postgres is touched. The target column list and the kind/source constants are
read from ``app.history_pg`` (the module the migration writes into) rather than
restated here, so a schema change breaks this test in the same commit.
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app import history, history_pg
from app.config import get_settings

ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = ROOT / "scripts" / "history_migrate_sqlite_to_pg.py"

# Two distinct, ordered fixes, inserted newest-first below.
T_AIRCRAFT = 1_700_000_000.0
T_VESSEL = 1_700_000_060.0

AIRCRAFT_ROW = ("aircraft", "aircraft:abc123", T_AIRCRAFT, -122.4194, 37.7749, 275.0)
VESSEL_ROW = ("vessel", "vessel:211234567", T_VESSEL, 4.4777, 51.9244, 92.5)

AIRCRAFT_EXTRA = {
    "callsign": "UAL123",
    "baro_alt_m": 10668,
    "squawk": "7700",
    "category": "A3",
}
VESSEL_EXTRA = {"name": "EVER GIVEN", "speed": 12.3, "ship_type": "Cargo"}


@pytest.fixture(scope="module")
def migrator():
    """Load the standalone script by path — it is not an importable package."""
    spec = importlib.util.spec_from_file_location("history_migrate_sqlite_to_pg", SCRIPT_PATH)
    assert spec and spec.loader, f"cannot load {SCRIPT_PATH}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _compressed_extra(monkeypatch: pytest.MonkeyPatch, extra: dict) -> bytes:
    """``history._encode_extra`` in its zlib branch, with the flag restored.

    The setting is off by default, so it is forced on for the call and the
    settings cache cleared on both sides — the archive's vessel row must carry a
    real compressed blob, not JSON text.
    """
    monkeypatch.setenv("HISTORY_COMPRESS_EXTRA", "1")
    get_settings.cache_clear()
    try:
        blob = history._encode_extra(extra)
    finally:
        monkeypatch.delenv("HISTORY_COMPRESS_EXTRA", raising=False)
        get_settings.cache_clear()
    assert isinstance(blob, bytes), "the compressed branch did not run"
    return blob


@pytest.fixture
def archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A two-row archive: one plain-JSON aircraft, one zlib-compressed vessel."""
    path = tmp_path / "history.db"
    con = sqlite3.connect(path)
    try:
        con.execute(
            "CREATE TABLE positions "
            "(kind TEXT, id TEXT, t REAL, lon REAL, lat REAL, track REAL, extra TEXT)"
        )
        # Newest-first on purpose: iter_rows' ORDER BY t has real work to do.
        con.executemany(
            "INSERT INTO positions VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (*VESSEL_ROW, _compressed_extra(monkeypatch, VESSEL_EXTRA)),
                (*AIRCRAFT_ROW, json.dumps(AIRCRAFT_EXTRA, separators=(",", ":"))),
            ],
        )
        con.commit()
    finally:
        con.close()
    return path


def _by_column(record: tuple) -> dict:
    assert len(record) == len(history_pg._COLUMNS)
    return dict(zip(history_pg._COLUMNS, record, strict=True))


def test_row_to_record_aircraft_plain_json(migrator) -> None:
    record = migrator.row_to_record(
        *AIRCRAFT_ROW, json.dumps(AIRCRAFT_EXTRA, separators=(",", ":"))
    )
    row = _by_column(record)

    assert row["t"] == datetime.fromtimestamp(T_AIRCRAFT, tz=UTC)
    assert row["kind"] == history_pg.KIND_AIRCRAFT
    assert row["id"] == "aircraft:abc123"
    assert row["lat_e6"] == round(37.7749 * 1e6)  # micro-degrees
    assert row["lon_e6"] == round(-122.4194 * 1e6)
    assert row["track_dd"] == round(275.0 * 10)  # tenths of a degree
    assert row["alt_m"] == 10668  # whole metres
    assert row["speed_dm"] is None  # aircraft carry no SOG
    assert row["callsign"] == "UAL123"
    assert row["squawk"] == 7700  # read as a decimal number, not octal
    assert row["category"] == "A3"
    assert row["source"] == history_pg.SOURCE_MIGRATED


def test_row_to_record_vessel_zlib_extra(migrator, monkeypatch) -> None:
    blob = _compressed_extra(monkeypatch, VESSEL_EXTRA)
    record = migrator.row_to_record(*VESSEL_ROW, blob)
    row = _by_column(record)

    assert row["kind"] == history_pg.KIND_VESSEL
    assert row["id"] == "vessel:211234567"
    assert row["lat_e6"] == round(51.9244 * 1e6)
    assert row["lon_e6"] == round(4.4777 * 1e6)
    assert row["track_dd"] == round(92.5 * 10)
    assert row["alt_m"] is None  # no barometric altitude on a vessel
    assert row["speed_dm"] == round(12.3 * 10)  # tenths of a knot
    assert row["callsign"] == "EVER GIVEN"  # name fallback
    assert row["squawk"] is None
    assert row["category"] == "Cargo"  # ship_type fallback
    assert row["source"] == history_pg.SOURCE_MIGRATED


def test_row_to_record_skips_unknown_kind(migrator) -> None:
    # The live recorder skips kinds it does not know; the migration must too.
    assert (
        migrator.row_to_record("satellite", "satellite:1", T_AIRCRAFT, 1.0, 2.0, 3.0, "{}") is None
    )


def test_iter_rows_orders_by_t_and_honours_since(archive: Path, migrator) -> None:
    rows = list(migrator.iter_rows(str(archive), None))
    assert [r[2] for r in rows] == [T_AIRCRAFT, T_VESSEL]  # t is column index 2
    assert [(r[0], r[1]) for r in rows] == [
        ("aircraft", "aircraft:abc123"),
        ("vessel", "vessel:211234567"),
    ]

    # Strictly greater, so a row already copied at the cutoff is never re-read.
    after_aircraft = list(migrator.iter_rows(str(archive), T_AIRCRAFT))
    assert [r[2] for r in after_aircraft] == [T_VESSEL]
    assert list(migrator.iter_rows(str(archive), T_VESSEL)) == []


def test_iter_rows_streams_in_fetchmany_chunks(archive: Path, migrator) -> None:
    # batch=1 exercises the fetchmany chunk loop rather than one big fetch.
    rows = list(migrator.iter_rows(str(archive), None, batch=1))
    assert [r[2] for r in rows] == [T_AIRCRAFT, T_VESSEL]


def test_streamed_rows_convert_end_to_end(archive: Path, migrator) -> None:
    """The exact pipeline _stream_copy runs: iter_rows -> row_to_record(*row)."""
    records = [migrator.row_to_record(*row) for row in migrator.iter_rows(str(archive), None)]
    assert all(r is not None for r in records)
    kinds = [row["kind"] for row in map(_by_column, records)]
    assert kinds == [history_pg.KIND_AIRCRAFT, history_pg.KIND_VESSEL]
    assert all(row["source"] == history_pg.SOURCE_MIGRATED for row in map(_by_column, records))


def test_cli_guards_reject_bad_batch_and_lone_count(migrator) -> None:
    with pytest.raises(SystemExit):
        migrator.main(["--batch", "0", "--dry-run"])
    with pytest.raises(SystemExit):
        migrator.main(["--count", "--dry-run"])
