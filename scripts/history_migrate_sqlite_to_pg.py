#!/usr/bin/env python3
"""Stream the legacy SQLite position archive into the TimescaleDB hypertable
that apps/api/app/history_pg.py owns.

Run with the API DOWN so the live recorder is not competing for the same
table and the archive is quiescent while it is read:

    scripts/kill-port.sh 8000

Examples (repo root, api venv)::

    # Count what would be copied, write nothing. An EMPTY target (max(t) =
    # NULL) means since = None, so this reports the FULL archive:
    apps/api/.venv/bin/python scripts/history_migrate_sqlite_to_pg.py \
        --src data/history.db --dsn postgresql://velocity@127.0.0.1:5433/velocity \
        --dry-run

    # Do the copy (resumable; re-running a crashed run picks up where it left
    # off because since defaults to the target's max(t)):
    apps/api/.venv/bin/python scripts/history_migrate_sqlite_to_pg.py \
        --src data/history.db --dsn postgresql://velocity@127.0.0.1:5433/velocity \
        --batch 500000

    # Compress the just-written chunks now, so --measure does not have to wait
    # for the 12 h add_compression_policy to sweep them:
    apps/api/.venv/bin/python scripts/history_migrate_sqlite_to_pg.py \
        --src data/history.db --dsn postgresql://velocity@127.0.0.1:5433/velocity \
        --compress-now

    # Measure the compression ratio (SQLite bytes vs the hypertable bytes):
    apps/api/.venv/bin/python scripts/history_migrate_sqlite_to_pg.py \
        --src data/history.db --dsn postgresql://velocity@127.0.0.1:5433/velocity \
        --measure            # add --count for a full-scan row count

Reading: one read-only connection per source file (``file:...?mode=ro``),
pulled in ``fetchmany(batch)`` chunks, so an 11 GB archive is never loaded
whole into RAM. The per-row unit conversion reuses ``history_pg._record`` —
the live recorder's exact mapping, which already decodes the optional zlib
``extra`` blob via ``history._decode_extra`` — and only the trailing ``source``
byte is swapped from SOURCE_LIVE to SOURCE_MIGRATED (1), so a mixed archive
stays honest about provenance.

Resume / duplicates: the target ``positions`` hypertable has NO unique
constraint, so de-duplication is done purely by time ordering. Every run reads
the source with ``t > since``; ``since`` defaults to ``max(t)`` already in the
target (override with ``--since <epoch>``). That cutoff is what prevents
double-writes: a row at or under the cutoff is already in the target and is
never re-read. It also makes a re-run after a crash continue exactly where the
last committed batch stopped — on failure the script prints that last
committed ``t`` so you can re-run with ``--since <t>``. (The ``timestamptz``
column holds microseconds, so sub-microsecond ties straddling the cutoff are
the one case a re-read can re-copy; that property is shared with the live
recorder, which writes the same column.) For a list of source files, pass the
daily shards oldest-first (their time ranges are disjoint), which keeps the
resume exact across files too.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# This is a standalone tool, not part of the running API: it imports the app
# purely for the schema-apply + record-conversion helpers, and it must never
# start the background pollers, so pin the env before the app import.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))
os.environ.setdefault("OSINT_DISABLE_BACKGROUND", "1")

import asyncpg  # noqa: E402

from app import history_pg  # noqa: E402

# Read chunk size used by iter_rows when the caller does not pass one (tests).
_DEFAULT_FETCH = 50_000


def _iso(t: float | None) -> str:
    """Human UTC stamp for progress/resume lines, or a sentinel for None."""
    if t is None:
        return "<none (empty target — copy the whole archive)>"
    return datetime.fromtimestamp(float(t), tz=timezone.utc).isoformat()


def row_to_record(kind, id, t, lon, lat, track, extra_json):
    """Pure mapping: one legacy SQLite ``positions`` row -> one target record.

    The arguments are the seven source columns, in order. ``extra_json`` is
    the raw ``extra`` column value: either plain compact-JSON text or a
    zlib-compressed blob. It is decoded (tolerantly) by ``history._decode_extra``
    inside the reused converter, never re-implemented here.

    Delegates the field conversions to ``history_pg._record`` — the live
    recorder's exact unit mapping (micro-degrees, alt_m, speed in tenths of a
    knot, squawk-as-decimal, callsign/name, category) — and overrides only the
    trailing byte to ``SOURCE_MIGRATED``. Returns None for a row whose ``kind``
    is not aircraft/vessel (the live recorder skips those too).
    """
    record = history_pg._record((kind, id, t, lon, lat, track, extra_json))
    if record is None:
        return None
    return record[: len(history_pg._COLUMNS) - 1] + (history_pg.SOURCE_MIGRATED,)


def iter_rows(path: str, since: float | None, batch: int = _DEFAULT_FETCH):
    """Yield ``(kind, id, t, lon, lat, track, extra)`` rows with ``t > since``.

    Reads ONE source file through a single read-only connection, in t order,
    and pulls the rows in ``fetchmany(batch)`` chunks so the file is streamed,
    never loaded into RAM at once. ``since=None`` reads the whole file.
    """
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        if since is None:
            cur = con.execute(
                "SELECT kind, id, t, lon, lat, track, extra FROM positions ORDER BY t"
            )
        else:
            cur = con.execute(
                "SELECT kind, id, t, lon, lat, track, extra "
                "FROM positions WHERE t > ? ORDER BY t",
                (since,),
            )
        while True:
            chunk = cur.fetchmany(batch)
            if not chunk:
                return
            for row in chunk:
                yield row
    finally:
        con.close()


def count_rows(path: str, since: float | None) -> int:
    """How many source rows have ``t > since`` (a single SQL COUNT, no RAM)."""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        if since is None:
            row = con.execute("SELECT count(*) FROM positions").fetchone()
        else:
            row = con.execute(
                "SELECT count(*) FROM positions WHERE t > ?", (since,)
            ).fetchone()
        return int(row[0])
    finally:
        con.close()


async def _target_max_t(con: asyncpg.Connection) -> float | None:
    """The resume point when --since is not given: max(t) in the target.

    None when the target is still empty, in which case the whole archive is
    copied. The value is the float epoch of that timestamptz, so it lines up
    with the source's float ``t`` column.
    """
    dt = await con.fetchval("SELECT max(t) FROM positions")
    return dt.timestamp() if dt is not None else None


async def _copy_batch(con: asyncpg.Connection, records: list[tuple]) -> None:
    """One COPY, all-or-nothing. A failed batch rolls back, so the resume
    point is always the last batch that fully committed."""
    async with con.transaction():
        await con.copy_records_to_table(
            "positions", records=records, columns=history_pg._COLUMNS
        )


def _progress(copied: int, t0: float, last_t: float | None) -> None:
    elapsed = time.monotonic() - t0
    rate = copied / elapsed if elapsed > 0 else 0.0
    print(
        f"[migrate] {copied:>10} rows done  {rate:,.0f} rows/s  last t={_iso(last_t)}",
        flush=True,
    )


async def _stream_copy(
    con: asyncpg.Connection,
    src_files: list[str],
    since: float | None,
    batch: int,
    progress: dict,
) -> None:
    """Stream every source file (t > since) and COPY it in batches.

    Updates ``progress['copied']`` / ``progress['last_t']`` after each
    committed batch; the caller reads them on failure to build the
    ``--since`` resume line.
    """
    t0 = time.monotonic()
    last_t: float | None = since
    for path in src_files:
        buf: list[tuple] = []
        for row in iter_rows(path, since, batch=batch):
            record = row_to_record(*row)
            if record is None:
                continue
            buf.append(record)
            last_t = float(row[2])  # rows are in t order, so the max so far
            if len(buf) >= batch:
                await _copy_batch(con, buf)
                progress["copied"] += len(buf)
                progress["last_t"] = last_t
                _progress(progress["copied"], t0, last_t)
                buf.clear()
        if buf:
            await _copy_batch(con, buf)
            progress["copied"] += len(buf)
            progress["last_t"] = last_t
            _progress(progress["copied"], t0, last_t)


async def _compress_recent(con: asyncpg.Connection) -> int:
    """Compress chunks older than 1 h now, so --measure does not wait for the
    12 h add_compression_policy sweep. Returns how many chunks were targeted."""
    rows = await con.fetch(
        "SELECT compress_chunk(c, if_not_compressed => true) "
        "FROM show_chunks('positions', older_than => INTERVAL '1 hour') c"
    )
    return len(rows)


async def _measure(con: asyncpg.Connection, src_files: list[str], count: bool) -> None:
    """Print the SQLite bytes vs the hypertable bytes so the compression ratio
    is measured, not claimed."""
    total_sqlite = 0
    print("=== SQLite source (before) ===")
    for path in src_files:
        size = os.path.getsize(path)
        total_sqlite += size
        print(f"  {path}: {size:,} bytes ({size / 1e9:.3f} GB)")
    print(f"  total: {total_sqlite:,} bytes ({total_sqlite / 1e9:.3f} GB)")

    exists = await con.fetchval("SELECT to_regclass('positions') IS NOT NULL")
    if not exists:
        print("=== Postgres target (after) ===")
        print("  positions hypertable not present yet — nothing to measure")
        return

    size = int(await con.fetchval("SELECT hypertable_size('positions')") or 0)
    comp = await con.fetchrow(
        "SELECT coalesce(number_compressed_chunks, 0) AS nc, "
        "coalesce(before_compression_total_bytes, 0) AS before_bytes, "
        "coalesce(after_compression_total_bytes, 0) AS after_bytes "
        "FROM hypertable_compression_stats('positions')"
    )
    compressed = int(comp["nc"] or 0)
    before = int(comp["before_bytes"] or 0)
    after = int(comp["after_bytes"] or 0)
    chunks = int(
        await con.fetchval(
            "SELECT count(*) FROM timescaledb_information.chunks "
            "WHERE hypertable_name = 'positions'"
        )
        or 0
    )

    print("=== Postgres target (after) — positions hypertable ===")
    print(f"  hypertable_size: {size:,} bytes ({size / 1e9:.3f} GB)")
    print(f"  chunks: {chunks} total, {compressed} compressed")
    print(f"  compressed bytes: before {before:,} B -> after {after:,} B")
    if before > 0 and after > 0:
        print(f"  columnar compression ratio: {before / after:.2f}x")
    if total_sqlite > 0 and size > 0:
        print(
            f"  SQLite -> Postgres total: {total_sqlite:,} -> {size:,} bytes "
            f"({total_sqlite / size:.2f}x smaller)"
        )
    if count:
        rows = int(await con.fetchval("SELECT count(*) FROM positions") or 0)
        print(
            f"  row count: {rows:,}  (--count: a FULL scan of every chunk; "
            "omit it for a cheap size check)"
        )


async def run(args: argparse.Namespace) -> None:
    dsn = (args.dsn or os.environ.get("HISTORY_PG_DSN", "")).strip()
    if not dsn:
        sys.exit("--dsn not given and HISTORY_PG_DSN is unset")
    src_files = [str(Path(p).expanduser()) for p in args.src]
    for path in src_files:
        if not Path(path).is_file():
            sys.exit(f"source not found (not a regular file): {path}")

    con = await asyncpg.connect(dsn)
    try:
        print(f"[migrate] target: {history_pg.dsn_label(dsn)}")

        # --measure: just print the before/after sizes and stop.
        if args.measure:
            await _measure(con, src_files, args.count)
            return

        # Resume point: an explicit --since, else the target's max(t).
        if args.since is not None:
            since = float(args.since)
        else:
            since = await _target_max_t(con)
        print(
            f"[migrate] reading t > {_iso(since)} (explicit --since "
            f"= {args.since is not None})"
        )

        if args.dry_run:
            total = sum(count_rows(path, since) for path in src_files)
            print(f"[dry-run] {len(src_files)} source file(s)")
            print(
                f"[dry-run] would copy {total:,} rows with t > {_iso(since)} "
                "(writing nothing)"
            )
            return

        # Reuse the schema-apply function rather than restating the DDL: it is
        # idempotent and also reconciles the chunk/compress intervals.
        await history_pg.apply_schema(con)

        progress: dict = {"copied": 0, "last_t": since}
        try:
            await _stream_copy(con, src_files, since, args.batch, progress)
        except Exception:
            last = progress["last_t"]
            print(
                f"[migrate] FAILED after {progress['copied']:,} rows; "
                f"last committed t = {_iso(last)}"
            )
            if last is not None:
                print(f"[migrate] resume with --since {last} (t > {last})")
            raise

        print(
            f"[migrate] done: {progress['copied']:,} rows -> positions "
            f"(source={history_pg.SOURCE_MIGRATED})"
        )

        if args.compress_now:
            n = await _compress_recent(con)
            print(
                f"[compress-now] targeted {n} chunk(s) older than 1 h; "
                "measurement no longer waits for the policy"
            )
    finally:
        await con.close()


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        description="Stream the legacy SQLite history archive into the TimescaleDB "
        "positions hypertable (resumable; run with the API down)."
    )
    ap.add_argument(
        "--src",
        nargs="+",
        default=["./data/history.db"],
        help="SQLite archive(s) to read: one history.db and/or daily shards, "
        "oldest first.",
    )
    ap.add_argument(
        "--dsn",
        default=None,
        help="Postgres DSN (default: $HISTORY_PG_DSN)",
    )
    ap.add_argument(
        "--batch",
        type=int,
        default=500_000,
        help="rows per fetchmany / COPY batch (default 500000)",
    )
    ap.add_argument(
        "--since",
        type=float,
        default=None,
        help="resume epoch (t > this); default = max(t) already in the target",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="count the rows that would be copied; write nothing",
    )
    ap.add_argument(
        "--measure",
        action="store_true",
        help="print SQLite vs hypertable sizes and the compression ratio, then exit",
    )
    ap.add_argument(
        "--count",
        action="store_true",
        help="with --measure: also run SELECT count(*) (a full scan)",
    )
    ap.add_argument(
        "--compress-now",
        action="store_true",
        help="after copying, compress chunks older than 1 h now",
    )
    args = ap.parse_args(argv)
    if args.batch <= 0:
        ap.error("--batch must be a positive integer")
    if args.count and not args.measure:
        ap.error("--count only makes sense with --measure")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
