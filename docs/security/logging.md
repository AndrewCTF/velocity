# Log inventory

| Field | Value |
| --- | --- |
| Covers | OWASP ASVS 5.0 V16.1.1 (log inventory), V16.2.3 (logs go only to documented sinks); ISO/IEC 27001:2022 A.8.15, A.8.16, A.8.17 |
| Version | 1.0 (Draft until merged to `master`) |
| Adopted | 2026-09-13 |
| Owner | Maintainer (what the software writes); Operator (shipping, access and retention on the host) |
| Review | Yearly with the SoA, and whenever a sidecar, logger or audit store is added |
| Code citations | Working tree of branch `compliance-2026-09`, read on 2026-09-13 (base commit `56db34f`). Logging, audit, sidecar, compose and nginx code was being changed by parallel work at the time, so those files are cited by symbol name rather than line, and rows marked `<!-- recheck -->` must be re-read before merge |

The security events themselves (auth failures, lockouts, 401/403/429 responses, rate-limit refusals,
refused outbound fetches, refused hosts and origins) are catalogued in
[`auth-and-sessions.md`](auth-and-sessions.md), "Security event logging". This page lists **where** every
log goes.

## 1. Inventory

| # | Sink | What is written | Format | Where it is stored | Who can read it | Retention | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L1 | Application root handler | Every `app.*` logger at `LOG_LEVEL` (default `info`), including the `app.auth` and `app.security` security events | One line: ISO-8601 UTC timestamp with milliseconds, level, logger name, message; control characters in the message escaped | The process's standard error (a `logging.StreamHandler()` with no stream argument), which Docker captures as container logs | Anyone with `docker logs` access on the host (root or the `docker` group) | Docker's `json-file` driver by default, **no rotation** unless the operator sets `max-size`; or whatever the configured logging driver keeps | `configure`, `_UTCFormatter` in `apps/api/app/logging_setup.py`; `Settings.log_level`; called from the lifespan in `apps/api/app/main.py` <!-- recheck --> |
| L2 | `uvicorn.access` | One line per HTTP request: client address, method, path and query, status | uvicorn's own format | Container logs (as L1) | As L1 | As L1 | `RedactKeyFilter` replaces credential-named query values (`key`, `token`, `access_token`, `api_key`, `apikey`, `map_key`, `secret`) with `[redacted]`; installed by `install_access_log_redaction` (`apps/api/app/auth.py`) <!-- recheck --> |
| L3 | `uvicorn.error` | Server start and stop, WebSocket handshakes (which carry `?key=`), unhandled exceptions | uvicorn's own format | Container logs | As L1 | As L1 | Same `RedactKeyFilter` <!-- recheck --> |
| L4 | `httpx`, `httpcore` | One line per outbound request with the **full URL** (httpx writes it at `INFO`, `httpx/_client.py` in the api venv) | `HTTP Request: GET <url> "HTTP/1.1 200 OK"` | Container logs, through L1 | As L1 | As L1 | Held at `WARNING` whatever `LOG_LEVEL` says (`_URL_LOGGERS` in `apps/api/app/logging_setup.py`), because upstream keys ride in some URLs (FIRMS puts `FIRMS_MAP_KEY` in the path, `apps/api/app/routes/firms.py:48-51`) <!-- recheck --> |
| L5 | Sidecar child output | stdout and stderr of the ADS-B, browser-fetch, MAVLink, llama.cpp and vLLM child processes | Each tool's own | Files appended in `/tmp`: `/tmp/adsb-sidecar.log`, `/tmp/browser-fetch.log`, `/tmp/mavlink-bridge.log`, `/tmp/llamacpp-sidecar.log`, `/tmp/vllm-sidecar.log`. In production `/tmp` is a 512 MB tmpfs | Anyone who can `docker exec` into the api container | Until the container restarts (tmpfs); **no size cap per file** other than the tmpfs size | The `log_path` / `open("/tmp/…log")` in `apps/api/app/adsb_sidecar.py`, `browser_fetch.py`, `mavlink_sidecar.py`, `llamacpp_sidecar.py`, `vllm_sidecar.py`; `tmpfs:` for the api in `docker-compose.prod.yml` <!-- recheck --> |
| L6 | Local audit table `audit_log` | One row per audited mutation or MCP call: user id, action, resource, target, classification, argument names, actor email, client IP, user agent, UTC timestamp, and a hash chained to the previous row | SQLite rows; `BEFORE UPDATE` and `BEFORE DELETE` triggers refuse edits | `./data/audit_log.db` on the `osint_data` volume. Written **only when no `SUPABASE_URL` is set**; otherwise L7 | `GET /api/audit` (auditor or admin in multi-user mode; the local user otherwise), `GET /api/audit/verify` checks the chain; host root | `AUDIT_RETENTION_DAYS`, default `0` = keep everything; policy value 365 (§2) | `_LOCAL_DB_PATH_DEFAULT`, `_LOCAL_SCHEMA`, `_row_hash`, `prune_local_sync`, and the keyless branch of `audit()` in `apps/api/app/audit.py`; `Settings.audit_retention_days`; `apps/api/app/routes/audit.py` <!-- recheck --> |
| L6b | Local governed-action log `action_log` | One row per governed ontology write-back (action proposals approved and dispatched) | SQLite rows | `./data/action_log.db` on the `osint_data` volume, when no `SUPABASE_URL` is set | `GET /api/audit` reads it together with L6; host root | **No retention or cap** found (`grep` for prune or delete in the module, 2026-09-13) | `_DEFAULT_DB_PATH` in `apps/api/app/intel/action_log_local.py`; `get_audit` in `apps/api/app/routes/audit.py` <!-- recheck --> |
| L7 | Supabase `action_log` | The same row as L6 | PostgreSQL rows, append-only by trigger and revoked grants, row-level security | The operator's Supabase project | Per the project's RLS policies; Supabase dashboard users | Operator policy in Supabase | Module docstring and `_url` in `apps/api/app/audit.py` |
| L8 | Supabase `llm_calls` | One row per model completion: model, token counts, latency, tool calls, the user who asked. **No prompt text** | PostgreSQL rows | The operator's Supabase project | As L7 | Operator policy | `apps/api/app/llm.py:326-327`, `apps/api/app/llm.py:379` |
| L9 | nginx access log (production compose) | One line per request: client address, UTC time, method, **path without query string**, status, bytes, time, user agent | `noquery` log format | `/var/log/nginx/access.log` inside the nginx container | `docker exec` access on the host | Until the container is recreated; not rotated by the image config | `log_format noquery` and `access_log` in `infra/nginx/nginx.prod.conf` <!-- recheck --> |
| L10 | nginx error log | nginx's default error log | nginx default | nginx image default | As L9 | As L9 | No `error_log` directive in `infra/nginx/nginx.prod.conf` (`grep`, 2026-09-13) <!-- recheck --> |
| L11 | Host reverse proxy access and error logs | Whatever the operator's proxy writes; most proxies log the full request line **including `?key=`** by default | Operator's | Operator's host | Operator | Operator | Outside this repository; see [`operator-hardening.md`](operator-hardening.md) §1 |
| L12 | Supabase Auth (GoTrue) logs | Sign-ins, sign-ups, MFA events, admin factor removal | Supabase | The operator's Supabase project (Authentication > Logs) | Supabase dashboard users | Supabase plan limits | Outside this repository |

