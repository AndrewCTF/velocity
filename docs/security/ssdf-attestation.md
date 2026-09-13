# NIST SP 800-218 SSDF 1.1 self-attestation

| Field | Value |
| --- | --- |
| Framework | NIST SP 800-218, Secure Software Development Framework version 1.1 (`references/NIST.SP.800-218.pdf`) |
| Subject | Velocity software (`AndrewCTF/velocity`), development, build and release |
| Assessed | 2026-09-13 by the maintainer (self-attestation, not third-party) |
| Version | 1.1 (Draft until merged to `master`). 1.1 records the completed ASVS assessment and the remediation deadlines |
| Task IDs | Extracted from the PDF with `pdftotext`: 47 identifiers, of which 42 are active tasks and 5 are retired in 1.1 |

**Status values.** *Met*: the task's outcome is in place, with the evidence named. *Partial*: some of it
is, and the gap is named. *Not met*: absent. *N/A*: retired identifier. RA-nn refers to the Remaining
actions in [`isms/statement-of-applicability.md`](isms/statement-of-applicability.md#remaining-actions).
Task summaries are paraphrased.

## Prepare the Organization (PO)

| Task | Summary | Status | Evidence |
| --- | --- | --- | --- |
| PO.1.1 | Write down the security requirements for the development infrastructure and processes | Partial | Policy commitments 1–10 in `docs/security/isms/README.md` §3; CI rules in `.github/workflows/ci.yml`. No requirement set for the maintainer endpoint (RA-08) |
| PO.1.2 | Write down the security requirements the software itself must meet | Partial | Invariants with guard tests in `apps/api/CLAUDE.md` (Auth, Model prose, Connections). OWASP ASVS 5.0 Level 2 used as the requirement baseline and assessed on 2026-09-13 (`docs/security/asvs-l2-assessment.md`, RA-11 done) |
| PO.1.3 | Communicate security requirements to third parties who supply components | Partial | Reporting expectations in `SECURITY.md`; contributors meet requirements through CI. Upstream open-source suppliers cannot be bound by agreement (SoA 5.20) |
| PO.2.1 | Assign SDLC security roles and responsibilities | Met | `docs/security/isms/README.md` §4 |
| PO.2.2 | Train people for their security roles | Partial | Self-directed; no training record (SoA 6.3) |
| PO.2.3 | Get management commitment to secure development | Met | Management review 2026-09-13, decisions D1–D7 (`docs/security/isms/operations.md` §9.3.2) |
| PO.3.1 | Decide which toolchain tools are required and how they are secured | Met | CI and CodeQL workflows name the tools and pin the pnpm and uv versions and every action by SHA in `.github/workflows/ci.yml` and `.github/workflows/codeql.yml` |
| PO.3.2 | Deploy, operate and maintain the toolchain securely | Partial | Actions pinned by SHA, `permissions: contents: read`, Dependabot for actions (`.github/dependabot.yml`). The repository setting `sha_pinning_required` is off (RA-05) |
| PO.3.3 | Configure tools to produce evidence of their security activities | Partial | CodeQL results and CI logs held by GitHub; dismissal reasons recorded (`docs/security/gap-analysis-2026-09.md`, CodeQL first scan); SPDX SBOM per image uploaded as a CI artifact (`.github/workflows/ci.yml` `images` job, commit `2c7a6b7`). Artifacts are not retained with releases (RA-07) |
| PO.4.1 | Define criteria for security checks throughout the SDLC | Met | `pnpm audit --audit-level=high` and pip-audit fail the build (`.github/workflows/ci.yml`); ruleset code_scanning blocks alerts rated high or above; pre-release criteria in `docs/security/isms/operations.md` §8.1 |
| PO.4.2 | Gather the information needed to decide whether the criteria are met | Partial | Measurement log in `docs/security/isms/operations.md` §9.1. CI is not a required status check, so a red run does not block a merge (RA-04) |
| PO.5.1 | Separate and protect the development, build and release environments | Partial | Ephemeral GitHub-hosted runners; `packages: write` only in the tag-triggered `.github/workflows/publish.yml`; dev and prod compose separated (`docker-compose.yml`, `docker-compose.prod.yml`). Maintainer endpoint unassessed (RA-08) |
| PO.5.2 | Secure and harden the endpoints used for development | Not met | No documented endpoint baseline (RA-08) |

## Protect the Software (PS)

| Task | Summary | Status | Evidence |
| --- | --- | --- | --- |
| PS.1.1 | Store all code and configuration with least-privilege access and tamper protection | Partial | GitHub ruleset 18510846 (no deletion, no force push, signed commits). Bypass used and unsigned commits on `master`; one unreviewed write collaborator (RA-03, RA-04) |
| PS.2.1 | Publish information that lets acquirers verify release integrity | Not met | `.github/workflows/publish.yml` pushes images with no signature, checksum list or provenance attestation (RA-07) |
| PS.3.1 | Archive the files and data for each release | Partial | Git tags and GHCR images are retained by GitHub (latest v1.0.1). No archive of build inputs and provenance beyond the tag |
| PS.3.2 | Collect and share provenance data such as an SBOM for each release | Partial | SPDX SBOMs generated for each image in CI (`.github/workflows/ci.yml` `images` job, commit `2c7a6b7`, not yet on `master`). Not attached to releases or shared with operators, and no provenance attestation (RA-07) |

## Produce Well-Secured Software (PW)

| Task | Summary | Status | Evidence |
| --- | --- | --- | --- |
| PW.1.1 | Model threats and risks to decide on design mitigations | Partial | Risk register `docs/security/isms/risk-assessment.md`; framework gap analysis `docs/security/gap-analysis-2026-09.md`. No per-feature threat model is kept |
| PW.1.2 | Track security requirements, risks and design decisions | Met | `docs/decisions.md` (security decisions with guard tests); risk register |
| PW.1.3 | Prefer standard, well-tested security features over custom ones | Partial | Shared modules `apps/api/app/netguard.py` and `apps/api/app/uploads.py`; Fernet from `cryptography` (`apps/api/app/keys.py`). HS256 JWT verification is hand-written with `hmac` in `apps/api/app/auth.py` |
| PW.2.1 | Have a qualified reviewer check the design against requirements and risks | Partial | Self-review against four frameworks (`docs/security/gap-analysis-2026-09.md`). No independent reviewer (RA-13) |
| PW.3.1 | Retired in 1.1: moved to PO.1.3 | N/A | — |
| PW.3.2 | Retired in 1.1: moved to PW.4.4 | N/A | — |
| PW.4.1 | Acquire well-secured third-party components | Partial | Dependabot and CI audits (`.github/dependabot.yml`, `.github/workflows/ci.yml`); unused dependencies removed (G5). No written selection criteria |
| PW.4.2 | Build and maintain well-secured components for reuse | Met | Single SSRF classifier `apps/api/app/netguard.py` with `apps/api/tests/test_sink_ssrf.py`; shared upload cap `apps/api/app/uploads.py` with `apps/api/tests/test_upload_caps.py` |
| PW.4.3 | Retired in 1.1: moved to PW.1.3 | N/A | — |
| PW.4.4 | Verify acquired components for known vulnerabilities and integrity through their life | Partial | `pnpm audit` and pip-audit on every CI run; `cargo audit` and feeder `npm audit` (commit `2c7a6b7`); image CVE gate (`images` job in `.github/workflows/ci.yml`, commit `72443b4`); Dependabot alerts across npm, uv, cargo, actions and docker. These CI changes are on this branch, not yet on `master`. Gap: `@mapbox/martini` tarball without integrity (RA-18) |
| PW.4.5 | Retired in 1.1: moved to PW.4.1 and PW.4.4 | N/A | — |
| PW.5.1 | Follow secure coding practices for the languages used | Met | CodeQL on push, PR and weekly (`.github/workflows/codeql.yml`); ruff and eslint in CI; security invariants in `apps/api/CLAUDE.md`; 0 open code-scanning alerts on 2026-09-13 |
| PW.5.2 | Retired in 1.1: moved to PW.5.1 as an example | N/A | — |
| PW.6.1 | Use compilers, interpreters and build tools with security features | Met | Current, pinned toolchain versions in `.github/workflows/ci.yml`; digest-pinned base images in `infra/docker/api.Dockerfile` and `infra/docker/web.Dockerfile`. The unpinned `apps/api/Dockerfile` was deleted in commit `bbc1aae` |
| PW.6.2 | Choose and configure the tool features that improve security | Partial | TypeScript `strict: true` (`tsconfig.base.json`); `pnpm -r typecheck` and lint in CI. No documented rationale for the chosen settings |
| PW.7.1 | Decide when human review or automated code analysis is required | Met | Policy commitment 2 in `docs/security/isms/README.md` §3; CodeQL runs on every PR (`.github/workflows/codeql.yml`) |
| PW.7.2 | Perform the review or analysis and record and act on the results | Partial | CodeQL first scan: 43 alerts, 3 fixed (G18–G20), 40 dismissed with reasons (`docs/security/gap-analysis-2026-09.md`). Human review is not recorded; PR #87 merged with no human approval (RA-04) |
| PW.8.1 | Decide when executable testing is required | Met | CI runs web and API test suites on every PR (`.github/workflows/ci.yml`); `scripts/verify.sh` before commit |
| PW.8.2 | Scope, run and document tests, and act on the results | Partial | 45 security regression tests added (for example `apps/api/tests/test_sink_ssrf.py`, `apps/api/tests/test_auth_query_key_and_jwt.py`, `apps/api/tests/test_python_exec_unsandboxed_gate.py`). ASVS 5.0 Level 2 assessment with per-requirement evidence (`docs/security/asvs-l2-assessment.md`, 2026-09-13). No DAST, fuzzing in CI or penetration test |
| PW.9.1 | Define a secure default configuration | Met | `docker-compose.prod.yml` (read-only root, `cap_drop`, loopback bind, version pinning); fail-closed decisions in `docs/decisions.md` (2026-09-13) |
| PW.9.2 | Ship the secure defaults and document them for administrators | Met | The defaults ship in `docker-compose.prod.yml`, `apps/web/csp.ts` and `infra/nginx/nginx.prod.conf`; operator-visible changes are explained in `docs/decisions.md` (2026-09-13 entry) |

## Respond to Vulnerabilities (RV)

| Task | Summary | Status | Evidence |
| --- | --- | --- | --- |
| RV.1.1 | Gather vulnerability information from users, researchers and public sources | Met | `SECURITY.md`; GitHub private vulnerability reporting enabled; Dependabot alerts enabled |
| RV.1.2 | Review and test the software regularly for undetected vulnerabilities | Met | CodeQL weekly schedule (`.github/workflows/codeql.yml`); annual internal audit (`docs/security/isms/operations.md` §9.2) |
| RV.1.3 | Maintain a vulnerability disclosure and response policy | Met | `SECURITY.md` (private reporting to `AndrewCTF/velocity` advisories, corrected in commit `bbc1aae`; 72 h acknowledgement, 7-day triage, patch targets) |
| RV.2.1 | Analyse each vulnerability to decide how to respond | Partial | Triage target in `SECURITY.md`; severity criteria in `docs/security/isms/operations.md` §8.2 (adopted 2026-09-13). No reports yet to show it working |
| RV.2.2 | Plan and carry out the response, including a fix and an advisory | Partial | Remediation deadlines for dependency advisories (direct and transitive) and CodeQL findings: critical 7 days, high 14, medium 30, low 90, or shorter where `SECURITY.md` commits to less (`docs/security/isms/operations.md` §8.2.1, adopted 2026-09-13). G1–G20 fixed and merged (PR #87). Not yet released to operators (RA-01) |
| RV.3.1 | Find the root cause of each vulnerability | Met | Cause stated per finding in `docs/security/gap-analysis-2026-09.md`; post-mortems in `docs/decisions.md` |
| RV.3.2 | Look for root-cause patterns across vulnerabilities over time | Partial | Corrective action process in `docs/security/isms/operations.md` §10.2 (adopted 2026-09-13); one audit cycle so far |
| RV.3.3 | Check the code for other instances of the same flaw | Met | G7 merged three SSRF helpers into `apps/api/app/netguard.py`; G19 fixed the same regex shape in `_DD_RE` and `apps/api/app/routes/search.py` (`docs/security/gap-analysis-2026-09.md`) |
| RV.3.4 | Update the SDLC to prevent recurrence | Met | G2/G3 changed CI to locked installs, audits and CodeQL (`.github/workflows/ci.yml`, `.github/workflows/codeql.yml`); each operator-visible change recorded in `docs/decisions.md` |

## Counts

Counted with `grep` over the table rows on 2026-09-13.

| Status | Active tasks (42) | Retired identifiers (5) |
| --- | --- | --- |
| Met | 18 | — |
| Partial | 22 | — |
| Not met | 2 | — |
| N/A | 0 | 5 |

The two Not met tasks are PO.5.2 (RA-08) and PS.2.1 (RA-07).
