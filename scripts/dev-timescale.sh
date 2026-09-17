#!/usr/bin/env bash
# Local TimescaleDB for the history archive (dev only).
#
# Binds 127.0.0.1:5433, trust auth on loopback (no password to leak into a
# transcript), named volume so the archive survives container restarts. The
# image and digest are the same ones docker-compose.yml pins for a deployment.
#
#   bash scripts/dev-timescale.sh          # start (idempotent)
#   bash scripts/dev-timescale.sh stop     # stop, keep data
#   bash scripts/dev-timescale.sh psql     # open a shell
#
# Point the API at it with HISTORY_PG_DSN=postgresql://velocity@127.0.0.1:5433/velocity
set -euo pipefail
NAME=velocity-timescale
IMAGE=timescale/timescaledb:2.17.2-pg16@sha256:4e459e217f00cbb09920c34d245501e63427e6767a495de57ce76823ff280f12
PORT=${TIMESCALE_PORT:-5433}
case "${1:-start}" in
  stop) docker stop "$NAME" >/dev/null && echo "stopped $NAME"; exit 0 ;;
  psql) exec docker exec -it "$NAME" psql -U velocity -d velocity ;;
  start) ;;
  *) echo "usage: $0 [start|stop|psql]" >&2; exit 2 ;;
esac
if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "$NAME already running on 127.0.0.1:$PORT"; exit 0
fi
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  docker start "$NAME" >/dev/null
else
  docker run -d --name "$NAME" --runtime=runc \
    -p "127.0.0.1:$PORT:5432" \
    -e POSTGRES_USER=velocity -e POSTGRES_DB=velocity \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -v velocity-timescale:/var/lib/postgresql/data \
    --shm-size 1g \
    "$IMAGE" >/dev/null
fi
for _ in $(seq 1 30); do
  if docker exec "$NAME" pg_isready -U velocity -d velocity >/dev/null 2>&1; then
    echo "$NAME ready on 127.0.0.1:$PORT (HISTORY_PG_DSN=postgresql://velocity@127.0.0.1:$PORT/velocity)"; exit 0
  fi
  sleep 1
done
echo "$NAME did not become ready" >&2; exit 1
