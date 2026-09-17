-- Position archive on Postgres + TimescaleDB (operator decision 2026-09-17).
--
-- This is the SAME archive `apps/api/app/history.py` keeps in SQLite, in the
-- store it moves to when HISTORY_PG_DSN is set. It is applied two ways:
--
--   1. by `apps/api/app/history_pg.py` at start(), statement by statement, on
--      every boot;
--   2. by the TimescaleDB container's /docker-entrypoint-initdb.d/ hook on a
--      fresh data volume (like 00_extensions.sql and friends next to it).
--
-- Both paths run it repeatedly, so EVERY statement here is idempotent.
--
-- Two constraints the file has to keep, or the backend's apply breaks:
--
--   * `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)` cannot run
--     inside a transaction block, and asyncpg sends a multi-statement string as
--     one implicit transaction. history_pg therefore SPLITS this file on
--     statement boundaries and sends one statement per execute(). The splitter
--     understands `--` comments and single-quoted strings and nothing else, so
--     do not add `$$` dollar-quoted bodies (no DO blocks, no function bodies).
--   * The chunk interval and the compression cut-off below are the DEFAULTS
--     (history_pg_chunk_hours=6, history_pg_compress_after_hours=12). The
--     backend reconciles both to the configured values right after applying
--     this file, so an operator who changed the settings does not have to edit
--     it, and psql-applying it by hand still produces a working archive.
--
-- Column encoding — the converters are in history_pg.py, keep them in step:
--
--   t         observation time (UTC). The SQLite column was a float epoch.
--   kind      0 = aircraft, 1 = vessel.
--   id        app-level entity id, verbatim: "aircraft:<icao24>", "vessel:<mmsi>".
--   lat_e6    latitude  x 1e6, rounded  (readsb's convention: exact to ~11 cm,
--   lon_e6    longitude x 1e6, rounded   4 bytes, and it delta-compresses well)
--   track_dd  course over ground in TENTHS of a degree (900 = 90.0 deg).
--   alt_m     barometric altitude in whole metres.
--   speed_dm  speed over ground in TENTHS of a knot (AIS SOG x 10).
--   callsign  flight id / vessel name as observed.
--   squawk    Mode-A code read as a decimal number (7700 stays 7700).
--   category  ADS-B emitter category / vessel type, verbatim.
--   source    provenance, so a mixed archive stays honest:
--               0 = observed by THIS deployment's own feed union (the only
--                   value the live recorder writes),
--               1 = migrated from the legacy SQLite archive,
--               2 = reserved for an opt-in backfill from a public upstream
--                   archive (never written by the recorder; the licence would
--                   live alongside it).
--
-- The typed columns replace SQLite's zlib'd `extra` JSON blob on purpose:
-- columnar compression works per column, and a JSON blob compresses as one
-- opaque string.

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS positions (
    t         timestamptz NOT NULL,
    kind      smallint    NOT NULL,
    id        text        NOT NULL,
    lat_e6    integer,
    lon_e6    integer,
    track_dd  smallint,
    alt_m     integer,
    speed_dm  smallint,
    callsign  text,
    squawk    smallint,
    category  text,
    source    smallint
);

SELECT create_hypertable('positions', 't', chunk_time_interval => INTERVAL '6 hours', if_not_exists => TRUE);

-- The per-identity scan behind /api/history/track ("where was this tail on
-- date X"), the counterpart of SQLite's idx_id_t.
CREATE INDEX IF NOT EXISTS idx_positions_id_t ON positions (id, t DESC);

-- Columnar compression. segmentby id keeps one contact's fixes together so a
-- per-id range scan reads one segment; orderby t DESC makes the newest fix the
-- cheap end, which is the direction every query runs.
ALTER TABLE positions SET (timescaledb.compress, timescaledb.compress_segmentby = 'id', timescaledb.compress_orderby = 't DESC');

SELECT add_compression_policy('positions', INTERVAL '12 hours', if_not_exists => TRUE);

-- Hourly rollup behind coverage() and the 1-hour timeseries bucket. The old
-- SQLite coverage aggregated the whole archive on every call (73 s over 78 M
-- rows, and it pinned a 49.6 GB WAL — docs/decisions.md 2026-07-16); this is
-- the fix that makes the answer cheap instead of cached-around.
--
-- materialized_only = false on purpose: the materialised part answers for
-- closed hours and Timescale UNIONs the live rows for the current one, so a
-- reader is never told the last ten minutes did not happen.
--
-- `ids` is count(DISTINCT id) per (hour, kind). It is exact PER BUCKET and is
-- NOT summable across buckets (a contact seen in two hours is one contact,
-- counted twice) — history_pg only reads it at a 1-hour bucket width and
-- queries the raw hypertable for any other width.
CREATE MATERIALIZED VIEW IF NOT EXISTS positions_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 hour', t) AS bucket,
       kind,
       count(*) AS n,
       count(DISTINCT id) AS ids
FROM positions
GROUP BY bucket, kind
WITH NO DATA;

SELECT add_continuous_aggregate_policy('positions_hourly', start_offset => NULL, end_offset => INTERVAL '10 minutes', schedule_interval => INTERVAL '10 minutes', if_not_exists => TRUE);
