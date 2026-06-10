-- Enable PostGIS + TimescaleDB on first boot. The TimescaleDB-HA image runs
-- every file in /docker-entrypoint-initdb.d/ on a fresh data volume.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS timescaledb;
