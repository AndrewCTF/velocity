# requires-python in apps/api/pyproject.toml / uv.lock is ">=3.12" — keep this
# aligned with that floor, not bumped independently of it.
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/srv/.venv \
    PATH="/srv/.venv/bin:$PATH"

WORKDIR /srv

# Pinned uv binary, not `pip install uv` — one fewer package puller in the
# build, and the version is bumped deliberately (Dependabot's docker
# ecosystem tracks this stage like any other FROM).
COPY --from=ghcr.io/astral-sh/uv:0.12.13@sha256:b485bd65cc2cf1c9a93b3554012c9c3778cf7b1b5fd3d3096ce9e1226c97e1e6 /uv /uvx /bin/

# bubblewrap: the op.python Workflows sandbox (app/workflows/python_exec.py)
# jails the block's subprocess with it when present and otherwise falls back
# to rlimits-only (no network isolation, no read-only root). Installing it
# here is what makes the stronger tier the deployed default; see
# python_exec.py's sandbox_tier() for how the fallback is reported, never
# silently assumed.
# `upgrade` pulls Debian security fixes newer than the pinned base digest
# (Trivy found fixable perl/pcre2/sqlite/gzip CVEs without it).
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# uv.lock is the source of truth. `--locked` (not `--frozen`) FAILS the build
# if pyproject.toml and the lock have drifted, instead of silently installing
# whatever the stale lock says — `--frozen` was tried first and shipped an
# image missing `huggingface_hub` (a hard dependency added to pyproject.toml
# after the lock was last regenerated; app.main import-errors without it).
# `--no-dev` keeps pytest/ruff out of the runtime image (tests are not in the
# image at all; the dev compose file bind-mounts them).
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY apps/api/app ./app
RUN uv sync --locked --no-dev

# Run as an unprivileged user (defense-in-depth: the API shells out to recon/
# sidecar/YOLO subprocesses, so a process compromise must not land as root).
RUN useradd --system --uid 10001 --create-home --home-dir /home/app app \
    && mkdir -p /srv/data/.tmp \
    && chown -R app /srv
USER app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
