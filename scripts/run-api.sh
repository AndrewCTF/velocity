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
export LD_PRELOAD="libjemalloc.so.2${LD_PRELOAD:+:$LD_PRELOAD}"
export MALLOC_CONF="background_thread:true,dirty_decay_ms:10000,muzzy_decay_ms:10000"

exec apps/api/.venv/bin/python3 apps/api/.venv/bin/uvicorn \
  app.main:app --app-dir apps/api --port "${API_PORT:-8000}" "$@"
