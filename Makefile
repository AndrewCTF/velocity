.PHONY: up down logs ps test test-web test-api typecheck install

install:
	pnpm install
	cd apps/api && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

test: test-web test-api

test-web:
	pnpm -r test

test-api:
	cd apps/api && .venv/bin/pytest -q

typecheck:
	pnpm -r typecheck
