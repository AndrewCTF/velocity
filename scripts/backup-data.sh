#!/usr/bin/env bash
# Back up (or restore) the `osint_data` named volume — the SQLite stores
# (history/ontology/foundry/workflows/alert-rules) and tile cache under the
# api container's /srv/data — via a throwaway alpine container, so this works
# the same whether the volume is mounted by a running container or not.
#
# Usage:
#   scripts/backup-data.sh                    # back up osint_data to ./backups/
#   scripts/backup-data.sh --volume NAME       # back up a different volume
#   scripts/backup-data.sh --out DIR           # write the tar.gz elsewhere
#   scripts/backup-data.sh --restore FILE      # restore a tar.gz into the volume
#
# Restore is destructive to the target volume's current contents (the archive
# is extracted over it, existing files are not removed first — this is a
# restore, not a sync). Stop the api container before restoring into a volume
# it is using.
set -euo pipefail

volume="osint_data"
out_dir="$(pwd)/backups"
restore_file=""

while [ $# -gt 0 ]; do
  case "$1" in
    --volume) volume=${2:?usage: --volume NAME}; shift 2 ;;
    --out) out_dir=${2:?usage: --out DIR}; shift 2 ;;
    --restore) restore_file=${2:?usage: --restore FILE}; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -n "$restore_file" ]; then
  restore_file=$(readlink -f "$restore_file")
  if [ ! -f "$restore_file" ]; then
    echo "backup file not found: $restore_file" >&2
    exit 1
  fi
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "volume '$volume' does not exist — creating it" >&2
    docker volume create "$volume" >/dev/null
  fi
  echo "restoring $restore_file into volume '$volume'"
  docker run --rm --runtime=runc \
    -v "$volume":/data \
    -v "$(dirname "$restore_file")":/backup:ro \
    alpine:3.20 \
    sh -c "tar -xzf /backup/$(basename "$restore_file") -C /data"
  echo "restore complete"
  exit 0
fi

if ! docker volume inspect "$volume" >/dev/null 2>&1; then
  echo "volume '$volume' does not exist — nothing to back up" >&2
  exit 1
fi

mkdir -p "$out_dir"
out_dir=$(readlink -f "$out_dir")
ts=$(date -u +%Y%m%dT%H%M%SZ)
archive="${volume}-${ts}.tar.gz"

echo "backing up volume '$volume' -> $out_dir/$archive"
docker run --rm --runtime=runc \
  -v "$volume":/data:ro \
  -v "$out_dir":/backup \
  alpine:3.20 \
  sh -c "tar -czf /backup/$archive -C /data ."

echo "wrote $out_dir/$archive"
