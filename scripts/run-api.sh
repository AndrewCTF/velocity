#!/usr/bin/env bash
# Launch the OSINT API under jemalloc.
#
# WHY: the snapshot loop parses 6-12 MB feed bodies, re-serializes + gzips the
# ~6 MB world blob, and rebuilds 13-20k-feature dicts every second across a
# ~80-thread executor pool. Under sustained real load glibc's malloc hoards that
# churn as per-arena high-water and RSS ratchets into the tens of GB (a measured
# ~54 GB thrash with the CPU pegged on arena-lock contention). jemalloc is a
# proper multithreaded allocator that returns freed pages to the OS, so RSS stays
# bounded without the glibc M_ARENA_MAX contention hack (which made it worse).
#
# Run the backend with THIS instead of a bare `uvicorn` so LD_PRELOAD is set
# before the process starts (the allocator can't be swapped after first malloc).
# Runs from the repo root so pydantic's env_file resolves the intended .env
# (which carries ADSB_SIDECAR_ONLY=1 — the fresh-aircraft config).
set -euo pipefail
cd "$(dirname "$0")/.."

# Aggressive decay so freed memory is returned to the OS within ~10 s instead of
# lingering as RSS. background_thread runs the decay off the request path.
#
# Probed, not assumed. jemalloc is not a declared prerequisite anywhere (it is in
# neither README nor the Makefile), and an unconditional LD_PRELOAD on a box
# without it makes glibc print
#   ERROR: ld.so: object 'libjemalloc.so.2' from LD_PRELOAD cannot be preloaded
# ahead of uvicorn's first line. A first-time self-hoster reads that as "already
# broken" before the API has said anything at all. Say which path was taken
# instead, so a missing allocator is a note rather than an error.
JEMALLOC="$(ldconfig -p 2>/dev/null | awk '/libjemalloc\.so\.2/ {print $NF; exit}')"
if [ -n "$JEMALLOC" ]; then
  export LD_PRELOAD="$JEMALLOC${LD_PRELOAD:+:$LD_PRELOAD}"
  export MALLOC_CONF="background_thread:true,dirty_decay_ms:10000,muzzy_decay_ms:10000"
  echo "allocator: jemalloc ($JEMALLOC), 10 s decay"
else
  echo "allocator: glibc malloc (libjemalloc.so.2 not installed;" \
       "'sudo apt install libjemalloc2' returns freed memory to the OS faster)"
fi

exec apps/api/.venv/bin/python3 apps/api/.venv/bin/uvicorn \
  app.main:app --app-dir apps/api --port "${API_PORT:-8000}" "$@"
