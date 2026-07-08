# Cloudflare Containers image for the FastAPI OSINT backend.
# Build context is THIS directory (apps/api) so it is self-contained — the
# Velocity gateway Worker (site/wrangler.jsonc) references it as
# image: "../apps/api/Dockerfile" and `wrangler deploy` builds + pushes it to
# the Cloudflare container registry.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
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