No other handler is attached by the application: `grep -rn 'FileHandler' apps/api/app` returns nothing
(2026-09-13), and `logging_setup.configure` adds exactly one handler, once. The web client writes no
server-side logs.

## 2. Rules

1. **Permitted sinks.** The application may write logs only to L1–L10 (including L6b). A new sink (file handler, log
   shipper, new table) needs a row here in the same change.
2. **Never logged.** Credentials, tokens, full alert-sink URLs, BYOK values, prompt text. Security events
   log the host, never the full URL, of a refused fetch (`apps/api/app/netguard.py:19-22`).
3. **Personal data.** Client IP addresses (D3) appear in L1–L3, L6, L7 and L9. They are needed to trace
   abuse and to apply the per-client lockout.
4. **Access.** Logs are readable only by host root, members of the `docker` group, and Supabase project
   admins. Operators must not add other users to the `docker` group, because that group is equivalent to
   root.
5. **Time.** Application timestamps are UTC (`_UTCFormatter` in `apps/api/app/logging_setup.py`).
   Containers use the host clock; the operator runs NTP on the host (SoA 8.17).
6. **Retention (policy, adopted 2026-09-13).** Container logs (L1–L5, L9, L10): 90 days, then deleted;
   the operator sets the logging driver's rotation. Audit rows (L6, L7): 365 days; set
   `AUDIT_RETENTION_DAYS=365` for L6 and an equivalent job in Supabase for L7.
7. **Integrity.** A host-level attacker can rewrite logs kept on the host. Ship L1–L4 off host with a
   Docker logging driver; `docker-compose.prod.yml` carries a commented `logging: driver: syslog` example
   <!-- recheck -->. The L6 hash chain makes an edit visible afterwards but does not prevent one by
   someone who can write the database file.

## 3. Known deviations

| Deviation | Evidence | Status |
| --- | --- | --- |
| Provider keys in outbound URLs were written to L1 by the `httpx` logger at `INFO` | Reproduced 2026-09-13 before the fix: `logging_setup.configure('info')` then an httpx request to `.../api/area/csv/SECRETMAPKEY/...` printed `INFO httpx HTTP Request: GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/SECRETMAPKEY/VIIRS/world/1`. Re-run later the same day against the working tree: no line printed | **Fixed in the working tree** by `_URL_LOGGERS` (L4); not yet committed <!-- recheck --> |
| Sidecar log files in `/tmp` have no size cap | L5 | Accepted; bounded by the 512 MB tmpfs and lost on restart |
| Audit retention defaults to keep-everything, and the governed-action log has no retention setting | L6 (`AUDIT_RETENTION_DAYS=0`), L6b | Operator sets the policy value for L6; L6b remains RA-09 <!-- recheck --> |
