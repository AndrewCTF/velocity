# Cloudflare Containers image for the FastAPI OSINT backend.
# Build context is THIS directory (apps/api) so it is self-contained — the
# Velocity gateway Worker (site/wrangler.jsonc) references it as
# image: "../apps/api/Dockerfile" and `wrangler deploy` builds + pushes it to
# the Cloudflare container registry.
FROM python:3.12-slim

# jemalloc: WITHOUT this the container runs under glibc malloc, whose per-arena
# hoarding of the snapshot loop's churn (6-12 MB feed parses + a ~1 MB blob
# re-serialized/gzipped every ~1s across the ~80-thread executor) ratchets RSS
# into the tens of GB — the measured ~54 GB thrash that scripts/run-api.sh
# exists to prevent. python:3.12-slim installs it at the same multiarch path
# used by the dev host. LD_PRELOAD is set as ENV so it is in effect before
# uvicorn's first malloc (the allocator can't be swapped after that). The Node/
# Chromium sidecars scrub LD_PRELOAD from their child env (adsb_sidecar.py),
# so this never reaches Chrome's zygote.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libjemalloc2 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 \
    MALLOC_CONF=background_thread:true,dirty_decay_ms:10000,muzzy_decay_ms:10000 \
    # Velocity runs as a paid/commercial SaaS — default the backend to the
    # commercial-legal source set. The gateway still overrides per request via
    # the X-Velocity-Tier header (free sessions get the NC firehoses).
    COMMERCIAL_MODE=1

WORKDIR /srv

COPY pyproject.toml ./pyproject.toml
RUN pip install --upgrade pip && pip install -e .

COPY app ./app

# Run as an unprivileged user (defense-in-depth: the API shells out to recon/
# sidecar/YOLO subprocesses, so a process compromise must not land as root).
RUN useradd --system --uid 10001 --create-home --home-dir /home/app app \
    && chown -R app /srv
USER app

EXPOSE 8000
# Single worker: the global snapshot + AIS firehose + warmers are in-process
# singletons; multiple uvicorn workers would each run their own copy.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
