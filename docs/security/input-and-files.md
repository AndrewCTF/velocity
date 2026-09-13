# Input validation, business limits and file handling

| Field | Value |
| --- | --- |
| Covers | OWASP ASVS 5.0 V2.1.1–V2.1.3 (validation and business-logic documentation), V5.1.1 (file handling documentation), V5.4.3 (malware scanning, accepted risk R26), V15.1.3 (time-consuming functions and timeouts); ISO/IEC 27001:2022 A.8.26, A.8.28 |
| Version | 1.1 (Draft until merged to `master`). 1.1 adds §3.1 timeouts and long-running work, and links the malware decision to R26 |
| Adopted | 2026-09-13 |
| Owner | Maintainer |
| Code citations | `path:line` at commit `2cd38d9`. Read them with `git show 2cd38d9:<path>`. Configuration files outside `apps/` are cited at the same commit |

## 1. Input validation rules per input class (V2.1.1)

Validation is at the API boundary. The web client's own checks are a convenience, not a control.

| Input class | Rule | Enforced at |
| --- | --- | --- |
| Credentials | Static key only in the `X-API-Key` header on HTTP; `?key=` only on WebSocket upgrades; JWT must pass signature, `exp`, `nbf`, `aud` and `role` checks | `apps/api/app/auth.py:15-16`, `apps/api/app/auth.py:240`, `apps/api/app/auth.py:255`, `apps/api/app/auth.py:106-130` |
| JSON bodies | Pydantic models with length bounds. For example, evidence URL capture accepts 1–4000 characters, context up to 8000 and ids up to 200. There are 159 `max_length`, `min_length` or `pattern` constraints across `apps/api/app/routes/*.py` (`git grep` count at `2cd38d9`) | `apps/api/app/routes/evidence.py:73-90` |
| Query parameters | List and paging parameters are bounded with `Query(..., ge=, le=)`: 164 upper bounds in `apps/api/app/routes/*.py` (`git grep` count). OSINT lookup targets are capped at 253 characters, the DNS name limit | `apps/api/CLAUDE.md` (Auth: "List routes bound `limit`"), `apps/api/app/routes/osint.py:79`, `apps/api/app/routes/osint.py:84`, `apps/api/app/routes/osint.py:89` |
| Identifiers in paths | Allowlist regex with `fullmatch`: recon dataset `[A-Za-z0-9_]{1,40}`, recon job id `[0-9a-f]{6,32}`, evidence SHA-256 `[0-9a-f]{64}` | `apps/api/app/routes/recon.py:300`, `apps/api/app/routes/recon.py:678`, `apps/api/app/intel/evidence.py:123`, `apps/api/app/intel/evidence.py:142-143` |
| Outbound URLs supplied by users | Resolved and classified by one function. Alert-rule sinks must be public hosts, checked at create and at delivery. Evidence URL capture refuses private, loopback and link-local addresses on every redirect hop. `op.http` may reach the LAN but is operator-gated | `apps/api/app/netguard.py:18`, `apps/api/app/routes/alert_rules.py:20`, `apps/api/app/routes/alert_rules.py:156`, `apps/api/app/intel/evidence.py:347`, `apps/api/app/intel/evidence.py:440-441`, `apps/api/CLAUDE.md` (Auth) |
| Free-text patterns (coordinates) | Regexes written without overlapping quantifiers, so matching runs in linear time (G19) | `docs/security/gap-analysis-2026-09.md` (G19); `apps/api/tests/test_osint_person.py` |
| User SQL (`op.sql`, Foundry SQL) | Runs read-only against in-memory SQLite, with 50,000 result rows and a 10 s timeout | `apps/api/app/foundry/sqlrun.py:18-19`; `docs/security/gap-analysis-2026-09.md` ("Already in place") |
| User Python (`op.python`) | Runs in a bubblewrap jail, or is refused with 503 unless explicitly opted in. Timeout 30 s by default and 60 s at most; stdout 5 MB; 64 open files; 50,000 output rows | `apps/api/app/workflows/python_exec.py:45-47`, `apps/api/app/workflows/py_runner.py:31-32`, `apps/api/CLAUDE.md` (Auth, `op.python`) |
| XML (KML, KMZ) | stdlib `ElementTree`. Entity expansion is refused by expat and KMZ decompression is bounded (below). This was measured on Python 3.14.4 / expat 2.7.4; the api image is Python 3.12 (`infra/docker/api.Dockerfile:3`) and was not measured | `apps/api/app/foundry/ingest.py:332-336`, `docs/decisions.md` ("Not a finding: XML parsing") |
| Uploaded filenames | Recon keeps only the final path component, which blocks traversal. Foundry picks a parser from the extension. The evidence download name is sent through a Content-Disposition encoder | `apps/api/app/routes/recon.py:581`, `apps/api/app/foundry/ingest.py:462-501`, `apps/api/app/routes/evidence.py:50` |
| Third-party text sent to a model | Treated as data. An injection guard is appended as the final instruction | `apps/api/app/news/analyze.py:246`, `apps/api/CLAUDE.md` (Model prose) |
| Ontology props on evidence objects | **Gap:** writable through the generic object route (G18 residual, RA-16). Blob paths are still accepted only as 64-hex values | `apps/api/app/intel/evidence.py:142-143` |

