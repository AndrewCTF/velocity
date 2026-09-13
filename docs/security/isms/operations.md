# ISMS operation, performance evaluation and improvement

| Field | Value |
| --- | --- |
| Standard | ISO/IEC 27001:2022, clauses 8, 9.1, 9.2, 9.3 and 10 |
| Version | 1.1 (Draft until merged to `master`). 1.1 adds remediation deadlines (§8.2.1) and the ASVS assessment addendum to the first management review (§9.3.2) |
| Adopted | 2026-09-13 |
| Owner | Maintainer |

Every process in this file that has a date of 2026-09-13 was **newly adopted on that day**. The only
activities that ran before that date are the ones this file cites as evidence: CI, CodeQL, Dependabot,
guard tests, the gap analysis, and the `docs/decisions.md` records.

## 8. Operation

### 8.1 Operational planning and control

| Process | How it is controlled | Evidence |
| --- | --- | --- |
| Change to code | Pull request, then the CI `web`/`api`/`security` jobs and CodeQL, then merge | `.github/workflows/ci.yml`, `.github/workflows/codeql.yml` |
| Dependency update | Dependabot PRs weekly for npm, uv, cargo, GitHub Actions and Docker, then CI | `.github/dependabot.yml` |
| Security-relevant behaviour change | Guard test and `docs/decisions.md` entry changed together | `CLAUDE.md` (root), `apps/api/CLAUDE.md` |
| Release | A `v*` tag triggers the image build and push to GHCR | `.github/workflows/publish.yml` |
| Pre-release check (adopted 2026-09-13) | Before tagging: O1, O3, O4 and O5 at target, `scripts/verify.sh` green, and the release notes name security fixes | This file, §9.1 |
| Vulnerability report | Handled per `SECURITY.md` (private advisory, acknowledge in 72 h, triage in 7 days) | `SECURITY.md` |
| Incident in a deployment | Handled per the runbook | `docs/security/incident-response.md` |
| Outsourced processes | GitHub-hosted CI and registry; controlled through repository settings and pinned actions | SoA 5.21, 5.23 |

### 8.2 Security event criteria (adopted 2026-09-13)

An event becomes an **incident** when any of these is true:

| Severity | Criteria | Response |
| --- | --- | --- |
| Critical | Maintainer account, signing key or GHCR image compromised; a released artifact contains malicious code; an exploited vulnerability in a release | Start `docs/security/incident-response.md` at once; public advisory; release within 72 h |
| High | Confirmed vulnerability with CVSS 7.0 or more in a release; a secret-scanning alert for a live credential; a high Dependabot or CodeQL alert affecting shipped code | Patch and release within 7 days of triage (`SECURITY.md`); a high advisory in a transitive dependency, or a high CodeQL finding, within 14 days (§8.2.1) |
| Medium or low | Confirmed vulnerability with CVSS below 7.0; CI security job red on `master` | Per §8.2.1: medium within 30 days, low within 90 days; a red CI job is fixed within 7 days |
| Not an incident | Alert dismissed as a false positive, with the reason recorded on GitHub | Record the dismissal reason |

#### 8.2.1 Remediation deadlines for vulnerable components and code findings (adopted 2026-09-13)

ASVS 5.0 V15.1.1. These deadlines apply to **dependency advisories** (Dependabot, `pnpm audit`,
`pip-audit`, `cargo audit`, container image scans), for **direct and transitive** dependencies alike, and to
**CodeQL findings** on shipped code. The clock starts when the alert opens, or when an upstream fix becomes
available if none existed then. "Remediated" means a fix is merged to `master` **and** released, or the
alert is dismissed with a recorded reason (not affected, not reachable, false positive).

| Severity (GitHub advisory or CodeQL rating; CVSS where given) | Deadline |
| --- | --- |
| Critical (CVSS 9.0–10.0) | 7 days |
| High (7.0–8.9) | 14 days |
| Medium (4.0–6.9) | 30 days |
| Low (0.1–3.9) | 90 days |

