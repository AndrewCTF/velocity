# Data protection

| Field | Value |
| --- | --- |
| Covers | OWASP ASVS 5.0 V14.1.1 (classification), V14.1.2 (protection requirements), V14.2.4 (at-rest controls), V14.3.3 (sensitive data in browser storage, §6); ISO/IEC 27001:2022 A.5.12, A.5.13, A.5.33, A.5.34, A.8.10, A.8.13 |
| Version | 1.1 (Draft until merged to `master`). 1.1 adds logging, log-access and privacy rows to §2, the D5 retention policy, and §6 browser storage |
| Adopted | 2026-09-13 |
| Owner | Maintainer (software controls); Operator (the data in a deployment, `DISCLAIMER.md` "Personal data") |
| Code citations | `path:line` at commit `2cd38d9`. Read them with `git show 2cd38d9:<path>` |

The operator is the data controller for everything a deployment collects (`DISCLAIMER.md`, "Personal
data"). This document says what the software stores, where, how it is protected, and what the operator must
add.

## 1. Data classification (V14.1.1)

Two schemes apply. The **handling class** below is for deployment data and extends the project scheme in
[`isms/README.md`](isms/README.md) §6. The **in-app marking** is the classification ladder the software
already enforces on intelligence rows.

### 1.1 Handling classes

| Class | What it covers | Examples and where they come from |
| --- | --- | --- |
| D1 Public feed data | Data anyone can fetch from public upstreams | ADS-B and AIS positions, quakes, weather, satellite elements; archived in history (`apps/api/app/config.py:614`) |
| D2 Configuration secrets | Credentials that grant access to the deployment or to paid upstreams | `API_KEY`, `SUPABASE_JWT_SECRET`, `BYOK_ENC_KEY`, provider keys (`apps/api/app/config.py:245`, `apps/api/app/config.py:311`, `apps/api/app/config.py:319`, `apps/api/app/config.py:439-448`), ingest token hashes, users' BYOK keys. Handling is in [`crypto-and-keys.md`](crypto-and-keys.md) |
| D3 User identities | Who uses the deployment | Supabase accounts and profiles (`apps/api/supabase/migrations/0000_profiles.sql`); `user_id`, `actor_email`, `ip` and `user_agent` in the audit log (`apps/api/app/audit.py:66-77`); the browser session (`apps/web/src/transport/supabase.ts:13`) |
| D4 Investigation data | What analysts are looking at and have concluded; often personal data about third parties | Ontology objects and assertions (`apps/api/app/config.py:696`), evidence blobs (`apps/api/app/config.py:710`), situations or cases (`apps/api/app/routes/situations.py:193`), Foundry datasets (`apps/api/app/config.py:719`), workflows and runs (`apps/api/app/config.py:724`), standing alert rules or watches (`apps/api/app/config.py:731`), browser saved searches and tasking questions (`apps/web/src/state/savedSearches.ts:22`, `apps/web/src/state/taskingQuestions.ts:18`) |
| D5 Audit records | Who changed what | Local `audit_log` table (`apps/api/app/audit.py:51`, `apps/api/app/audit.py:66-79`); Supabase `action_log` when configured (`apps/api/app/audit.py:1-9`) |
| D6 LLM prompts and outputs | Text sent to a model and the prose it returns | Prompts are built from D1 and D4 data and sent to the configured model provider (`apps/api/app/config.py:439-448`). The `llm_calls` row stores model, token counts and latency, not prompt text (`apps/api/app/llm.py:326-327`, `apps/api/app/llm.py:379-397`). Outputs are stored wherever the calling feature saves them; they have not been inventoried per feature |

### 1.2 In-app classification markings

`apps/api/app/intel/classification.py` implements a five-level ladder, from UNCLASSIFIED (0) through
CUI (1), CONFIDENTIAL (2) and SECRET (3) to TOP SECRET (4) (`apps/api/app/intel/classification.py:18-33`).
UNCLAS and U are accepted aliases (`apps/api/app/intel/classification.py:36-40`). A row also carries
positive compartments. A reader sees a row only if the row's level is at or below the reader's clearance
**and** the reader holds every compartment the row requires (`apps/api/app/intel/classification.py:3-5`).
An unparseable level becomes UNCLASSIFIED (`apps/api/app/intel/classification.py:46-48`). The agent redacts
tool results above the reader's clearance before the model sees them
(`apps/api/app/intel/agent.py:633-649`, `apps/api/app/intel/agent.py:989-991`). A keyless run operates at
UNCLASSIFIED (`apps/api/app/intel/agent.py:1063-1064`). Audit rows record the classification of the action
(`apps/api/app/audit.py:72`).

These markings control **visibility inside the application**. They are not an accreditation for handling
real government classified information, and nothing in this software is approved for that.

## 2. Protection requirements per class (V14.1.2)

| Requirement | D1 Public feed | D2 Secrets | D3 Identities | D4 Investigation | D5 Audit | D6 LLM |
| --- | --- | --- | --- | --- | --- | --- |
| Confidentiality | Low. Integrity and availability matter more | Highest: never logged, never returned after minting, encrypted where stored in a database | Personal data: authenticated access only; operator sets retention | Personal data about third parties: authenticated access; clearance and compartments where marked; encrypted volume required on any shared or cloud host | Access by operator or admin only | Treat as D4; the provider sees prompts (§5) |
| Integrity | Source and time recorded (history rows) | Tamper evident: Fernet authenticates its ciphertext | Supabase RLS | Assertions append-only with provenance (`apps/api/CLAUDE.md`, Ontology); evidence re-hashed before serving (`apps/api/app/routes/evidence.py:330-331`) | Written before the handler, as an attempt (`apps/api/CLAUDE.md`, Auth) | Model prose is labelled as model output |
| Availability | Bounded archive; loss acceptable | Recoverable from the operator's secret store | Supabase's service | Backed up (§4.2) | Backed up with the volume | Not required |
| In transit | TLS to upstreams (`apps/api/app/upstream.py:344-349`) | TLS at the host proxy | TLS at the host proxy | TLS at the host proxy | TLS at the host proxy | TLS to the provider |
| At rest | Plain; volume encryption optional | Encrypted (BYOK) or operator secret store | Supabase at rest; local fields plain | **Operator must encrypt the volume** | **Operator must encrypt the volume** | As the store that keeps them |
| Retention | Time and byte caps (§3) | Until rotated | Operator policy | Operator policy; the byte caps bound some stores (§3) | Policy: 365 days (adopted 2026-09-13). Local `audit_log` rows are pruned when `AUDIT_RETENTION_DAYS` is set (default 0, keep all); the local governed-action log has no retention (RA-09, [`logging.md`](logging.md) L6, L6b) <!-- recheck --> | As the store |
| Logging (what may appear in logs, [`logging.md`](logging.md)) | May be logged | **Never** | Security logs may record the client IP address and user id; never passwords or email one-time codes | **Never** in access or query logs. Identifiers such as looked-up domains may appear only in the audit row's argument names and targets. Known deviation: outbound URLs in the `httpx` log ([`logging.md`](logging.md) §3) | Is itself the log | **Never** prompt or completion text; metadata only (`llm_calls`) |
| Log access | Host root and the `docker` group | — | Host root, `docker` group, Supabase project admins | as D3 | Operator, auditor or admin role (`GET /api/audit`) and host root | Supabase project admins |
| Privacy-enhancing measures | None needed | Encryption of stored BYOK values (Fernet) | Minimal profile fields; IPs only in security and audit logs | Local models for sensitive work, so prompts never leave the host; operator-controlled egress proxy so lookups are not tied to the organisation's address (§5); clearance and compartments; sign-out clears browser copies (§6) | Argument **names** only for MCP calls | Local models; provider sees prompts otherwise |

## 3. At-rest controls, retention and deletion per store (V14.2.4)

**Plainly: none of the local stores below is encrypted by the application.** The SQLite databases, the
evidence directory and the tile cache are ordinary files under `./data` inside the api container, and the
production compose file mounts them from the named volume `osint_data` (`docker-compose.prod.yml:60`,
`docker-compose.prod.yml:116`). The only field-level encryption is the BYOK key column in Supabase
(`apps/api/app/keys.py:10-12`). Anyone with read access to the Docker host's volume directory, or to a
backup tarball, can read every local store.

| Store | Path (default) | Holds (class) | Encrypted at rest by the app | Access control | Retention and caps | Deletion |
| --- | --- | --- | --- | --- | --- | --- |
| history.db | `./data/history.db` (`apps/api/app/config.py:614`) | D1 | No | API auth | Time window `history_retention_hours` 168 h, clamped to at most 720 h (`apps/api/app/config.py:646`, `apps/api/app/config.py:652`, `apps/api/app/history.py:209-222`); byte cap `history_max_bytes` 2 GB (`apps/api/app/config.py:659`); optional budgets `history_budget_gb` and `history_disk_budget_gb` (`apps/api/app/config.py:631`, `apps/api/app/config.py:666`). Pruned at most hourly (`apps/api/app/history.py:62`) by `prune` and `enforce_size_cap` (`apps/api/app/history.py:874`, `apps/api/app/history.py:988`) | Automatic by the caps above |
| ontology.db | `./data/ontology.db` (`apps/api/app/config.py:696`) | D4, with markings | No | API auth; clearance and compartments (§1.2) | Byte cap 2 GB, oldest 10% of assertions dropped (`apps/api/app/config.py:699`, `apps/api/app/intel/ontology_local.py:21`, `apps/api/app/intel/ontology_local.py:775-783`); 2000 assertions per object (`apps/api/app/config.py:702`, `apps/api/app/intel/ontology_local.py:739`). Custody assertions are never trimmed (`apps/api/app/intel/ontology_local.py:742-745`, `apps/api/app/intel/ontology_local.py:784-790`) | Caps; situation delete route (`apps/api/app/routes/situations.py:230`). Personal data about a subject must be located and deleted by the operator; there is no subject-erasure function |
| foundry.db | `./data/foundry.db` (`apps/api/app/config.py:719`) | D4 and ingest token hashes (D2) | No (token stored as SHA-256, `apps/api/app/foundry/store.py:195-196`) | API auth; ingest route by token | 200,000 rows per dataset, 25 MB upload, 5 versions kept (`apps/api/app/foundry/store.py:145-147`); 200 monitor events kept (`apps/api/app/foundry/store.py:2143`, `apps/api/app/foundry/store.py:2157`) | Dataset delete removes rows, versions, bindings, checks and dead letters (`apps/api/app/foundry/store.py:416-422`) |
| workflows.db | `./data/workflows.db` (`apps/api/app/config.py:724`) | D4 | No | Mutations need operator (`apps/api/app/routes/workflows.py:200`) | 500 finished runs kept per workflow (`apps/api/app/workflows/store.py:89-93`, `apps/api/app/workflows/store.py:319`) | Workflow delete removes its runs (`apps/api/app/workflows/store.py:243`, `apps/api/app/routes/workflows.py:200`) |
| alert_rules.db | `./data/alert_rules.db` (`apps/api/app/config.py:731`) | D4 (what is watched) and sink URLs | No | API auth | No cap found | Rule delete route (`apps/api/app/routes/alert_rules.py:201`) |
| Audit DB | `./data/audit_log.db` (`apps/api/app/audit.py:51`) | D5 and D3 (`actor_email`, `ip`, `user_agent`, `apps/api/app/audit.py:74-76`) | No | `GET /api/audit` (`apps/api/app/routes/audit.py:40`) | **No retention or cap** (RA-09) | None in the app; operator deletes rows with SQLite |
| Evidence directory | `./data/evidence` (`apps/api/app/config.py:710`) | D4 blobs, content-addressed by SHA-256 (`apps/api/app/intel/evidence.py:142-144`) | No | API auth; served as an attachment with a sandbox CSP (`apps/api/app/routes/evidence.py:345-347`) | 200 MB per blob (`apps/api/app/config.py:713`); no total cap. The config comment says "created 0700" (`apps/api/app/config.py:707`), but `_write_blob` calls `mkdir` without a mode (`apps/api/app/intel/evidence.py:152`), so permissions follow the process umask | Write-once by design (`apps/api/app/intel/evidence.py:147-152`); `apps/api/app/routes/evidence.py` has no delete route. Deleting evidence breaks chain of custody, so the operator must record why |
| Tile cache | `./data/tilecache` (`apps/api/app/config.py:231`) | D1 (basemap and imagery tiles) | No | Served to the web app | 1 GB, LRU eviction (`apps/api/app/config.py:232`, `apps/api/app/tilecache.py:117-118`) | Automatic |
| Recon job directories | `.recon_jobs/` (`apps/api/app/config.py:293`) | D4 (uploaded imagery and video) | No | Compute-gated path (`apps/api/app/ratelimit.py:36`) | 40 jobs and 24 h TTL (`apps/api/app/config.py:296-297`), evicted in `apps/api/app/routes/recon.py:115-120` | Automatic; the whole job directory is removed |
| Browser localStorage | The user's browser profile | D3 (Supabase session, `persistSession: true` in `apps/web/src/transport/supabase.ts`), D4 (keys `velocity.captures`, `velocity.savedSearches`, `velocity.taskingQuestions`, `velocity.inbox.read`, `velocity.inbox.archived`, `osint.annotations`: `USER_DATA_KEYS` in `apps/web/src/auth/userData.ts`), device preferences, including the idle timer's last-activity time (`DEVICE_PREF_KEYS` in `apps/web/src/auth/userData.ts`) <!-- recheck --> | No | Same-origin policy; readable by any script that runs in the app origin (the CSP limits this, `apps/web/csp.ts`) | Captures capped at 200 and tasking questions at 30 (at `2cd38d9`: `apps/web/src/state/captures.ts:26`, `apps/web/src/state/taskingQuestions.ts:30`); others unbounded but small | D4 keys are removed on every Supabase sign-out (`apps/web/src/auth/AuthContext.tsx:50-52`; `clearUserData` in `apps/web/src/auth/userData.ts`); never cleared automatically in keyless or static-key mode (§6). Browser "clear site data" removes everything |
| Supabase (optional) | Operator's Supabase project | D3 profiles, BYOK ciphertext (`apps/api/app/keys.py:4-12`), `llm_calls` metadata (`apps/api/app/llm.py:405-406`), `action_log` audit (`apps/api/app/audit.py:1-9`) | BYOK values encrypted by the app; storage encryption is Supabase's (provider responsibility) | Row-level security, for example `auth.uid() = user_id` on `user_keys` (`apps/api/app/keys.py:8-10`); schemas in `apps/api/supabase/migrations/` and `infra/db/` | Operator policy in Supabase | Operator, in Supabase |

### 3.1 Operator guidance: encrypt the volume

The software cannot encrypt SQLite files without a different database driver, so encryption at rest is the
operator's control. Choose one:

1. **Full-disk or partition encryption on the Docker host** (recommended). Put `/var/lib/docker`, or at
   least the `osint_data` volume directory, on a LUKS2 device (`cryptsetup luksFormat`, then open at boot
   with a TPM2 or network-bound unlock). This covers the SQLite stores, the evidence directory, the tile
   cache and the container `/tmp` spool.
2. **Encrypted volume driver.** Back `osint_data` with an encrypted block device or a driver that encrypts,
   and keep the key off the host disk.
3. **Cloud host.** Use the provider's encrypted block storage with a customer-managed key. Remember that the
   provider can still read a running VM's memory.

Then restrict the volume directory to root and the container uid (the image runs as uid 10001,
`docs/security/gap-analysis-2026-09.md`, "Already in place"). Treat backups as the same class as the live
volume (§4.2).

## 4. Backups

### 4.1 What the script does

`scripts/backup-data.sh` tars the `osint_data` volume through a throwaway alpine container and writes
`<volume>-<timestamp>.tar.gz` to `./backups/` (`scripts/backup-data.sh:1-10`, `scripts/backup-data.sh:64-71`).
`--restore` extracts the archive over the volume (`scripts/backup-data.sh:11-16`). **The archive is not
encrypted and has no checksum**, so it holds every D3, D4 and D5 record in the clear.

### 4.2 Encrypted off-host backup guidance (adopted 2026-09-13; closes RA-20 as guidance)

1. **Stop or quiesce writes** first (`docker compose -f docker-compose.prod.yml stop api`), because the
   script copies live SQLite files. Or accept a crash-consistent copy.
2. **Encrypt immediately** and delete the plaintext tarball:
   `age -r <recipient-public-key> -o osint_data-<ts>.tar.gz.age osint_data-<ts>.tar.gz && shred -u osint_data-<ts>.tar.gz`
   (or `gpg --encrypt`). Keep the decryption key off the host, for example on a hardware token or in a
   password manager.
3. **Record a checksum** of the encrypted file (`sha256sum`), and verify it before any restore. This closes
   the RC.RP-03 gap for operators who follow it ([`csf-profile.md`](csf-profile.md)).
4. **Copy off host** to storage in a different failure domain, such as object storage with versioning and
   object lock, or another machine. `restic` or `borg` do steps 2 to 4 in one tool with encryption built in.
5. **Schedule** it with a systemd timer or cron at an interval that matches your acceptable data loss, and
   **keep** backups only as long as your retention policy for D4 data allows. Old backups are personal-data
   copies too.
6. **Test a restore** into a scratch volume at least quarterly: `scripts/backup-data.sh --restore <file> --volume osint_restore_test`.
7. **Do not back up `.env` in the same archive.** Store secrets in a secret manager or a separately
   encrypted copy ([`crypto-and-keys.md`](crypto-and-keys.md) §1.1).

## 5. What OSINT lookups disclose to third parties

Every lookup is an outbound request from the deployment's IP address. It tells the upstream provider what,
or whom, the analyst is investigating.

| Lookup | Sent to | Disclosed | Citation |
| --- | --- | --- | --- |
| Email avatar check | Gravatar and Libravatar | MD5 of the target email address. The address is recoverable by dictionary attack, so treat it as disclosing the address | `apps/api/app/osint/connectors.py:262`, `apps/api/app/osint/sources/social.py:77` |
| Breach check | Have I Been Pwned (when a key is set) | The target email address, tied to the operator's paid API key | `apps/api/app/config.py:733-736` |
| Domain and IP | rdap.org, crt.sh, Shodan InternetDB, certspotter | The target domain or IP | `apps/api/app/osint/connectors.py:9-12`, `apps/api/app/osint/connectors.py:83`, `apps/api/app/osint/connectors.py:101`, `apps/api/app/osint/connectors.py:144`, `apps/api/app/osint/sources/infra.py:11` |
| Evidence URL capture | The target website | That this deployment fetched that URL, from this IP, at this time | `apps/api/app/intel/evidence.py:429-445` |
| LLM analysis | The configured model provider (for example NVIDIA or DeepSeek endpoints, or local) | The prompt, which includes selected D1 and D4 data | `apps/api/app/config.py:439-448` |
| Map tiles and imagery | Basemap and imagery providers (Carto, EOX) | The areas being viewed | `apps/api/app/routes/tiles.py:50-53`, `apps/api/app/routes/tiles.py:206` |
| Every shared-client request | Any upstream | A fixed `User-Agent: osint-console/0.1`, which identifies the tool | `apps/api/app/upstream.py:346` |

Operator guidance:
1. Assume every lookup is logged by the provider and may be seen by the target (a website owner sees
   evidence captures in their access logs).
2. Route egress through infrastructure you control or pay for, using the proxy pool setting
   (`apps/api/app/config.py:166-172`), which warns against free proxy lists. Do not route it through public
   proxies.
3. Use local models for sensitive investigations, so that D4 data never leaves the host.
4. Leave paid-key connectors (HIBP) unset unless your jurisdiction and your purpose allow sending target
   identifiers to them.
5. Record in your own privacy notice which third parties receive investigation identifiers.

## 6. Sensitive data in browser storage (V14.3.3)

Added 2026-09-13. Citations are to the working tree read that day (base commit `56db34f`).

**What is stored.** Besides the Supabase session tokens (accepted risk R27, the `ACCEPTED RISK` comment in `apps/web/src/transport/supabase.ts`),
the browser's `localStorage` holds D4 investigation data: pinned captures with coordinates, saved searches,
tasking questions, inbox triage state and map annotations (`USER_DATA_KEYS` in `apps/web/src/auth/userData.ts`).
Every storage key the app writes is listed as either user data or a device preference, and
`apps/web/src/auth/userData.test.ts` fails on a key in neither list (header comment of `userData.ts`).

**What clears it.** On a Supabase sign-out from any cause (the user, the idle timer, an expired refresh
token, another tab), the app empties the stores and removes the user-data keys
(`apps/web/src/auth/AuthContext.tsx:47-52`; `clearUserData` in `apps/web/src/auth/userData.ts`). In keyless and
static-key modes there is no sign-out, so this data stays until the browser's site data is cleared.

**Decision (2026-09-13): accepted risk R30.** The browser copy is kept because it lets the console keep an
analyst's working set without an account, which the keyless product requirement needs, and because moving
captures, saved searches and tasking questions to the server would change their ownership model. Conditions:

1. In multi-user mode, sign-out clears D4 keys (above).
2. In keyless and static-key modes, the browser belongs to the one operator. Operators must not use those
   modes on a shared machine or a shared browser profile.
3. The CSP limits which scripts can read the origin's storage (`apps/web/csp.ts`).

Not built: a "Clear local investigation data" control for keyless and static-key modes. It is the named
treatment for R30.