## 2. Combined-value consistency (V2.1.2)

| Rule | Enforced at |
| --- | --- |
| A Foundry version upload must send `mode` as a form field, not a query parameter; a query-string `mode` is refused rather than silently defaulting to the destructive `snapshot` | `apps/api/app/routes/foundry.py:341-352` |
| `mode` must be `snapshot` or `append` | `apps/api/app/routes/foundry.py:355-358` |
| Appending to, or rolling back to, a version whose rows were pruned answers 410 | `apps/api/app/foundry/store.py:659-661`, `apps/api/app/foundry/store.py:719-722` |
| Foundry column type pins must be a JSON object of column to type | `apps/api/app/routes/foundry.py:280-281` |
| Recon job parameters are clamped together: steps 200–30000, SH degree 0–3, downscale 1–8 | `apps/api/app/routes/recon.py:569-571` |
| An unknown dataset and a dataset without an ingest token give the identical 404, so ids cannot be enumerated | `apps/api/app/routes/ingest.py:24-25` |

## 3. Business-logic limits (V2.1.3)

| Limit | Value | Enforced at |
| --- | --- | --- |
| General API rate per client | 3000 requests a minute on every `/api/` path; 0 disables | `apps/api/app/config.py:275` |
| Compute and LLM paths | 60 a minute per client, covering the recon, investigate, imagery detect and splat, extract, intel LLM, AI model and workflows prefixes | `apps/api/app/config.py:263`, `apps/api/app/ratelimit.py:35-56` |
| MCP endpoint | 120 a minute per client | `apps/api/app/config.py:268` |
| Rate window | Sliding 60 s; 429 with a retry hint | `apps/api/app/ratelimit.py:76`, `apps/api/app/ratelimit.py:182-193` |
| Edge rate (production nginx) | 20 requests a second per IP, burst 40 | `infra/nginx/nginx.prod.conf:59`, `infra/nginx/nginx.prod.conf:108` |
| Compute on a keyless box | Refused unless `ALLOW_UNAUTHENTICATED=1` | `apps/api/app/auth.py:264-280`, `apps/api/app/ratelimit.py:59-61` |
| Concurrent recon jobs | 4 active; more answer 429 | `apps/api/app/config.py:285-286`, `apps/api/app/routes/recon.py:124` |
| Retained recon jobs | 40, with a 24 h TTL | `apps/api/app/config.py:296-297` |
| Analysis agent | 6 tool steps, 240 s wall budget | `apps/api/app/intel/agent.py:440-441` |
| Workflow run | 300 s wall budget | `apps/api/app/workflows/engine.py:19` |
| Workflow outbound dispatches | 200 per run across all control blocks; 20 alerts per run | `apps/api/app/workflows/blocks.py:85-90` |
| Workflow rows | 200,000 per block; 500 source preview rows | `apps/api/app/workflows/blocks.py:83-84` |
| Workflow LLM blocks | 100 rows, 20,000 bytes, 50 per row | `apps/api/app/workflows/blocks.py:91-93` |
| Foundry datasets | 200,000 rows each; 5 versions kept | `apps/api/app/foundry/store.py:145`, `apps/api/app/foundry/store.py:147` |
| News verification | 300 s budget | `apps/api/app/config.py:423` |
| Stored artifacts | See the caps in [`data-protection.md`](data-protection.md) §3 | — |

### 3.1 Timeouts and long-running work (V15.1.3)

Added 2026-09-13. Citations are to the working tree read that day (base commit `56db34f`); the nginx
configuration and `recon.py` were being changed by parallel work, so they are cited by symbol, and rows
marked `<!-- recheck -->` must be re-read.

**Rule (policy).** A request that can take longer than 30 seconds must either stream progress (SSE or
WebSocket) or run in the background and be polled. Where an existing route instead holds the request open,
every proxy in front of it must have a read timeout longer than the route's server budget, so the client
gets the result rather than a 504 while the work continues.

