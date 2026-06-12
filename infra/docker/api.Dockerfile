FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

COPY apps/api/pyproject.toml ./pyproject.toml
# Runtime deps only — dev tooling (pytest/ruff) does not belong in the image;
# `make test-api` runs against the local venv, and compose bind-mounts tests
# purely so they hot-reload alongside app code.
RUN pip install --upgrade pip && pip install -e .

COPY apps/api/app ./app
COPY apps/api/tests ./tests

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
