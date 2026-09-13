# Risk assessment and treatment

| Field | Value |
| --- | --- |
| ISO/IEC 27001:2022 clauses | 6.1.2 (risk assessment), 6.1.3 (risk treatment), 8.2, 8.3 |
| Version | 1.1 (Draft until merged to `master`). 1.1 adds R26–R31 from the ASVS 5.0 Level 2 assessment ([`../asvs-l2-assessment.md`](../asvs-l2-assessment.md)) |
| Adopted | 2026-09-13 |
| Owner | Maintainer |
| Next review | 2027-09-13, or sooner on a trigger in [Reassessment triggers](#4-reassessment-triggers) |

Scope is the one stated in [`README.md`](README.md#12-scope-and-boundaries-43): the development, build and
release of Velocity plus the maintainer's reference deployment. Risks that exist only inside an operator's
own deployment are listed with the owner **Operator**, because the maintainer can reduce them in the
software but cannot operate the treatment.

Inputs: [`../gap-analysis-2026-09.md`](../gap-analysis-2026-09.md) (G1 to G20), the ASVS 5.0 Level 2
assessment ([`../asvs-l2-assessment.md`](../asvs-l2-assessment.md), R26–R31), GitHub repository
settings read with `gh api` on 2026-09-13, and the security invariants in `apps/api/CLAUDE.md`.

## 1. Method (6.1.2)

### 1.1 Assets in scope

| Asset | Description |
| --- | --- |
| A1 Source repository | `github.com/AndrewCTF/velocity`, including history, branches, the ruleset and its settings |
| A2 Build pipeline | GitHub Actions workflows under `.github/workflows/`, runners, `GITHUB_TOKEN` |
| A3 Released artifacts | `v*` tags and GHCR images `ghcr.io/andrewctf/velocity-api` and `-web` (`.github/workflows/publish.yml`) |
| A4 Dependency set | `pnpm-lock.yaml`, `apps/api/uv.lock`, `apps/desktop/src-tauri/Cargo.lock`, and the feeder lockfiles under `tools/` |
| A5 Maintainer identity | the GitHub account with admin rights, its signing key, and its GHCR access |
| A6 Maintainer endpoint | the workstation where code is written and signed, and where local `.env` files live |
| A7 Deployment secrets | `API_KEY`, the Supabase JWT secret, provider keys, the Fernet key and ingest tokens in an operator's `.env` |
| A8 Deployment data | the `osint_data` volume: history, ontology, foundry, workflows, the audit log and the evidence locker |
| A9 Running service | the api, web and nginx containers of `docker-compose.prod.yml` |
| A10 Project reputation and legal standing | the licence, disclaimers and upstream relationships |

### 1.2 Likelihood scale

| L | Label | Meaning for this project |
| --- | --- | --- |
| 1 | Rare | Not expected within 3 years |
| 2 | Unlikely | Could happen once in 1 to 3 years |
| 3 | Possible | Could happen about once a year |
| 4 | Likely | Expected several times a year |
| 5 | Almost certain | Expected monthly, or already happening |

### 1.3 Impact scale

| I | Label | Meaning for this project |
| --- | --- | --- |
| 1 | Negligible | Cosmetic, no data or credential exposure |
| 2 | Minor | One deployment degraded briefly; no exposure |
| 3 | Moderate | One deployment's data or availability affected, or a legal complaint |
| 4 | Major | Credential or data exposure in one deployment, or a defect that many operators ship |
| 5 | Severe | Code execution or credential theft across operators, or the release channel compromised |

### 1.4 Score and acceptance criteria

Score = L × I, from 1 to 25.

| Band | Score | Acceptance criteria |
| --- | --- | --- |
| Low | 1–6 | Accepted by default. Reviewed at the annual reassessment. |
| Medium | 8–12 | Treat within 90 days, or accept with a written reason in this register and a date in [`operations.md`](operations.md#93-management-review). |
| High | 15–25 | Treat before the next release. Acceptance is allowed only when a management review records it with a reason. |

A residual score is the score expected after the listed controls, including controls still marked
Planned. Where the residual depends on a Planned action, the treatment column names the action from the
[Remaining actions](statement-of-applicability.md#remaining-actions) list (RA-nn).

### 1.5 Treatment options (6.1.3)

**Reduce** (apply controls), **Accept** (retain the risk knowingly), **Avoid** (stop the activity), or
**Transfer/Share** (the risk sits with a party that holds the treatment, usually the operator).

## 2. Risk register

Controls cite ISO/IEC 27001:2022 Annex A control numbers. Status of each control is in the
[Statement of Applicability](statement-of-applicability.md).

| ID | Asset | Threat | Vulnerability | L | I | Score | Treatment | Controls (Annex A) and evidence | Residual (L×I) | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R01 | A4, A3 | Malicious release of a direct or transitive npm/PyPI/crates package (typosquat, hijacked maintainer) | 566 npm and 114 Python packages; install scripts run in CI | 3 | 5 | 15 | Reduce | 5.21, 8.8, 8.19, 8.32: lockfiles installed with `pnpm install --frozen-lockfile` and `uv sync --locked` (`.github/workflows/ci.yml`); Dependabot (`.github/dependabot.yml`); CI token `contents: read`. Audits catch known advisories only, not a new malicious version | 2×5 = 10 | Maintainer |
| R02 | A4, A3 | Exploitation of a known-vulnerable dependency | Advisories published after a lock was cut (G1: 3 critical, 11 high before the wave) | 4 | 4 | 16 | Reduce | 8.8, 8.29: CI `security` job (`pnpm audit --audit-level=high`, `pip-audit`); Dependabot alerts and security updates enabled; 0 open Dependabot alerts on 2026-09-13 | 2×4 = 8 | Maintainer |
| R03 | A3, A9 | Operators keep running code with fixed vulnerabilities | The last release is v1.0.1 (2026-07-16). The G1–G20 fixes merged in PR #87 on 2026-09-13 are on `master` only, while `SECURITY.md` supports only the latest release | 5 | 4 | 20 | Reduce (RA-01) | 8.8, 8.32, 5.37: cut a release carrying PR #87 | 2×4 = 8 after RA-01; 20 until then | Maintainer |
| R04 | A2 | A compromised or re-tagged GitHub Action runs in CI with repository or package credentials | Third-party actions in `.github/workflows/ci.yml`, `.github/workflows/codeql.yml` and `.github/workflows/publish.yml`; the publish workflow has `packages: write` | 2 | 5 | 10 | Reduce (RA-05) | 5.21, 8.9: every action pinned by commit SHA (all three workflow files); Dependabot `github-actions` ecosystem. The repository setting `sha_pinning_required` is `false`, so a new unpinned action would not be refused | 1×5 = 5 | Maintainer |
| R05 | A1, A2 | A malicious pull request from a fork smuggles in a backdoor or steals CI secrets | Public repository; external PRs are merged (PR #73 came from an outside account) | 3 | 4 | 12 | Reduce | 8.4, 8.28, 8.32: no `pull_request_target` in `.github/workflows`; fork runs need approval for first-time contributors (`gh api …/actions/permissions/fork-pr-contributor-approval`); 0 Actions secrets; ruleset `code_scanning` rule blocks high CodeQL alerts; `contents: read` token | 2×4 = 8 | Maintainer |
| R06 | A5, A1, A3 | Maintainer GitHub account takeover (phishing, token theft) | One admin account controls code, releases and GHCR; 2FA state not readable by the tooling used for this assessment | 2 | 5 | 10 | Reduce (RA-05) | 5.17, 8.2, 8.5: GitHub 2FA (to be recorded); secret scanning and push protection enabled | 1×5 = 5 after RA-05 | Maintainer |
| R07 | A1 | Change reaches `master` without the controls the ruleset states | Ruleset "Security" requires one approval and signed commits, but 7 of the last 8 `master` commits are unsigned and PR #87 merged with no human approval; two RepositoryRole bypass actors have `bypass_mode: always`; a second account (`SimonRos1`) holds `write`; CI is not a required status check | 4 | 4 | 16 | Reduce (RA-03, RA-04) | 5.3, 5.18, 8.2, 8.4, 8.32: review collaborator access; confirm and remove unneeded bypass actors; add `web`, `api`, `security` as required checks; record the solo-maintainer review exception | 2×4 = 8 | Maintainer |
| R08 | A7 | Credentials leak through a committed `.env`, a log line or an error message | Many provider keys; `?key=` used to appear in access logs (G8); raw exception text in SSE (G20) | 3 | 4 | 12 | Reduce | 5.17, 8.11, 8.12: `.env` and `*.env` in `.gitignore`; secret scanning and push protection enabled (0 open alerts on 2026-09-13); `RedactKeyFilter` in `apps/api/app/auth.py`; SQL DSNs stored as env-var names (`apps/api/CLAUDE.md`, Connections) | 1×4 = 4 | Maintainer |
| R09 | A7, A9 | Remote code execution and secret theft through the `op.python` workflow block | Block code runs with the API's uid; without a jail it can read `/proc/<pid>/environ` (G13) | 3 | 5 | 15 | Reduce; operator may accept | 8.18, 8.22, 8.2: bubblewrap jail with no network; 503 when the jail is unavailable unless `WORKFLOWS_PYTHON_UNSANDBOXED=1`; mutating workflow routes need `require_operator` (`apps/api/app/security.py`); `apps/api/tests/test_python_exec_unsandboxed_gate.py` | 1×5 = 5 (2×5 = 10 where an operator sets the opt-in) | Maintainer / Operator |
| R10 | A9 | Server-side request forgery through alert-rule sinks or `op.http` | Any analyst could aim `sink_url` at loopback or LAN (G7); three separate URL checks | 3 | 4 | 12 | Reduce | 8.20, 8.26, 8.28: one classifier `apps/api/app/netguard.py`, sink URLs public-only at create and delivery, `apps/api/tests/test_sink_ssrf.py`; `op.http` stays LAN-capable by design but operator-gated | 1×4 = 4 | Maintainer |
| R11 | A8, A9 | An operator exposes an open-mode (`ALLOW_UNAUTHENTICATED=1`) or keyless instance to the internet | Keyless boot is a product requirement; the dev compose runs open mode | 3 | 5 | 15 | Share with operator; reduce in software | 8.3, 8.20, 8.5: compute routes refuse a keyless box unless explicitly opened (`apps/api/app/auth.py`); dev compose binds loopback (`docker-compose.yml`); prod compose binds `127.0.0.1:8080`; `auth DISABLED` startup banner (`docs/security/incident-response.md` §1) | 2×5 = 10 | Operator |
| R12 | A8 | Loss or corruption of the `osint_data` volume (disk failure, ransomware, operator error) | Single named volume; no scheduled backup shipped | 3 | 4 | 12 | Share with operator | 8.13, 5.30, 7.10: `scripts/backup-data.sh` backup and restore (round trip verified in G16); runbook `docs/security/incident-response.md` §4. Backups are unencrypted tarballs | 2×3 = 6 | Operator |
| R13 | A10 | Legal claim or IP block from an upstream data source whose terms prohibit the collection | Browser-emulating sidecars and non-commercial feeds | 3 | 3 | 9 | Accept (maintainer); share (operator) | 5.31, 5.32: `DISCLAIMER.md` (operator is responsible for requests from their infrastructure), `docs/commercial-licensing.md` per-source licence verdicts, `COMMERCIAL_MODE` switch. Accepted: keyless public sources are a product requirement | 2×3 = 6 | Maintainer / Operator |
| R14 | A8, A9 | Prompt injection through collected OSINT content (news, pages, posts) steers model output or agent tool use | Model prompts include untrusted third-party text | 4 | 3 | 12 | Reduce; accept residual (RA-15) | 8.26, 8.28: `_INJECTION_GUARD` kept as the final instruction (`apps/api/app/news/analyze.py`, `apps/api/CLAUDE.md` Model prose); model prose labelled for the analyst. No adversarial injection test corpus yet | 3×3 = 9 | Maintainer |
| R15 | A9 | Authentication bypass or token replay | JWT audience unchecked (G9); query-string keys on HTTP (G8) | 3 | 4 | 12 | Reduce | 8.5, 5.17: `aud` and `nbf` enforced, `?key=` on WebSocket only, constant-time key compare; `apps/api/tests/test_auth_query_key_and_jwt.py` | 1×4 = 4 | Maintainer |
| R16 | A9 | Misuse by a second human in a deployment that uses one static key | A static-key holder is the operator (G10, accepted) | 3 | 3 | 9 | Accept | 5.15, 5.3, 8.2: documented in `docs/decisions.md` (2026-09-13 entry); Supabase mode separates `admin` from analysts | 3×3 = 9 (accepted: single-principal deployments have one user) | Operator |
| R17 | A9 | Denial of service through large uploads, regex backtracking or request floods | Unbounded `file.read()` (G6), cubic regex (G19), compute-only rate limit (G11) | 3 | 3 | 9 | Reduce | 8.6: `apps/api/app/uploads.py`, `apps/api/app/ratelimit.py`, nginx `limit_req` in `infra/nginx/nginx.prod.conf`, compose `pids_limit`/`mem_limit`; `apps/api/tests/test_upload_caps.py`, `apps/api/tests/test_api_ratelimit.py` | 2×3 = 6 | Maintainer |
| R18 | A9 | New injection, traversal or information-exposure defect in project code | 20 gaps found in one audit; CodeQL first scan had 3 true positives (G18–G20) | 3 | 4 | 12 | Reduce | 8.25, 8.28, 8.29: CodeQL on push, PR and weekly (`.github/workflows/codeql.yml`) with a ruleset gate on high alerts; guard tests run by `scripts/verify.sh`; 0 open code-scanning alerts on 2026-09-13 | 2×4 = 8 | Maintainer |
| R19 | A3 | A tampered image or tag is pulled by operators, with no way for them to verify origin | `.github/workflows/publish.yml` pushes images with no signature or provenance attestation; SBOMs exist only as CI artifacts (commit `2c7a6b7`) | 2 | 4 | 8 | Reduce (RA-07) | 8.9, 8.24, 5.21: images built only in Actions from a tag; add build-provenance attestation and an SBOM | 1×4 = 4 after RA-07 | Maintainer |
| R20 | A3, A9 | A second, older build path ships a drifted dependency set | `apps/api/Dockerfile` uses `FROM python:3.12-slim` without a digest and `pip install -e .` (ignores `apps/api/uv.lock`); Dependabot's docker entry covers `/infra/docker` only | 3 | 3 | 9 | Reduce (RA-06, done) | 8.19, 8.9, 5.21: file deleted in commit `bbc1aae`; `infra/docker/api.Dockerfile` is the only API image build | 1×3 = 3 | Maintainer |
| R21 | A10, A9 | A vulnerability report is lost or mishandled | One maintainer; `SECURITY.md` links to `AndrewCTF/OSINT/security/advisories/new` while the repository is `AndrewCTF/velocity` | 3 | 4 | 12 | Reduce (RA-02, done in `bbc1aae`) | 6.8, 5.24: GitHub private vulnerability reporting enabled (`gh api …/private-vulnerability-reporting` → `enabled: true`); 72 h acknowledgement target in `SECURITY.md` | 2×4 = 8 | Maintainer |
| R22 | A1, A3 | Maintainer unavailable for weeks, so advisories go unpatched | Single maintainer | 2 | 4 | 8 | Accept | 5.29, 5.30: Dependabot keeps opening PRs; code is mirrored in a second remote and local clones; `SECURITY.md` states the targets are not contractual | 2×4 = 8 (accepted: no second maintainer exists) | Maintainer |
| R23 | A8 | Audit trail cannot support an investigation (gaps, unbounded growth, tampering by a host-level attacker) | `audit()` is best-effort and records the attempt, not the outcome; no retention rule in `apps/api/app/audit.py` | 2 | 3 | 6 | Accept now; reduce later (RA-09) | 8.15, 5.28, 5.33: `Depends(audit_mutation)` on six routers and MCP calls (`apps/api/tests/test_audit_mutations.py`) | 2×3 = 6 | Maintainer / Operator |
| R24 | A8 | Evidence-locker chain of custody broken by editing an evidence object's props | Generic ontology object route can write props on an `evidence:` id (G18 residual) | 3 | 3 | 9 | Reduce (RA-16) | 5.28, 8.3: blob path accepts only 64-hex sha256 (`apps/api/tests/test_evidence.py`); props write-protection not yet decided | 2×3 = 6 after RA-16 | Maintainer |
| R26 | A8, A9 | An analyst opens a malicious file collected into the evidence locker or uploaded for recon (ASVS V5.4.3) | No malware scan on any upload or capture; nothing marks a known-malicious blob | 2 | 3 | 6 | Accept | 8.7, 5.28: blobs are write-once, re-hashed and served only as `attachment` with `nosniff` and a `sandbox` CSP; the server never executes or renders them; operator guidance for out-of-band read-only scanning (`docs/security/input-and-files.md` §5) | 2×3 = 6 | Maintainer / Operator |
| R27 | A7, A9 | Cross-site scripting in the web origin reads the Supabase access and refresh tokens and replays them (ASVS V10.1.1) | supabase-js stores tokens in `localStorage` (`ACCEPTED RISK` comment and `persistSession: true` in `apps/web/src/transport/supabase.ts`); no backend-for-frontend with an httpOnly cookie | 2 | 4 | 8 | Accept | 8.26, 8.5, 5.17: build CSP with no inline script and no eval (`apps/web/csp.ts`); PKCE flow; access token ≤ 3600 s; 30-minute idle sign-out that survives a reload (`apps/web/src/auth/idle.ts`); users can sign out other sessions; operator routes need TOTP (`aal2`) and a live GoTrue check within 60 s; refresh-token reuse detection (operator setting) | 2×4 = 8 | Maintainer |
| R28 | A7, A8 | Traffic on the nginx-to-api bridge or on loopback sidecar ports is read or altered (ASVS V12.3.3) | Internal hops are plain HTTP (`docs/security/crypto-and-keys.md` §2.1) | 1 | 4 | 4 | Accept | 8.20, 8.22: api publishes no port; nginx binds `127.0.0.1:8080`; sidecars bind `127.0.0.1`; an attacker able to read these hops already holds the host. Condition: nginx and api stay on one host | 1×4 = 4 | Maintainer / Operator |
| R29 | A9, A10 | A malicious or compromised analyst uses evidence capture, `/tiler` or alert sinks to send requests to arbitrary public hosts (ASVS V13.2.4, V13.2.5) | Outbound control is "public addresses only", not a host allowlist (`docs/security/communications.md` §3) | 2 | 3 | 6 | Accept; operator may reduce | 8.20, 8.23: `apps/api/app/netguard.py` refuses non-public ranges; `WORKFLOWS_HTTP_ALLOW_HOSTS` and `WORKFLOWS_HTTP_BLOCK_PRIVATE` for operators; egress firewall and proxy guidance (`docs/security/communications.md` §3); audit rows on mutations | 2×3 = 6 | Maintainer / Operator |
| R30 | A8 | Investigation data (captures, saved searches, tasking questions, annotations) left in a browser is read by the next user of the machine (ASVS V14.3.3) | D4 data in `localStorage` (`USER_DATA_KEYS` in `apps/web/src/auth/userData.ts`); cleared on Supabase sign-out only, never in keyless or static-key mode | 2 | 3 | 6 | Accept; reduce later (RA-21) | 5.34, 8.10: sign-out clears the keys (`apps/web/src/auth/AuthContext.tsx:50-52`); keyless and static-key modes are single-operator by definition; CSP | 2×3 = 6 | Maintainer / Operator |
| R31 | A9 | A weak or replayed second factor or password passes GoTrue (ASVS V6.2.11, V6.5.1, V6.5.5) | GoTrue has no context-specific word list and accepts a TOTP code for about 90 s without recording used codes; neither is changeable from this repository (`docs/security/auth-and-sessions.md`, Passwords and Multi-factor authentication) | 1 | 3 | 3 | Accept | 5.17, 8.5: leaked-password protection and minimum length 15 (operator settings); single-verify challenges; GoTrue MFA rate limits; failed-credential lockout on the API | 1×3 = 3 | Operator |
| R32 | A5 | The public KiwiSDR receiver list is rewritten in transit and shows false receiver points or links on the map (ASVS V12.3.1) | The only publisher serves it over plain HTTP (`rx.linkfanel.net`; https resets, probed 2026-09-13), `apps/api/app/routes/source_catalog.py` `KIWISDR_URL` | 1 | 2 | 2 | Accept | 8.20: the list carries no credential and nothing is sent upstream; points are display-only; `KIWISDR_ALLOW_HTTP=0` removes the layer | 1×2 = 2 | Maintainer |
| R33 | A6 | A local process with write access to `./data/action_log.db` edits or deletes agent action history (ASVS V16.4.2) | The local action log (`apps/api/app/intel/action_log_local.py`) has no append-only triggers or hash chain; `audit_log.db` has both (`GET /api/audit/verify`) | 1 | 3 | 3 | Accept; reduce later (RA-22) | 8.15: data directory owned by the API user; multi-user deployments write Supabase `action_log`, append-only by trigger and RLS; mutating requests are also in the hash-chained `audit_log.db` | 1×3 = 3 | Maintainer |
| R25 | A6, A5, A7 | Compromise of the maintainer's workstation (malware, stolen laptop) | Signing key, GitHub session and local provider credentials sit on one endpoint; no documented endpoint baseline | 2 | 5 | 10 | Reduce (RA-08) | 8.1, 7.9, 7.14, 6.7: endpoint baseline (disk encryption, screen lock, updates, key storage) to be written and self-checked | 1×5 = 5 after RA-08 | Maintainer |

### 2.1 Summary

| Band | Inherent | Residual (after listed treatment, including Planned actions) |
| --- | --- | --- |
| High (15–25) | 6: R01, R02, R03, R07, R09, R11 | 0 |
| Medium (8–12) | 19 | 12: R01, R02, R03, R05, R07, R11, R14, R16, R18, R21, R22, R27 |
| Low (1–6) | 6: R23, R26, R28, R29, R30, R31 | 19 |
| Total | 31 | 31 |

The residual column assumes the Planned actions are done. On 2026-09-13 they are not: R03 stays at 20
until RA-01 ships and R07 stays at 16 until RA-03 and RA-04 are done, so the **current** profile has two
High risks. Both are scheduled before the next release, as the High acceptance criterion requires.

## 3. Risk acceptance record

| Risk | Residual | Accepted by | Date | Next review | Reason |
| --- | --- | --- | --- | --- | --- |
| R13 | 6 | Maintainer | 2026-09-13 | 2027-09-13 | Keyless public sources are a product requirement (`CLAUDE.md`); the operator carries request-level responsibility (`DISCLAIMER.md`) |
| R16 | 9 | Maintainer | 2026-09-13 | 2027-09-13 | Recorded in `docs/decisions.md` on 2026-09-13; Supabase mode exists for multi-user separation |
| R22 | 8 | Maintainer | 2026-09-13 | 2027-09-13 | No second maintainer exists; the response targets in `SECURITY.md` say so |
| R23 | 6 | Maintainer | 2026-09-13 | 2027-09-13 | Low band; retention and outcome recording tracked as RA-09 |
| R26 | 6 | Maintainer | 2026-09-13 | 2027-09-13 | Evidence must stay bit-for-bit as collected, and analysts legitimately collect hostile files; a bundled scanner would add a large, fast-moving dependency to every deployment, including air-gapped ones. Operators who need scanning run it out of band, read-only (`docs/security/input-and-files.md` §5) |
| R27 | 8 | Maintainer | 2026-09-13 | 2026-12-15, at the next management review (`operations.md` §9.3.2, decision D8) | A backend-for-frontend holding tokens in an httpOnly cookie would change the deployment topology for every operator and is not built. Compensating controls listed in the register row. Revisit if a CSP bypass or XSS is found, or when Supabase offers cookie sessions for SPAs |
| R28 | 4 | Maintainer | 2026-09-13 | 2027-09-13 | Same-host hops; TLS would protect nothing a host-level attacker cannot already read (`docs/security/crypto-and-keys.md` §2.1). Void if an operator splits nginx and api across hosts |
| R29 | 6 | Maintainer | 2026-09-13 | 2027-09-13 | Arbitrary public capture and lookup is the product; SSRF to internal ranges is refused; operators can narrow egress (`docs/security/communications.md` §3) |
| R30 | 6 | Maintainer | 2026-09-13 | 2027-09-13 | Keyless and static-key modes have one operator and no account; multi-user sign-out clears the data. Treatment RA-21 planned |
| R31 | 3 | Maintainer | 2026-09-13 | 2027-09-13 | Upstream GoTrue behaviour; compensating Supabase settings are on the operator checklist (`docs/security/operator-hardening.md`) |
| R32 | 2 | Maintainer | 2026-09-13 | 2027-09-13 | Public, credential-free list with no https publisher; operators can turn the layer off |
| R33 | 3 | Maintainer | 2026-09-13 | 2027-09-13 | Mutations are already recorded in the hash-chained audit log; hardening the action log is RA-22 |

## 4. Reassessment triggers

Reassess the affected rows, and record it in the next management review, when any of these happen:
- a new security finding with CVSS 7.0 or higher, a published advisory, or an incident;
- a new route family, sidecar, workflow block that executes code, or outbound integration;
- a change to who holds write or admin access on the repository;
- a change of release channel, registry or reference-deployment topology;
- the annual internal audit ([`operations.md`](operations.md#92-internal-audit)).