| Function | Server budget | How the response is delivered | nginx read timeout | Client | Source |
| --- | --- | --- | --- | --- | --- |
| `POST /api/workflows/{id}/run` (manual run) | 300 s wall budget | **Held open** until the run ends. Exception to the rule: kept because the run result is the response | 330 s on `location /api/workflows/` | `apiFetch` with no timeout (`apps/web/src/state/workflows.ts:290`) | `apps/api/app/routes/workflows.py:208-216`, `apps/api/app/workflows/engine.py:19`, `location /api/workflows/` in `infra/nginx/nginx.prod.conf` <!-- recheck --> |
| `GET /api/intel/agent` (analysis agent) | 6 tool steps, 240 s wall budget | SSE stream with `X-Accel-Buffering: no`, one event per step | nginx default (60 s) on `location /api/`: the connection is cut if **no byte** arrives for 60 s, for example during one slow model call. Not measured | `apiFetch` reading the stream (`apps/web/src/command-bar/AgentConsole.tsx:298`) | `apps/api/app/routes/intel.py:420`, `apps/api/app/routes/intel.py:480-485`, `apps/api/app/intel/agent.py:440-441` <!-- recheck --> |
| Recon job events | Job lifetime (GPU reconstruction) | Job created by `POST /api/recon/jobs`, progress on an SSE stream | nginx default on `/api/` | Browser | `job_events` in `apps/api/app/routes/recon.py` <!-- recheck --> |
| WebSockets (`/ws/`) and `/mcp` | Long-lived | Stream | 86400 s | — | `location /ws/` and `location /mcp` in `infra/nginx/nginx.prod.conf` <!-- recheck --> |
| News edition verification | 300 s | Background refresh loop, not a request | — | — | `Settings.news_verify_budget_s`, `apps/api/app/news/verify.py:357` |
| User SQL (`op.sql`, Foundry SQL) | 10 s | Inside the request or run | as its route | — | §1 |
| `op.python` | 30 s default, 60 s maximum | Inside the workflow run | as the run | — | §1 |
| `/api/config` | Fast | Normal | 60 s | 4 s client timeout (`apps/web/src/transport/config.ts:36`) | — |

**Operator action.** The host TLS proxy in front of nginx has its own read timeout (often 60 s). Set it to
at least 330 s for `/api/workflows/`, and to a long value for `/ws/`, `/mcp` and SSE routes, or manual
workflow runs will fail at the proxy while the run continues on the server
([`operator-hardening.md`](operator-hardening.md) §1).

**Open item.** The agent SSE stream may be cut by the 60 s read timeout when a single model call is slower
than that. Not measured; a periodic SSE comment (keep-alive) from the route, or a longer read timeout on
`/api/intel/agent`, would remove it.

## 4. File uploads (V5.1.1)

### 4.1 Upload routes

