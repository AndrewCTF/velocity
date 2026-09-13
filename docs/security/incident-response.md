# Incident response

Scope: a self-hosted Velocity deployment, run by the operator who holds its `.env`. Reporting a
vulnerability in the project is covered by [`SECURITY.md`](../../SECURITY.md). This runbook covers a
deployment that is, or may be, compromised.

## 1. Detect

Signals worth acting on:
- GitHub secret-scanning or Dependabot alerts on the repository.
- Unexpected rows in the audit trail. `GET /api/audit` lists every mutating call (workflows, foundry,
  evidence, models, ingest, alert rules, MCP tools) with actor and path.
- The startup banner reporting `auth DISABLED` on a box that should require a key (`app.auth` log).
- 429s from nginx `limit_req` or the API limiter from unexpected clients.
- `op.python` or `op.http` runs nobody scheduled.

## 2. Contain (first 30 minutes)

1. Take the stack off the network without destroying evidence: `docker compose -f docker-compose.prod.yml stop nginx`.
   The api container and its volume stay intact.
2. Snapshot state before changing anything: `scripts/backup-data.sh`. This writes a timestamped tar of
   the `osint_data` volume, which holds the audit DB, evidence locker and history.
3. Copy container logs: `docker compose -f docker-compose.prod.yml logs --no-color > incident-$(date +%F).log`.

## 3. Eradicate

1. Rotate every credential in `.env`: `API_KEY`, the Supabase JWT secret and service keys, provider
   API keys, per-dataset ingest tokens (re-mint in Foundry), and the Fernet key for stored BYOK keys.
   Rotating that key makes the stored BYOK keys unreadable, so users re-enter them.
2. Revoke the ghcr token or deploy keys if the host had them.
3. Pull a known-good release tag and recreate the containers:
   `VELOCITY_VERSION=<tag> docker compose -f docker-compose.prod.yml up -d --force-recreate`.
4. If the cause was a dependency advisory, confirm that the release carries the fix. The CI `security`
   job fails any build with a high npm advisory or a known Python vulnerability.

## 4. Recover

- Restore data only from a backup taken before the first bad audit row:
  `scripts/backup-data.sh --restore <file>`.
- Re-enable nginx, then watch `/api/audit` and the logs for a day.

## 5. Learn

Within a week, add an entry to `docs/decisions.md`. It should state what happened, the evidence, the
fix, and the guard test or CI check that now fails if the same gap comes back. If users' data was
exposed, the operator decides on notification under their own jurisdiction. ISO 27001 A.5.5 (contact
with authorities) and A.5.26 describe that obligation.