Where `SECURITY.md` sets a shorter target, the shorter one applies: it commits to 7 days for a high or
critical vulnerability in the project's own code, and for a high or critical advisory in a direct dependency
once an upstream fix exists. A dependency pull request opened by Dependabot must not stay unmerged past
the deadline for the advisory it fixes. When no upstream fix exists by the deadline, the maintainer records
a mitigation or an accepted risk in [`risk-assessment.md`](risk-assessment.md) and reviews it at every
management review. Overdue items are counted under objective O7.

### 8.3 Risk assessment and treatment in operation

The risk assessment is repeated on the triggers in [`risk-assessment.md`](risk-assessment.md#4-reassessment-triggers).
Treatment progress is the Remaining-actions table in the
[SoA](statement-of-applicability.md#remaining-actions), reviewed at every management review.

## 9. Performance evaluation

### 9.1 Monitoring and measurement

| Metric | Objective | Command or source | Frequency | Recorded in |
| --- | --- | --- | --- | --- |
| Open Dependabot alerts by severity | O1 | `gh api 'repos/AndrewCTF/velocity/dependabot/alerts?state=open'` | Monthly and before each release; GitHub also alerts in real time | Measurement log below |
| npm advisories | O1 | `pnpm audit --json` (metadata.vulnerabilities) | Every CI run (security job); monthly log entry | Actions logs; log below |
| Python advisories | O1 | `uv export --project apps/api --locked --no-hashes --no-emit-project`, then `uvx pip-audit -r <file> --no-deps --disable-pip` | Every CI run; monthly log entry | Actions logs; log below |
| Days since fix merged without a release | O2 | `gh api repos/AndrewCTF/velocity/releases` compared with the merge date of security PRs | Monthly and when a security PR merges | Log below |
| CI conclusion on `master` | O3 | `gh run list --branch master --workflow ci` | Monthly | Log below |
| Open code-scanning alerts | O4 | `gh api 'repos/AndrewCTF/velocity/code-scanning/alerts?state=open'` | Monthly | Log below |
| Open secret-scanning alerts | O5 | `gh api 'repos/AndrewCTF/velocity/secret-scanning/alerts?state=open'` | Monthly | Log below |
| Report acknowledgement time | O6 | Advisory timestamps in the GitHub Security tab | Per report | Advisory thread; summary at management review |
| Remaining actions overdue | O7 | SoA Remaining actions table | Each management review | Management review record |
| API test suite result | O8 | `bash scripts/verify.sh` | Before each release | Release PR |
| Repository access and ruleset | R07 | `gh api repos/AndrewCTF/velocity/collaborators`; `gh api repos/AndrewCTF/velocity/rulesets/18510846` | Each management review | Management review record |

The maintainer carries out the measurements and analyses them at each management review.

#### Measurement log

| Date | Dependabot open | pnpm audit (crit/high/mod/low) | pip-audit | Code scanning open | Secret scanning open | Last release | CI on `master` | Taken by |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-13 | 0 | 0/0/0/0 of 566 deps | No known vulnerabilities found | 0 | 0 | v1.0.1 (2026-07-16) | `ci` on `f38a912` (PR #87 merge): `api` job failed, `security` job succeeded; next `master` commit `bbb28be` (PR #86): success | Maintainer |

### 9.2 Internal audit

#### 9.2.1 Programme (adopted 2026-09-13)

| Item | Value |
| --- | --- |
| Frequency | Yearly, and after a Critical incident. Next due by 2027-09-13 |
| Criteria | This ISMS (clauses 4–10), the [SoA](statement-of-applicability.md) with each evidence pointer re-checked, OWASP ASVS 5.0 Level 2 (`docs/security/asvs-l2-assessment.md`), NIST SSDF ([`../ssdf-attestation.md`](../ssdf-attestation.md)) and CSF 2.0 ([`../csf-profile.md`](../csf-profile.md)) |
| Scope | As in [`README.md`](README.md#12-scope-and-boundaries-43) §1.2 |
| Method | Re-run every command in §9.1; `ls` each SoA evidence path; read repository settings with `gh api`; review code changed since the last audit against ASVS L2; sample 5 merged PRs for CI and CodeQL results |
| Auditor | The maintainer. **Limitation:** 9.2.2 asks for objectivity and impartiality, which a one-person project cannot give. To compensate, every finding must cite evidence someone else can re-run, and an independent review is planned (RA-13) |
| Output | A dated record in this section, with nonconformities entered in §10.2 |

#### 9.2.2 Audit record: 2026-09-13 (first internal audit)

| Item | Value |
| --- | --- |
| Date | 2026-09-13 |
| Auditor | Maintainer |
| Scope | The whole repository at commit `0011de5` (code, CI, containers), plus the repository settings and ISMS documents on 2026-09-13 |
| Criteria | ISO/IEC 27001:2022 Annex A, NIST CSF 2.0, NIST SP 800-218 SSDF 1.1, OWASP ASVS 5.0 |
| Report | [`../gap-analysis-2026-09.md`](../gap-analysis-2026-09.md) (code and CI findings G1–G20), plus the findings A1–A7 below, raised while writing this ISMS |

**Findings from the gap analysis**

| Finding | Summary | Annex A | Result |
| --- | --- | --- | --- |
| G1 | Known-vulnerable JS dependencies (3 critical, 11 high) | 8.8 | Closed (PR #87): `pnpm audit` 0 |
| G2 | Python installs ignored the lockfile | 8.8, 8.19, 8.32 | Closed: `uv sync --locked` in CI and `infra/docker/api.Dockerfile`. Finding A5 found a second Dockerfile still affected |
| G3 | No update or scan automation | 8.8, 8.29 | Closed: Dependabot, CI security job, CodeQL |
| G4 | Actions, images and some lockfiles unpinned | 5.21, 8.9 | Closed, one residual (`@mapbox/martini` tarball, RA-18) |
| G5 | Unneeded and duplicate dependencies | 8.8, 8.27 | Closed |
| G6 | Unbounded upload bodies | 8.26, 8.28, 8.6 | Closed |
| G7 | Analyst-reachable SSRF through alert sinks | 8.26, 8.28, 8.20 | Closed |
| G8 | Credentials accepted in the query string on HTTP | 8.5, 5.17, 8.15 | Closed |
| G9 | JWT audience not checked | 8.5 | Closed |
| G10 | One static key means one role | 5.15, 8.2, 5.3 | Accepted (R16) |
| G11 | Rate limiting incomplete behind nginx | 8.6, 8.20 | Closed |
| G12 | Missing browser hardening headers | 8.9, 8.26 | Closed |
| G13 | `op.python` jail missing from the image | 8.22, 8.27 | Closed: fails closed |
| G14 | Container hardening missing | 8.9, 8.20 | Closed |
| G15 | Audit trail covered 3 route modules | 8.15, 8.16, 5.28 | Closed; retention residual (RA-09) |
| G16 | No disclosure, incident or backup process | 5.24, 5.26, 5.5, 5.30, 8.13 | Closed |
| G17 | No secret scanning | 8.12, 5.17 | Closed (repository setting) |
| G18 | Evidence blob path from forgeable props | 8.28, 8.3 | Closed; props residual (RA-16) |
| G19 | Cubic-time regex on agent input | 8.6, 8.28 | Closed |
| G20 | Raw exception text in agent stream | 8.28, 8.12 | Closed |

**Findings raised while writing this ISMS (2026-09-13)**

| Finding | Evidence | Annex A | Classification | Action |
| --- | --- | --- | --- | --- |
| A1 | Ruleset 18510846 requires approval and signatures, but PR #87 merged with 0 human approvals, and 7 of the last 8 `master` commits are unsigned (`gh api repos/AndrewCTF/velocity/commits`, `verification.reason: unsigned`); two bypass actors have `bypass_mode: always`; CI is not a required check | 5.3, 8.4, 8.32 | Nonconformity NC-01 | RA-04 |
| A2 | Collaborator `SimonRos1` holds write access with no recorded justification or review | 5.18, 8.2 | Nonconformity NC-02 | RA-03 |
| A3 | Security fixes G1–G20 are on `master` but not in a release; `SECURITY.md` supports only the latest release (v1.0.1, 2026-07-16) | 8.8 | Nonconformity NC-03 (objective O2) | RA-01 |
| A4 | `SECURITY.md` advisory link points at `AndrewCTF/OSINT`; the repository is `AndrewCTF/velocity` | 6.8 | Nonconformity NC-04 (closed) | RA-02 |
| A5 | `apps/api/Dockerfile` uses an undigested base and `pip install -e .`, outside Dependabot's docker directory | 5.21, 8.19 | Nonconformity NC-05 (closed) | RA-06 |
| A6 | No SBOM, signature or provenance for released images | 8.9, 8.24 | Opportunity for improvement | RA-07 |
| A7 | No documented maintainer endpoint baseline | 8.1 | Opportunity for improvement | RA-08 |

### 9.3 Management review

#### 9.3.1 Cadence and agenda (adopted 2026-09-13)

Held at least every six months, and after any Critical incident. The maintainer is top management, so
the review is a written record here, made through a pull request.

Standing agenda (the 9.3.2 inputs):
1. Status of actions from the previous review.
2. Changes in external and internal issues: new suppliers, new route families or sidecars, access changes, and legal changes.
3. Changes in the needs of interested parties, such as issues raised by operators or researchers.
4. Performance: the objectives O1–O8 and the measurement log, nonconformities and corrective actions,
   internal audit results, and objectives met or missed.
5. Feedback from interested parties: vulnerability reports and operator issues.
6. Risk assessment results and the status of the treatment plan (Remaining actions).
7. Opportunities for continual improvement.
8. Decisions: improvements, changes to the ISMS, resources, and risk acceptances.

#### 9.3.2 Review record: 2026-09-13 (first review)

| Item | Value |
| --- | --- |
| Date | 2026-09-13 |
| Attendees | Maintainer |
| Inputs reviewed | `docs/security/gap-analysis-2026-09.md`; the internal audit record above; the measurement log; the risk register (25 risks); the SoA (93 controls) |

| Agenda item | Summary |
| --- | --- |
| 1. Previous actions | None; this is the first review |
| 2. Issues | Repository renamed to `velocity` (A4 follows from it). ISMS adopted today. The security hardening wave (PR #87) merged today |
| 3. Interested parties | No vulnerability reports on record. Operators need a release carrying PR #87 |
| 4. Performance | O1, O3, O4 and O5 met; O2 at risk (A3); O6 has no data; O7 on track (20 actions raised; RA-02, RA-06 and RA-20 closed the same day; 17 open, none overdue); O8 per the gap analysis |
| 5. Feedback | None received through the security channels |
| 6. Risks | Six inherent High risks. Two remain High today: R03 (20) and R07 (16) |
| 7. Improvement | A6 (SBOM and provenance) and A7 (endpoint baseline) |

**Decisions**

| # | Decision | Owner | Due |
| --- | --- | --- | --- |
| D1 | Adopt the ISMS documents in `docs/security/isms/` as version 1.0, approved when merged to `master` | Maintainer | On merge |
| D2 | Treat R03 by cutting a release with PR #87 (RA-01) before any other feature release | Maintainer | 2026-09-20 |
| D3 | Treat R07: review collaborator access and the ruleset bypass, and add CI as a required check (RA-03, RA-04) | Maintainer | 2026-09-30 |
| D4 | Accept R13, R16, R22 and R23 at their residual scores, with the reasons in `risk-assessment.md` §3 | Maintainer | — |
| D5 | Keep G10 (a single static key holder is the operator) as accepted. This matches the 2026-09-13 entry in `docs/decisions.md` | Maintainer | — |
| D6 | Resources: no budget; rely on the GitHub security features that are free for public repositories. Revisit if RA-13 (independent review) needs funding | Maintainer | 2027-09-13 |
| D7 | Next management review by 2026-12-15 | Maintainer | 2026-12-15 |

**Addendum, 2026-09-13: OWASP ASVS 5.0 Level 2 assessment**

The ASVS Level 2 assessment ([`../asvs-l2-assessment.md`](../asvs-l2-assessment.md)) was completed the same
day (RA-11). The maintainer reviewed its accepted-risk items and made these further decisions.

| # | Decision | Owner | Due |
| --- | --- | --- | --- |
| D8 | Add R26–R31 to the risk register (31 risks) and accept them at their residual scores, with the reasons in `risk-assessment.md` §3. R27 (Medium, session tokens in browser storage) is re-reviewed at the next management review | Maintainer | 2026-12-15 |
| D9 | Adopt the remediation deadlines in §8.2.1, the key management basis in `../crypto-and-keys.md` §1.0, the log inventory `../logging.md`, the communications inventory `../communications.md` and the operator checklist `../operator-hardening.md` | Maintainer | On merge |
| D10 | Plan RA-21 (clear local investigation data in keyless and static-key modes) | Maintainer | 2026-12-31 |

#### 9.3.3 Review record template

Copy this block for each review.

```markdown
#### Review record: YYYY-MM-DD

| Item | Value |
| --- | --- |
| Date | |
| Attendees | |
| Inputs reviewed | |

| Agenda item | Summary |
| --- | --- |
| 1. Previous actions | |
| 2. Issues | |
| 3. Interested parties | |
| 4. Performance (O1–O8, NCs, audit) | |
| 5. Feedback | |
| 6. Risks and treatment | |
| 7. Improvement | |

| # | Decision | Owner | Due |
| --- | --- | --- | --- |
```

## 10. Improvement

### 10.1 Continual improvement

Improvement comes from four sources: internal audit findings, management review decisions, incident
post-mortems in `docs/decisions.md` (the "Lessons from past sessions" section), and security alerts. An
improvement that can be enforced is enforced as a guard test or CI check, not as prose. That is the
project's standing rule in `CLAUDE.md`.

### 10.2 Nonconformity and corrective action (adopted 2026-09-13)

Process:
1. **Record** the nonconformity in the register below: source, evidence, and the control or clause it breaks.
2. **React**: contain it and deal with its consequences. For a security defect, follow §8.2.
3. **Find the cause.** Ask why it happened, and whether the same shape exists elsewhere, by searching for other instances.
4. **Correct it**, preferably with a guard test or CI check that fails if it returns.
5. **Verify** effectiveness with a command or setting read, and record that evidence.
6. **Update** the risk register or SoA if the cause shows a missing control.
7. **Close** the item only with evidence. Review open items at each management review.

#### Nonconformity register

| ID | Raised | Source | Description | Clause or control | Correction | Due | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NC-01 | 2026-09-13 | Audit A1 | Ruleset approval and signature rules bypassed; CI not required | 5.3, 8.4, 8.32 | RA-04 | 2026-09-30 | Open |
| NC-02 | 2026-09-13 | Audit A2 | Write collaborator without an access review | 5.18, 8.2 | RA-03 | 2026-09-30 | Closed 2026-09-13: access review below |
| NC-03 | 2026-09-13 | Audit A3 | Security fixes unreleased; objective O2 at risk | 8.8, 6.2 | RA-01 | 2026-09-20 | Open |
| NC-04 | 2026-09-13 | Audit A4 | Wrong advisory link in `SECURITY.md` | 6.8 | RA-02 | 2026-09-20 | Closed 2026-09-13: link corrected in commit `bbc1aae` (`SECURITY.md`) |
| NC-05 | 2026-09-13 | Audit A5 | `apps/api/Dockerfile` bypasses the lockfile and the digest pinning | 5.21, 8.19 | RA-06 | 2026-10-15 | Closed 2026-09-13: file deleted in commit `bbc1aae` |
| NC-G | 2026-09-13 | Gap analysis G1–G9, G11–G20 | 19 code and CI gaps | See §9.2.2 | PR #87, with guard tests named in the gap analysis | 2026-09-13 | Closed (evidence in `docs/security/gap-analysis-2026-09.md`) |


## Access review record — 2026-09-13

Performed by the maintainer (`AndrewCTF`), from `gh api repos/AndrewCTF/velocity/collaborators`.

| Account | Permission | Decision | Reason |
| --- | --- | --- | --- |
| `AndrewCTF` | admin | Keep | Repository owner and sole maintainer |
| `SimonRos1` | write | Keep, with the reason recorded | Collaborator approved by the owner on 2026-09-13. GitHub offers no read-only collaborator role on a personal repository: the `permission=pull` downgrade returned 204, but the account still has write. Their writes to `master` pass through the Security ruleset (PR required, signed commits, required CI once RA-04 lands). |

Next review: at each management review (see §9.3) or whenever a collaborator is added or leaves.