| Route | Allowed types | Size caps (app / nginx) | Where stored | How served | Notes |
| --- | --- | --- | --- | --- | --- |
| `POST /api/evidence/upload` | **Any type.** `media_type` is taken from the client unvalidated (`apps/api/app/routes/evidence.py:178`, `apps/api/app/routes/evidence.py:338-339`) | 200 MB, streamed with a running check (`apps/api/app/routes/evidence.py:175`, `apps/api/app/config.py:713`) / 210 MB (`infra/nginx/nginx.prod.conf:88-89`) | `data/evidence/<sha[:2]>/<sha256>`, write-once through an atomic rename (`apps/api/app/intel/evidence.py:144`, `apps/api/app/intel/evidence.py:147-156`) | `GET /api/evidence/{sha}/blob` re-hashes the blob (409 on mismatch) and serves it with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` (`apps/api/app/routes/evidence.py:315-349`) | Original bytes preserved for chain of custody; nothing is transformed or rendered server-side |
| `POST /api/evidence/capture/screenshot` | Base64 image in JSON; `media_type` defaults to `image/png` (`apps/api/app/routes/evidence.py:213`) | 24,000,000 base64 characters (`apps/api/app/routes/evidence.py:47`, `apps/api/app/routes/evidence.py:80`), then 200 MB after decoding (`apps/api/app/intel/evidence.py:203-208`, `apps/api/app/intel/evidence.py:291`) / 32 MB default (`infra/nginx/nginx.prod.conf:65`) | Same as above | Same as above | — |
| `POST /api/foundry/datasets/upload` and `POST /api/foundry/datasets/{id}/upload` | `.csv`, `.ndjson`/`.jsonl`, `.geojson`, `.kml`, `.kmz`, `.json`; anything else is sniffed as a JSON array or CSV (`apps/api/app/foundry/ingest.py:462-501`). Malformed content gives 422 (`apps/api/app/foundry/ingest.py:504-506`) | 25 MB (`apps/api/app/foundry/store.py:146`, `apps/api/app/routes/foundry.py:288`, `apps/api/app/foundry/ingest.py:466-468`); 200,000 rows (`apps/api/app/foundry/ingest.py:507-509`) / 32 MB default | Parsed rows in `foundry.db`; the file itself is not kept | As dataset rows through the API, never as the original file | — |
| `POST /api/ingest/{dataset_id}` | JSON rows | 25 MB, checked on `Content-Length` and again on the running stream total (`apps/api/app/routes/ingest.py:55-76`) / 32 MB default | Rows in `foundry.db` | As dataset rows | Token-gated, no session (`apps/api/app/routes/ingest.py:16-26`) |
| `POST /api/recon/jobs` | **Any type** (images or video for 3D reconstruction); the name is reduced to its basename (`apps/api/app/routes/recon.py:581`) | 4 GB total per job, shared across files (`apps/api/app/config.py:290`, `apps/api/app/routes/recon.py:578-584`) / 4100 MB (`infra/nginx/nginx.prod.conf:96-97`) | `.recon_jobs/<job>/images/`; the whole job directory is removed on 413 (`apps/api/app/routes/recon.py:573-588`) | Reconstruction outputs through the recon routes; inputs are not served back | Compute-gated (`apps/api/app/ratelimit.py:36`); answers 503 when the GPU lab is absent (`apps/api/app/routes/recon.py:565-566`) |

All multipart reads go through `apps/api/app/uploads.py`, which stops at the cap and deletes a partial file
(`apps/api/app/uploads.py:23-49`). **Residual:** Starlette spools the multipart body to a temporary file
before the handler runs (`apps/api/app/uploads.py:4-7`), so the nginx limit is what bounds ingress. In
production compose, `/tmp` is a 512 MB tmpfs (`docker-compose.prod.yml:27-28`). A recon upload larger than
that would presumably fail while spooling, before the 4 GB application cap applies. This is plumbed but
unverified: no large recon upload has been tested in the production container.

### 4.2 Archive handling

| Archive | Source | Limits | Citation |
| --- | --- | --- | --- |
| KMZ (zip) | User upload to Foundry | Only one `.kml` member is read (`doc.kml` preferred), and at most `MAX_UPLOAD_BYTES + 1` bytes of it; over that gives 413. Other members are ignored and nothing is extracted to disk | `apps/api/app/foundry/ingest.py:369-387` |
| llama.cpp release tarball | Downloaded by the local model manager | SHA-256 verified. Each member path is resolved and must stay inside the destination; symlinks and devices are skipped | `apps/api/app/localllm/binary.py:93-115`, `apps/api/app/localllm/binary.py:175`, `apps/api/app/localllm/binary.py:184` |
| Conflict dataset zip | Downloaded from an upstream by the backend, not user-supplied | Read in memory; not extracted to disk | `apps/api/app/intel/conflict.py:128-130` |

No other route accepts or extracts archives (`git grep` for `zipfile`, `tarfile` and `extractall` in
`apps/api/app` at `2cd38d9`).

## 5. Malware scanning (V5.4.3)

**Velocity does not scan uploaded or captured files for malware.** No antivirus engine runs on any upload
path in §4.1. This is an accepted risk: R26 in [`isms/risk-assessment.md`](isms/risk-assessment.md), decided
2026-09-13. Nothing in the application marks a blob as known-malicious to the analyst.

Rationale:
- **Evidence integrity.** Evidence files must be kept bit for bit as received: the SHA-256 is taken at
  ingest and re-verified before serving (`apps/api/app/routes/evidence.py:330-331`). Analysts
  legitimately collect hostile material, such as phishing pages or malware samples, as evidence. A scanner
  that quarantines or cleans files would destroy the record.
- **The server never executes or renders uploads.** Evidence blobs are served as downloads with a sandbox
  CSP and `nosniff` (`apps/api/app/routes/evidence.py:345-347`). Foundry files are parsed into rows and not
  kept (§4.1). Recon inputs go only to the reconstruction pipeline.
- **Keyless, self-hosted product.** Bundling a scanner and its signature feed would add a large, frequently
  updated dependency to every deployment, including air-gapped ones.

Operator guidance:
1. Treat every evidence blob as potentially hostile. Open downloads only in an isolated VM or sandbox, never
   on an analyst workstation's host OS.
2. If your policy requires scanning, scan the volume out of band without modifying files. Examples:
   `clamscan -r --no-summary --infected /var/lib/docker/volumes/osint_data/_data/evidence`, or an ICAP or
   ClamAV sidecar with read-only access to the evidence directory. Record hits as annotations; do not
   delete the files.
3. Keep the nginx body limits (`infra/nginx/nginx.prod.conf:65`, `infra/nginx/nginx.prod.conf:88-89`,
   `infra/nginx/nginx.prod.conf:96-97`) at or below your needs. If you do not use recon, remove its large
   limit.
4. Do not serve `data/evidence` directly from a web server. Always go through the API route, which sets the
   protective headers.
