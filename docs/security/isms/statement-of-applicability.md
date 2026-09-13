# Statement of Applicability

| Field | Value |
| --- | --- |
| Standard | ISO/IEC 27001:2022, clause 6.1.3 d) and Annex A |
| Controls listed | **93** (5.1–5.37: 37; 6.1–6.8: 8; 7.1–7.14: 14; 8.1–8.34: 34) |
| Version | 1.0 (Draft until merged to `master`) |
| Adopted | 2026-09-13 |
| Owner | Maintainer |
| Evidence checked | 2026-09-13, against the `compliance-2026-09` worktree at commit `a0a7f73` and `gh api` reads of `AndrewCTF/velocity`. Parallel security work on this branch was still changing code when this was written; re-check pointers when merging |

Control numbers and titles are cited from ISO/IEC 27001:2022 Annex A. The control text is not
reproduced here because the standard is copyrighted.

**Status values.** *Implemented*: in place, with evidence that exists today. *Partial*: some of it is in
place and the gap is named. *Planned*: not in place; a Remaining action (RA-nn) is listed. *Operator*: the
control operates inside an operator's deployment; the justification says how the software supports it.
*N/A*: the control is excluded, with the reason.

**Owner values.** *Maintainer* (the project's single maintainer), *Operator* (whoever runs a deployment),
*Upstream provider* (GitHub for the repository, Actions and GHCR; the hosting provider for any
deployment's hardware).

**Evidence notation.** Backticked paths are files in this repository. "GitHub setting" means a value read
with `gh api` on 2026-09-13; the endpoint is named. "R-nn" refers to [`risk-assessment.md`](risk-assessment.md).

## 5 Organizational controls

| Control | Title | Applicable | Justification | Status | Evidence | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| 5.1 | Policies for information security | Yes | Needed to state commitments for development and release | Implemented | `docs/security/isms/README.md` §3 (adopted 2026-09-13); `SECURITY.md` | Maintainer |
| 5.2 | Information security roles and responsibilities | Yes | Roles must be assigned even when one person holds them | Implemented | `docs/security/isms/README.md` §4 | Maintainer |
| 5.3 | Segregation of duties | Yes | Author and approver of a change are the same person (R07) | Partial | Compensating checks run on every PR (PR #87 checks: web, api, security, CodeQL all green). Gap: the ruleset's review and signature rules were bypassed (GitHub setting: repos/…/rulesets/18510846; unsigned commits on `master`); CI is not a required check. RA-04 | Maintainer |
| 5.4 | Management responsibilities | Yes | The maintainer is top management and must direct the ISMS | Implemented | `docs/security/isms/README.md` §4; `docs/security/isms/operations.md` §9.3 | Maintainer |
| 5.5 | Contact with authorities | Yes | Breach notification may be required of whoever controls the data | Operator | The project processes no operator data; `docs/security/incident-response.md` §5 leaves notification to the operator's jurisdiction. Maintainer contact route for authorities is GitHub Security Advisories (`SECURITY.md`) | Operator |
| 5.6 | Contact with special interest groups | Yes | Advisory feeds are the project's link to the security community | Partial | GitHub Advisory Database via Dependabot alerts (GitHub setting: security_and_analysis). No other group membership | Maintainer |
| 5.7 | Threat intelligence | Yes | Supply-chain and web-app threats change weekly | Partial | Dependabot alerts, CodeQL weekly schedule (`.github/workflows/codeql.yml`). No structured review of threat reports beyond alerts | Maintainer |
| 5.8 | Information security in project management | Yes | Each feature wave can add attack surface | Implemented | Security entries in `docs/decisions.md` (2026-08-29 hardening wave, 2026-09-13 gap analysis); invariants with guard tests in `apps/api/CLAUDE.md` | Maintainer |
| 5.9 | Inventory of information and other associated assets | Yes | Assets must be known to be protected | Partial | Asset list in `docs/security/isms/risk-assessment.md` §1.1; software inventory in `pnpm-lock.yaml`, `apps/api/uv.lock`, `apps/desktop/src-tauri/Cargo.lock`. No SBOM is published (RA-07) | Maintainer |
| 5.10 | Acceptable use of information and other associated assets | Yes | Users of the software need stated limits | Implemented | `DISCLAIMER.md` (personal data, prohibited uses) | Maintainer |
| 5.11 | Return of assets | No | No employees or contractors hold project-owned assets. Removal of repository access is covered by 5.18 | N/A | — | Maintainer |
| 5.12 | Classification of information | Yes | Embargoed vulnerability details, secrets and deployment data must be handled by class | Partial | Project scheme in `docs/security/isms/README.md` §6; deployment data classes D1–D6 and the in-app UNCLASSIFIED to TOP SECRET ladder with compartments in `docs/security/data-protection.md` §1 (both adopted 2026-09-13); enforcement in `apps/api/app/intel/classification.py`. Not yet applied in a review cycle | Maintainer |
| 5.13 | Labelling of information | Yes | Collected data in a deployment needs provenance and classification labels | Operator | Software records provenance per assertion (`apps/api/app/intel/ontology_local.py`) and classification markings per row (`docs/security/data-protection.md` §1.2). Labelling of the operator's own records is the operator's | Operator |
| 5.14 | Information transfer | Yes | Releases and deployment traffic cross networks | Operator | Releases go through GitHub and GHCR over TLS. Deployment TLS terminates at the operator's host proxy (`docker-compose.prod.yml` nginx port comment). Private disclosure via GitHub advisories (`SECURITY.md`) | Operator |
| 5.15 | Access control | Yes | Repository and application access must be rule-based | Partial | Application: `apps/api/app/auth.py`, `apps/api/app/security.py`, `apps/api/tests/test_security_hardening.py`. Repository: ruleset exists but has bypass actors (R07, RA-04) | Maintainer |
| 5.16 | Identity management | Yes | Each account with write access must map to a known person | Partial | GitHub accounts only. Collaborators: `AndrewCTF` admin, `SimonRos1` write (GitHub setting: repos/…/collaborators); the second account has no recorded justification (RA-03). Deployment identities via Supabase are Operator | Maintainer |
| 5.17 | Authentication information | Yes | Keys and tokens are the main credentials in both the repo and deployments | Implemented | `.gitignore` (`.env`, `*.env`); GitHub setting: secret_scanning and push_protection enabled; ingest tokens stored as sha256 (`apps/api/CLAUDE.md` Auth); BYOK keys encrypted (`apps/api/app/keys.py`); `apps/api/tests/test_auth_query_key_and_jwt.py` | Maintainer |
| 5.18 | Access rights | Yes | Write access must be granted, reviewed and removed deliberately | Planned | No access review has been recorded. First review scheduled (RA-03) | Maintainer |
| 5.19 | Information security in supplier relationships | Yes | GitHub, package registries and base-image publishers are critical suppliers | Partial | Supplier list in `docs/security/isms/README.md` §2. Suppliers are not formally assessed (RA-17) | Maintainer |
| 5.20 | Addressing information security within supplier agreements | Yes | Supplier terms govern the repository and registries | Partial | Only standard click-through terms exist (GitHub, npm, PyPI, Docker Hub); a one-maintainer project cannot negotiate security clauses. Accepted limitation | Maintainer |
| 5.21 | Managing information security in the ICT supply chain | Yes | Dependencies and actions run in CI and ship in images (R01, R04) | Partial | Actions pinned by SHA (`.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `.github/workflows/publish.yml`); base images by digest (`infra/docker/api.Dockerfile`, `infra/docker/web.Dockerfile`); `.github/dependabot.yml`; `cargo audit` and feeder `npm audit` in CI (commit `2c7a6b7`). The unpinned second Dockerfile was deleted in `bbc1aae`. Gaps: `@mapbox/martini` tarball without integrity (RA-18); `sha_pinning_required` off (RA-05) | Maintainer |
| 5.22 | Monitoring, review and change management of supplier services | Yes | Upstream packages and data feeds change without notice | Partial | Weekly Dependabot runs; upstream feed probes `scripts/verify.sh` (`--live`) and `docs/audits/2026-08-20-api-sweep.md`. No periodic supplier review (RA-17) | Maintainer |
| 5.23 | Information security for use of cloud services | Yes | Repository, CI and registry are GitHub cloud services | Partial | Repository security settings read via `gh api` (secret scanning, push protection, Dependabot security updates, private vulnerability reporting all enabled). No documented exit plan (RA-17) | Maintainer |
| 5.24 | Information security incident management planning and preparation | Yes | Both vulnerability reports and compromised deployments need a plan | Implemented | `SECURITY.md` (reporting, response targets); `docs/security/incident-response.md` | Maintainer |
| 5.25 | Assessment and decision on information security events | Yes | Events must be triaged into incidents consistently | Partial | Triage within 7 days in `SECURITY.md`; event criteria in `docs/security/isms/operations.md` §8.2 (adopted 2026-09-13), not yet exercised (RA-10) | Maintainer |
| 5.26 | Response to information security incidents | Yes | Needed for a compromised deployment or a vulnerable release | Partial | `docs/security/incident-response.md`. Never exercised; tabletop planned (RA-10) | Maintainer / Operator |
| 5.27 | Learning from information security incidents | Yes | Repeat defects must be prevented | Implemented | Post-mortem section "Lessons from past sessions" in `docs/decisions.md`; runbook step 5 requires a guard test or CI check per incident | Maintainer |
| 5.28 | Collection of evidence | Yes | Investigations need intact records | Operator | Software support: audit trail (`apps/api/app/audit.py`, `apps/api/app/routes/audit.py`), evidence locker hashing (`apps/api/app/intel/evidence.py`), snapshot step in `docs/security/incident-response.md` §2 | Operator |
| 5.29 | Information security during disruption | Yes | Security must hold when GitHub or the maintainer is unavailable (R22) | Partial | Second git remote (`velocity` → `AndrewCTF/ProjectVelocity`) and local clones hold the code. No written disruption plan | Maintainer |
| 5.30 | ICT readiness for business continuity | Yes | Deployment data must be recoverable (R12) | Operator | `scripts/backup-data.sh` (backup and restore; restore round trip verified per `docs/security/gap-analysis-2026-09.md` G16). No RTO/RPO stated; the operator sets them | Operator |
| 5.31 | Legal, statutory, regulatory and contractual requirements | Yes | Licensing, data-protection and upstream terms apply (R13) | Partial | `LICENSE` (AGPL-3.0-or-later), `DISCLAIMER.md`, `docs/commercial-licensing.md`. No register of applicable requirements (RA-19) | Maintainer |
| 5.32 | Intellectual property rights | Yes | Dependencies and data sources carry licences | Partial | `LICENSE`, `NOTICE`, per-source verdicts in `docs/commercial-licensing.md`. No automated dependency licence check (RA-12) | Maintainer |
| 5.33 | Protection of records | Yes | ISMS records and audit logs must survive and stay intact | Partial | ISMS records are version-controlled in git; `docs/decisions.md` is append-style. Per-store retention and deletion in `docs/security/data-protection.md` §3; evidence is write-once and custody assertions are never trimmed. Deployment audit log has no retention rule (RA-09) | Maintainer |
| 5.34 | Privacy and protection of personal identifiable information (PII) | Yes | Deployments can collect personal data | Operator | `DISCLAIMER.md` "Personal data": the operator is the data controller. Protection requirements, at-rest guidance and third-party disclosure of lookups in `docs/security/data-protection.md` §2, §3.1 and §5. The maintainer processes no operator data | Operator |
| 5.35 | Independent review of information security | Yes | Certification and assurance need a reviewer other than the maintainer | Planned | Only self-audit exists (`docs/security/isms/operations.md` §9.2). External review planned (RA-13) | Maintainer |
| 5.36 | Compliance with policies, rules and standards for information security | Yes | Policy is only useful if checked | Implemented | Guard tests run by `scripts/verify.sh` and CI (`.github/workflows/ci.yml`); annual self-audit against this SoA (`docs/security/isms/operations.md` §9.2) | Maintainer |
| 5.37 | Documented operating procedures | Yes | Build, deploy, backup and response steps must be repeatable | Implemented | `scripts/CLAUDE.md`, `docs/security/incident-response.md`, usage header of `scripts/backup-data.sh`, `docker-compose.prod.yml` comments | Maintainer |

## 6 People controls

| Control | Title | Applicable | Justification | Status | Evidence | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| 6.1 | Screening | No | No employees. Outside contributors are not screened; their code is gated by CI and CodeQL instead (5.3, 8.32), and write access is governed by 5.18 | N/A | — | Maintainer |
| 6.2 | Terms and conditions of employment | No | No employment relationships exist | N/A | — | Maintainer |
| 6.3 | Information security awareness, education and training | Yes | The maintainer's own competence is the main control (clause 7.2) | Partial | Secure-coding rules with guard tests in `apps/api/CLAUDE.md` and `apps/web/CLAUDE.md`; frameworks studied in `docs/security/gap-analysis-2026-09.md`. No training record | Maintainer |
| 6.4 | Disciplinary process | No | No personnel to discipline; misconduct by contributors is handled by removing access (5.18) | N/A | — | Maintainer |
| 6.5 | Responsibilities after termination or change of employment | No | No employment; access removal is covered by 5.18 | N/A | — | Maintainer |
| 6.6 | Confidentiality or non-disclosure agreements | No | Public open-source code. Embargoed vulnerability details stay in private GitHub advisories rather than under NDA | N/A | — | Maintainer |
| 6.7 | Remote working | Yes | All work is done from the maintainer's own location | Partial | No office exists. Endpoint baseline not yet written (RA-08) | Maintainer |
| 6.8 | Information security event reporting | Yes | Reporters need a private channel | Implemented | `SECURITY.md` (advisory link corrected to `AndrewCTF/velocity` in commit `bbc1aae`); GitHub setting: private-vulnerability-reporting `enabled: true` | Maintainer |

## 7 Physical controls

The project has no premises. Source, CI and images are hosted by GitHub; deployment hardware belongs to
the operator or their hosting provider. Four controls apply to the maintainer's own endpoint and media.

| Control | Title | Applicable | Justification | Status | Evidence | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| 7.1 | Physical security perimeters | No | No premises in scope; hosting facilities are the provider's | N/A | — | Upstream provider |
| 7.2 | Physical entry | No | No premises in scope | N/A | — | Upstream provider |
| 7.3 | Securing offices, rooms and facilities | No | No offices | N/A | — | Upstream provider |
| 7.4 | Physical security monitoring | No | No premises in scope | N/A | — | Upstream provider |
| 7.5 | Protecting against physical and environmental threats | No | No facilities operated; data centres are the provider's | N/A | — | Upstream provider |
| 7.6 | Working in secure areas | No | No secure areas exist | N/A | — | Upstream provider |
| 7.7 | Clear desk and clear screen | Yes | The maintainer endpoint holds signing keys and sessions | Planned | Screen-lock rule to be part of the endpoint baseline (RA-08) | Maintainer |
| 7.8 | Equipment siting and protection | No | No equipment sited by the project; deployment hardware is the operator's or provider's | N/A | — | Upstream provider |
| 7.9 | Security of assets off-premises | Yes | The maintainer's workstation is portable | Planned | Disk encryption and loss handling to be part of the endpoint baseline (RA-08) | Maintainer |
| 7.10 | Storage media | Yes | Backup tarballs of deployment data are written to media | Operator | `scripts/backup-data.sh` writes unencrypted `.tar.gz`; encrypted off-host backup guidance in `docs/security/data-protection.md` §4.2 | Operator |
| 7.11 | Supporting utilities | No | No facilities operated | N/A | — | Upstream provider |
| 7.12 | Cabling security | No | No facilities operated | N/A | — | Upstream provider |
| 7.13 | Equipment maintenance | No | No project-owned equipment beyond the endpoint (8.1) | N/A | — | Upstream provider |
| 7.14 | Secure disposal or re-use of equipment | Yes | A retired maintainer disk could hold keys | Planned | Disposal rule to be part of the endpoint baseline (RA-08) | Maintainer |

## 8 Technological controls

| Control | Title | Applicable | Justification | Status | Evidence | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| 8.1 | User end point devices | Yes | One endpoint writes and signs all code (R25) | Planned | No documented baseline (RA-08) | Maintainer |
| 8.2 | Privileged access rights | Yes | Admin rights on the repository and operator rights in the app | Partial | App: `require_operator` on mutating workflow and model routes (`apps/api/app/security.py`, `apps/api/tests/test_security_hardening.py`). Repository: bypass actors and an unreviewed write account (R07, RA-03, RA-04) | Maintainer |
| 8.3 | Information access restriction | Yes | Routes must refuse callers without the right session | Implemented | `apps/api/app/auth.py` (`require_compute_enabled`), `apps/api/app/security.py`; `apps/api/tests/test_security_hardening.py`, `apps/api/tests/test_evidence.py` | Maintainer |
| 8.4 | Access to source code | Yes | Write access to a public repository is the key control | Partial | Two accounts with write or admin (GitHub setting: collaborators); ruleset present but bypassed (R07, RA-04) | Maintainer |
| 8.5 | Secure authentication | Yes | Deployments authenticate by key or JWT; the repository by GitHub login | Partial | App: `apps/api/app/auth.py`, `apps/api/tests/test_auth_query_key_and_jwt.py`. Maintainer 2FA state not recorded (RA-05) | Maintainer |
| 8.6 | Capacity management | Yes | Uploads, regexes and floods can exhaust a deployment (R17) | Implemented | `apps/api/app/uploads.py`, `apps/api/app/ratelimit.py`, `infra/nginx/nginx.prod.conf`, `pids_limit`/`mem_limit` in `docker-compose.prod.yml`; `apps/api/tests/test_upload_caps.py`, `apps/api/tests/test_api_ratelimit.py` | Maintainer |
| 8.7 | Protection against malware | Yes | Malicious packages and endpoint malware are credible (R01, R25) | Partial | Known-advisory scanning in CI (`.github/workflows/ci.yml` `security` job, and the `images` job that fails on fixable HIGH or CRITICAL image CVEs, added in commit `72443b4` on this branch). These find known vulnerabilities, not malware; endpoint protection undocumented (RA-08) | Maintainer |
| 8.8 | Management of technical vulnerabilities | Yes | Core control for a software supplier (R02, R03) | Partial | `.github/dependabot.yml`; CI security job; `.github/workflows/codeql.yml`; 0 open Dependabot, code-scanning and secret-scanning alerts (GitHub settings, 2026-09-13); `pnpm audit` 0 across 566 deps and `pip-audit` "No known vulnerabilities found" (run 2026-09-13); container image CVE gate (`images` job in `.github/workflows/ci.yml`, commit `72443b4`, not yet on `master`). Gap: fixes not yet released (RA-01) | Maintainer |
| 8.9 | Configuration management | Yes | Hardened defaults ship in the compose and image files | Partial | `docker-compose.prod.yml` (`cap_drop`, `no-new-privileges`, `read_only`, loopback bind); `apps/web/csp.ts`; `infra/nginx/nginx.prod.conf`; SPDX SBOM per image recorded as a CI artifact (`images` job in `.github/workflows/ci.yml`, commit `2c7a6b7`). Gap: no SBOM attached to releases and no provenance attestation (RA-07) | Maintainer |
| 8.10 | Information deletion | Yes | Deployments hold history and personal data | Operator | Retention caps and deletion paths per store in `docs/security/data-protection.md` §3 (history, ontology, foundry and workflows caps; tile cache LRU). Audit log has no retention (RA-09); there is no data-subject erasure function | Operator |
| 8.11 | Data masking | Yes | Secrets must not appear in logs or listings | Implemented | `RedactKeyFilter` in `apps/api/app/auth.py`; DSNs stored as env-var names and scrubbed from errors (`apps/api/CLAUDE.md` Connections); MCP audit records argument names only (`apps/api/tests/test_audit_mutations.py`); BYOK GET returns a masked hint and ingest tokens are shown once (`docs/security/crypto-and-keys.md` §1.2) | Maintainer |
| 8.12 | Data leakage prevention | Yes | Secrets in commits and stack traces in responses leak data (R08) | Implemented | GitHub setting: secret_scanning and secret_scanning_push_protection enabled; generic agent error frame (`docs/security/gap-analysis-2026-09.md` G20). Disclosure of investigation targets to upstream providers is documented with operator guidance in `docs/security/data-protection.md` §5 | Maintainer |
| 8.13 | Information backup | Yes | Deployment data loss (R12); source is replicated by git | Operator | `scripts/backup-data.sh`; `docs/security/incident-response.md` §4; encrypted, checksummed, off-host backup procedure in `docs/security/data-protection.md` §4.2 | Operator |
| 8.14 | Redundancy of information processing facilities | Yes | Availability requirements belong to each deployment | Operator | Single api worker by design (`docker-compose.prod.yml`); redundancy is an operator choice | Operator |
| 8.15 | Logging | Yes | Mutations must be attributable (R23) | Partial | `apps/api/app/audit.py`, `Depends(audit_mutation)` on six routers, `apps/api/tests/test_audit_mutations.py`. Gaps: attempt not outcome, best-effort, no retention (RA-09) | Maintainer |
| 8.16 | Monitoring activities | Yes | Both the project pipeline and deployments need watching | Partial | Pipeline metrics in `docs/security/isms/operations.md` §9.1 (adopted 2026-09-13). Runtime monitoring is manual review of the audit endpoint and logs (`docs/security/incident-response.md` §1), done by the operator | Maintainer / Operator |
| 8.17 | Clock synchronization | Yes | Audit timestamps must be comparable | Operator | Containers use the host clock; NTP on the host is the operator's | Operator |
| 8.18 | Use of privileged utility programs | Yes | Workflow blocks can execute code (R09) | Implemented | bubblewrap jail and fail-closed 503 (`apps/api/app/workflows/python_exec.py`, `apps/api/tests/test_python_exec_sandbox.py`, `apps/api/tests/test_python_exec_unsandboxed_gate.py`); `cap_drop: [ALL]` in `docker-compose.prod.yml` | Maintainer |
| 8.19 | Installation of software on operational systems | Yes | Deployments must run exactly the released set | Implemented | Locked installs in `infra/docker/api.Dockerfile` and CI; `VELOCITY_VERSION` required in `docker-compose.prod.yml`; read-only api root. The unlocked `apps/api/Dockerfile` was deleted in commit `bbc1aae` | Maintainer |
| 8.20 | Networks security | Yes | SSRF and exposed ports are the main network risks (R10, R11) | Implemented | `apps/api/app/netguard.py`, `apps/api/tests/test_sink_ssrf.py`; loopback binds in `docker-compose.prod.yml` and `docker-compose.yml`; `TRUSTED_PROXIES` in `docker-compose.prod.yml` | Maintainer |
| 8.21 | Security of network services | Yes | TLS and edge protection of a deployment | Operator | TLS terminates at the operator's host proxy (`docker-compose.prod.yml` nginx comment); security headers and `limit_req` in `infra/nginx/nginx.prod.conf` | Operator |
| 8.22 | Segregation of networks | Yes | Sidecars, jail and containers need separate reach | Implemented | Compose `front` network (`docker-compose.prod.yml`); jail runs without network (`apps/api/CLAUDE.md` Auth, `op.python`); sidecars bind loopback (`docs/security/gap-analysis-2026-09.md`, "Already in place") | Maintainer |
| 8.23 | Web filtering | No | No managed users browse the web on project systems. Outbound fetches by the software are controlled under 8.20 | N/A | — | Maintainer |
| 8.24 | Use of cryptography | Yes | Tokens, stored keys and releases rely on cryptography | Partial | Key management policy and cryptographic inventory in `docs/security/crypto-and-keys.md` (Fernet BYOK, HMAC-SHA256 JWT, SHA-256 token and evidence hashing, TLS). Gaps: BYOK key rotation is destructive until MultiFernet lands in `apps/api/app/keys.py`; `API_KEY` and JWT secret minimum length not enforced at `2cd38d9`; releases unsigned (RA-07) | Maintainer |
| 8.25 | Secure development life cycle | Yes | Core activity in scope | Implemented | `docs/security/ssdf-attestation.md`; `.github/workflows/ci.yml`; `scripts/verify.sh` | Maintainer |
| 8.26 | Application security requirements | Yes | Requirements must be stated before they can be tested | Partial | Invariants with guard tests in `apps/api/CLAUDE.md`; input validation rules, business limits and upload handling in `docs/security/input-and-files.md`; data protection requirements in `docs/security/data-protection.md` §2. ASVS Level 2 assessment pending in `docs/security/asvs-l2-assessment.md` (RA-11) | Maintainer |
| 8.27 | Secure system architecture and engineering principles | Yes | Fail-closed defaults and one classifier per concern | Implemented | Recorded decisions in `docs/decisions.md` (2026-08-29, 2026-09-13); `apps/api/app/netguard.py`; fail-closed compute and foundry routes (`apps/api/CLAUDE.md` Auth) | Maintainer |
| 8.28 | Secure coding | Yes | Code defects are a leading risk (R18) | Partial | CodeQL runs on every push, PR and week (`.github/workflows/codeql.yml`); ruleset code_scanning rule blocks high or higher (GitHub setting: rulesets/18510846), but that ruleset is bypassable (RA-04); ruff and eslint in `.github/workflows/ci.yml` | Maintainer |
| 8.29 | Security testing in development and acceptance | Yes | Fixes need regression tests | Partial | 45 security tests added (`docs/security/gap-analysis-2026-09.md`, after measurements); CI audit and CodeQL. No DAST or penetration test; ASVS L2 pending (RA-11) | Maintainer |
| 8.30 | Outsourced development | Yes | Outside contributors submit code | Partial | External PRs pass the same CI and CodeQL; first-time contributor runs need approval (GitHub setting: fork-pr-contributor-approval). No DCO or CLA; review rule bypassable (RA-04) | Maintainer |
| 8.31 | Separation of development, test and production environments | Yes | Dev runs open mode; production must not | Implemented | `docker-compose.yml` (dev, `ALLOW_UNAUTHENTICATED`, loopback) versus `docker-compose.prod.yml`; tests run with background feeds off (`scripts/verify.sh`) | Maintainer |
| 8.32 | Change management | Yes | Every change to `master` must be controlled (R07) | Partial | PRs with CI and CodeQL; decisions in `docs/decisions.md`. Gaps: review and signature rules bypassed; CI not required (RA-04) | Maintainer |
| 8.33 | Test information | Yes | Fixtures could contain real captured personal data | Partial | Not yet assessed whether fixtures under `apps/api/tests` include real OSINT captures (RA-14) | Maintainer |
| 8.34 | Protection of information systems during audit testing | Yes | Audits must not disturb live upstreams or deployments | Implemented | Scans run in CI, not against deployments; live probes are opt-in (`OSINT_LIVE_PROBE=1` in `apps/api/tests/test_invariants.py`, `scripts/verify.sh --live`) | Maintainer |

## Counts

Counted with `grep` over the table rows on 2026-09-13.

| Status | Count |
| --- | --- |
| Implemented | 23 |
| Partial | 35 |
| Planned | 6 |
| Operator | 12 |
| N/A | 17 |
| **Total** | **93** |

Applicable: 76 Yes, 17 No (5.11; 6.1, 6.2, 6.4, 6.5, 6.6; 7.1–7.6, 7.8, 7.11–7.13; 8.23).

## Remaining actions

Every Planned control and every Partial gap that needs work has an action here. Target dates are the
maintainer's commitments as of 2026-09-13; progress is reviewed in [`operations.md`](operations.md#93-management-review).

| ID | Action | Controls | Risks | Owner | Target date |
| --- | --- | --- | --- | --- | --- |
| RA-01 | Publish a release that contains PR #87 (G1–G20 fixes) and its GHCR images | 8.8, 8.32 | R03 | Maintainer | 2026-09-20 |
| RA-02 | **Done 2026-09-13** (commit `bbc1aae`): advisory link in `SECURITY.md` now points at `AndrewCTF/velocity` | 6.8 | R21 | Maintainer | 2026-09-20 |
| RA-03 | Review repository access: record why `SimonRos1` holds write, or reduce or remove it; repeat each management review | 5.16, 5.18, 8.2, 8.4 | R07 | Maintainer | 2026-09-30 |
| RA-04 | Ruleset: confirm which roles bypass actors 2 and 4 are and remove unneeded bypass; add `web`, `api` and `security` as required status checks; record the solo-maintainer review exception or configure one that works | 5.3, 5.15, 8.2, 8.4, 8.28, 8.30, 8.32 | R07 | Maintainer | 2026-09-30 |
| RA-05 | Record 2FA (security key) on the maintainer account; enable the Actions `sha_pinning_required` setting | 5.21, 8.5 | R04, R06 | Maintainer | 2026-09-30 |
| RA-06 | **Done 2026-09-13** (commit `bbc1aae`): `apps/api/Dockerfile` deleted, so `infra/docker/api.Dockerfile` is the only API image build | 5.21, 8.9, 8.19 | R20 | Maintainer | 2026-10-15 |
| RA-07 | **In progress.** Done: CI builds an SPDX SBOM for each image and keeps it as a workflow artifact (commit `2c7a6b7`). Remaining: attach SBOMs to releases and add a build-provenance attestation to `.github/workflows/publish.yml`, with verification steps for operators | 5.9, 8.9, 8.24 | R19 | Maintainer | 2026-12-31 |
| RA-08 | Write and self-check a maintainer endpoint baseline: disk encryption, screen lock, OS updates, signing-key storage, disposal | 6.7, 7.7, 7.9, 7.14, 8.1, 8.7 | R25 | Maintainer | 2026-10-31 |
| RA-09 | Define audit-log retention and record outcomes as well as attempts | 5.33, 8.10, 8.15 | R23 | Maintainer | 2026-12-31 |
| RA-10 | Run a tabletop exercise of `docs/security/incident-response.md` against the event criteria in `operations.md` §8.2 | 5.25, 5.26 | R11, R21 | Maintainer | 2026-12-15 |
| RA-11 | Complete the ASVS Level 2 assessment (`docs/security/asvs-l2-assessment.md`) and add its gaps here | 8.26, 8.29 | R18 | Maintainer | 2026-09-30 |
| RA-12 | Add a dependency licence check to CI | 5.32 | R13 | Maintainer | 2026-12-31 |
| RA-13 | Obtain an independent security review (external reviewer or audit body) | 5.35 | all | Maintainer | 2027-09-13 |
| RA-14 | Review test fixtures for real personal data and replace any found | 8.33 | — | Maintainer | 2026-12-31 |
| RA-15 | Build a prompt-injection regression corpus for model and agent paths | 8.26, 8.29 | R14 | Maintainer | 2027-03-31 |
| RA-16 | Decide on write protection for evidence-object props on the generic ontology route | 5.28, 8.3 | R24 | Maintainer | 2026-12-31 |
| RA-17 | Assess critical suppliers (GitHub, npm, PyPI, crates.io, Docker Hub) and write an exit plan for GitHub | 5.19, 5.22, 5.23 | R01, R04 | Maintainer | 2026-12-31 |
| RA-18 | Replace or integrity-pin the `@mapbox/martini` GitHub tarball dependency | 5.21 | R01 | Maintainer | 2026-12-31 |
| RA-19 | Write a register of legal and contractual requirements (licence, data protection, upstream terms) | 5.31 | R13 | Maintainer | 2026-12-31 |
| RA-20 | **Done 2026-09-13** (guidance): scheduled, encrypted, checksummed, off-host backup procedure in `docs/security/data-protection.md` §4.2. A checksum step inside `scripts/backup-data.sh` itself is not built | 7.10, 8.13 | R12 | Maintainer | 2026-12-31 |
