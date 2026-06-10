FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

COPY apps/api/pyproject.toml ./pyproject.toml
RUN pip install --upgrade pip && pip install -e ".[dev]"

COPY apps/api/app ./app
COPY apps/api/tests ./tests

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
