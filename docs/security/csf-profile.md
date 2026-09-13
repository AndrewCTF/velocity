# NIST CSF 2.0 Organizational Profile

| Field | Value |
| --- | --- |
| Framework | NIST Cybersecurity Framework 2.0, CSWP 29 (`references/NIST.CSWP.29.pdf`) |
| Profile type | Current Profile, with a Target Profile note |
| Scope | As in [`isms/README.md`](isms/README.md#12-scope-and-boundaries-43) §1.2 |
| Assessed | 2026-09-13 by the maintainer |
| Version | 1.0 (Draft until merged to `master`) |
| Subcategories | **106**, extracted from the PDF with `pdftotext` (6 Functions) |

## Tier

CSF Tiers describe the organization's overall risk governance and management, not single outcomes, so
one Tier is given here rather than one per row.

| Aspect | Current Tier | Reason |
| --- | --- | --- |
| Risk governance | Tier 2, Risk Informed | Before 2026-09-13 security was handled through practices (CI, guard tests, `SECURITY.md`) with no approved policy or risk method. A policy, a risk method and a first management review now exist, but they have not yet run one full cycle |
| Risk management | Tier 2, Risk Informed moving to Tier 3 | Supply-chain and code-level controls are automated and repeatable (Dependabot, CodeQL, CI audit). The ISMS processes are defined but only adopted today |
| Third-party risk | Tier 2 | Suppliers are known and prioritized; there is no supplier assessment or exit plan |

**Target:** Tier 3, Repeatable, after two management reviews and one annual internal audit have run on
schedule (by 2027-09-13).

**Status values** per subcategory: *Achieved* (in place, with evidence), *Partial*, *Not achieved*,
*Operator* (achieved inside an operator's deployment; the software supports it as noted), *N/A* (not
relevant to this organization, with the reason). Outcome descriptions are shortened. RA-nn refers to
[Remaining actions](isms/statement-of-applicability.md#remaining-actions).

## GOVERN (GV)

| ID | Outcome (short) | Status | Evidence or gap |
| --- | --- | --- | --- |
| GV.OC-01 | Mission informs cyber risk management | Achieved | `docs/security/isms/README.md` §1.1 |
| GV.OC-02 | Stakeholder needs understood | Achieved | `docs/security/isms/README.md` §1.3 |
| GV.OC-03 | Legal, regulatory and contractual requirements managed | Partial | `LICENSE`, `DISCLAIMER.md`, `docs/commercial-licensing.md`; no requirements register (RA-19) |
| GV.OC-04 | Critical services others depend on are understood and communicated | Achieved | Supported versions and response targets in `SECURITY.md`; objectives in `docs/security/isms/README.md` §5 |
| GV.OC-05 | Services the organization depends on are understood | Achieved | Supplier table in `docs/security/isms/README.md` §2 |
| GV.RM-01 | Risk management objectives agreed | Achieved | Objectives O1–O8 in `docs/security/isms/README.md` §5 |
| GV.RM-02 | Risk appetite and tolerance stated | Achieved | Acceptance criteria in `docs/security/isms/risk-assessment.md` §1.4 |
| GV.RM-03 | Cyber risk included in enterprise risk management | N/A | No enterprise risk process exists beyond the ISMS; the ISMS risk register is the whole of it |
| GV.RM-04 | Risk response options set out | Achieved | `docs/security/isms/risk-assessment.md` §1.5 |
| GV.RM-05 | Lines of communication for risk, including suppliers | Partial | Communication table in `docs/security/isms/README.md` §7; no supplier communication channel |
| GV.RM-06 | Standard method to calculate and prioritize risk | Achieved | `docs/security/isms/risk-assessment.md` §1 |
| GV.RM-07 | Positive risks considered | Not achieved | No record of strategic opportunities in risk discussions |
| GV.RR-01 | Leadership accountable for cyber risk | Achieved | Top-management role in `docs/security/isms/README.md` §4; review decision D1 in `docs/security/isms/operations.md` |
| GV.RR-02 | Roles and authorities established and enforced | Partial | Roles defined in `docs/security/isms/README.md` §4; ruleset enforcement bypassed (RA-04) |
| GV.RR-03 | Adequate resources allocated | Partial | Decision D6: free GitHub security features only, no budget |
| GV.RR-04 | Cybersecurity in HR practices | N/A | No employees (SoA 6.1–6.6) |
| GV.PO-01 | Policy established and communicated | Achieved | `docs/security/isms/README.md` §3 |
| GV.PO-02 | Policy reviewed and updated | Partial | Review cadence set; no review cycle completed since adoption on 2026-09-13 |
| GV.OV-01 | Strategy outcomes reviewed | Partial | First management review 2026-09-13 (`docs/security/isms/operations.md` §9.3.2) |
| GV.OV-02 | Strategy adjusted to cover requirements and risks | Partial | Same review; one cycle only |
| GV.OV-03 | Risk management performance evaluated | Partial | Metrics defined, one measurement (`docs/security/isms/operations.md` §9.1) |
| GV.SC-01 | Supply chain risk management programme established | Partial | Policy commitment 3; `.github/dependabot.yml`; pinning. No standalone programme |
| GV.SC-02 | Supplier and customer security roles set | Partial | Operator responsibilities in `SECURITY.md` (Scope) and `DISCLAIMER.md`; suppliers on standard terms |
| GV.SC-03 | Supply chain risk integrated into risk management | Achieved | R01, R04, R19, R20 in `docs/security/isms/risk-assessment.md` |
| GV.SC-04 | Suppliers known and prioritized | Achieved | `docs/security/isms/README.md` §2 |
| GV.SC-05 | Supply chain requirements in supplier agreements | Not achieved | Standard click-through terms only (SoA 5.20); accepted |
| GV.SC-06 | Due diligence before new supplier relationships | Partial | Dependency changes pass CI audit; no selection criteria |
| GV.SC-07 | Supplier risks monitored through the relationship | Partial | Weekly Dependabot; no periodic supplier review (RA-17) |
| GV.SC-08 | Suppliers included in incident planning | Not achieved | `docs/security/incident-response.md` names no supplier contacts (RA-10) |
| GV.SC-09 | Supply chain practices monitored across the life cycle | Partial | CI security job, image CVE gate and per-image SBOM artifacts (commits `72443b4`, `2c7a6b7`); Dependabot. SBOMs not published with releases (RA-07) |
| GV.SC-10 | Plans for the end of a supplier relationship | Not achieved | No GitHub exit plan (RA-17) |

## IDENTIFY (ID)

| ID | Outcome (short) | Status | Evidence or gap |
| --- | --- | --- | --- |
| ID.AM-01 | Hardware inventory | Not achieved | Maintainer endpoint not inventoried (RA-08); deployment hardware is the operator's |
| ID.AM-02 | Software, services and systems inventory | Partial | `pnpm-lock.yaml`, `apps/api/uv.lock`, `apps/desktop/src-tauri/Cargo.lock`; SPDX SBOMs as CI artifacts (commit `2c7a6b7`), not published with releases (RA-07) |
| ID.AM-03 | Network and data flows documented | Partial | Compose networks and binds in `docker-compose.prod.yml`; no data-flow diagram |
| ID.AM-04 | Supplier services inventory | Achieved | `docs/security/isms/README.md` §2 |
| ID.AM-05 | Assets prioritized | Partial | Asset list in `docs/security/isms/risk-assessment.md` §1.1 and supplier criticality; assets not ranked |
| ID.AM-07 | Data inventories | Operator | Stores in the `osint_data` volume are listed in `scripts/backup-data.sh` header; data held is the operator's |
| ID.AM-08 | Assets managed through their life cycle | Partial | Supported versions in `SECURITY.md`; Dependabot; unreleased fixes (RA-01) |
| ID.RA-01 | Vulnerabilities identified and recorded | Achieved | Dependabot, CodeQL, CI audit; findings G1–G20 in `docs/security/gap-analysis-2026-09.md` |
| ID.RA-02 | Threat intelligence received | Partial | GitHub Advisory Database through Dependabot only |
| ID.RA-03 | Threats identified and recorded | Achieved | `docs/security/isms/risk-assessment.md` §2 |
| ID.RA-04 | Impacts and likelihoods recorded | Achieved | Same register, L and I columns |
| ID.RA-05 | Inherent risk used to prioritize responses | Achieved | Same register, scores and bands |
| ID.RA-06 | Risk responses chosen, tracked and communicated | Achieved | Remaining actions in `docs/security/isms/statement-of-applicability.md` |
| ID.RA-07 | Changes and exceptions managed and tracked | Partial | `docs/decisions.md`; ruleset bypasses are not tracked (RA-04) |
| ID.RA-08 | Vulnerability disclosure process established | Achieved | `SECURITY.md` (link corrected in commit `bbc1aae`); private vulnerability reporting enabled |
| ID.RA-09 | Authenticity and integrity of software assessed before use | Partial | Lockfile integrity hashes, digest-pinned images; `@mapbox/martini` tarball (RA-18) |
| ID.RA-10 | Critical suppliers assessed before acquisition | Not achieved | RA-17 |
| ID.IM-01 | Improvements identified from evaluations | Achieved | Gap analysis led to PR #87 (`docs/security/gap-analysis-2026-09.md`) |
| ID.IM-02 | Improvements identified from tests and exercises | Partial | Security tests and CodeQL feed fixes; no exercises (RA-10) |
| ID.IM-03 | Improvements identified from operations | Achieved | Post-mortems in `docs/decisions.md` |
| ID.IM-04 | Incident response plans maintained and improved | Partial | `docs/security/incident-response.md`; not exercised (RA-10) |

## PROTECT (PR)

| ID | Outcome (short) | Status | Evidence or gap |
| --- | --- | --- | --- |
| PR.AA-01 | Identities and credentials managed | Partial | App keys and tokens (`apps/api/app/auth.py`); repository access review pending (RA-03) |
| PR.AA-02 | Identities proofed and bound to credentials | Operator | Deployment users are the operator's (Supabase optional); GitHub proofs contributor accounts |
| PR.AA-03 | Users, services and hardware authenticated | Partial | `apps/api/tests/test_auth_query_key_and_jwt.py`; maintainer 2FA not recorded (RA-05) |
| PR.AA-04 | Identity assertions protected and verified | Achieved | JWT `aud` and `nbf` enforcement in `apps/api/app/auth.py`, same test file |
| PR.AA-05 | Least privilege and separation of duties enforced | Partial | `require_operator` in `apps/api/app/security.py`; CI token `contents: read`; SoD gap R07 (RA-04) |
| PR.AA-06 | Physical access managed | N/A | No premises (SoA 7.1–7.6) |
| PR.AT-01 | General awareness and training | Partial | Policy published; no training record (SoA 6.3) |
| PR.AT-02 | Specialized role training | Partial | Same |
| PR.DS-01 | Data at rest protected | Operator | BYOK keys encrypted (`apps/api/app/keys.py`); local stores are not encrypted by the app, and volume encryption guidance is in `docs/security/data-protection.md` §3.1 |
| PR.DS-02 | Data in transit protected | Operator | TLS at the operator's host proxy (`docker-compose.prod.yml`) |
| PR.DS-10 | Data in use protected | Partial | Jail for `op.python` (`apps/api/app/workflows/python_exec.py`); log redaction; generic error frames |
| PR.DS-11 | Backups created, protected and tested | Operator | `scripts/backup-data.sh` with one verified restore (G16); encryption, checksum and off-host guidance in `docs/security/data-protection.md` §4.2 |
| PR.PS-01 | Configuration management applied | Partial | `docker-compose.prod.yml`, `apps/web/csp.ts`, `infra/nginx/nginx.prod.conf`; SBOM per image in CI (commit `2c7a6b7`). Gap: no release provenance (RA-07) |
| PR.PS-02 | Software maintained and replaced by risk | Partial | Dependabot weekly; fixes not yet released (RA-01) |
| PR.PS-03 | Hardware maintained and replaced by risk | Operator | No project hardware beyond the maintainer endpoint (RA-08) |
| PR.PS-04 | Logs generated for monitoring | Partial | `apps/api/app/audit.py`; no retention, attempt-only (RA-09) |
| PR.PS-05 | Unauthorized software installation and execution prevented | Achieved | Read-only api root (`docker-compose.prod.yml`); locked installs in `infra/docker/api.Dockerfile`; `op.python` fails closed without a jail (`apps/api/tests/test_python_exec_unsandboxed_gate.py`) |
| PR.PS-06 | Secure development practices integrated and monitored | Achieved | `docs/security/ssdf-attestation.md`; `.github/workflows/ci.yml`; `.github/workflows/codeql.yml` |
| PR.IR-01 | Networks protected from unauthorized access | Achieved | `apps/api/app/netguard.py`; loopback binds in `docker-compose.prod.yml` |
| PR.IR-02 | Assets protected from environmental threats | N/A | No facilities; hosting provider's |
| PR.IR-03 | Resilience mechanisms in place | Operator | Healthcheck in `docker-compose.prod.yml`; redundancy is the operator's choice |
| PR.IR-04 | Adequate capacity maintained | Achieved | `apps/api/app/ratelimit.py`, `apps/api/app/uploads.py`, compose resource limits |

## DETECT (DE)

| ID | Outcome (short) | Status | Evidence or gap |
| --- | --- | --- | --- |
| DE.CM-01 | Networks monitored | Operator | nginx `limit_req` and logs (`infra/nginx/nginx.prod.conf`); watching them is the operator's |
| DE.CM-02 | Physical environment monitored | N/A | No premises |
| DE.CM-03 | Personnel activity and technology use monitored | Partial | App audit trail (`apps/api/app/audit.py`); the GitHub repository audit log is not reviewed |
| DE.CM-06 | External provider activity monitored | Partial | Dependabot PRs reviewed through CI; GitHub security log not reviewed |
| DE.CM-09 | Hardware, software and runtime monitored | Partial | Code and dependencies monitored (CodeQL, Dependabot); deployment runtime is the operator's |
| DE.AE-02 | Adverse events analysed | Partial | CodeQL alerts triaged with reasons (`docs/security/gap-analysis-2026-09.md`) |
| DE.AE-03 | Information correlated from multiple sources | Not achieved | No correlation across alert sources |
| DE.AE-04 | Impact and scope of events understood | Partial | Severity criteria in `docs/security/isms/operations.md` §8.2 |
| DE.AE-06 | Event information provided to the right people and tools | Achieved | GitHub alerts for Dependabot, code scanning and secret scanning notify the maintainer (settings enabled, 2026-09-13) |
| DE.AE-07 | Threat intelligence used in analysis | Partial | Advisory database context only |
| DE.AE-08 | Incidents declared on defined criteria | Partial | Criteria adopted 2026-09-13 (`docs/security/isms/operations.md` §8.2); not yet exercised |

## RESPOND (RS)

| ID | Outcome (short) | Status | Evidence or gap |
| --- | --- | --- | --- |
| RS.MA-01 | Response plan executed with third parties | Partial | `docs/security/incident-response.md`; never executed (RA-10) |
| RS.MA-02 | Incident reports triaged and validated | Partial | Triage target in `SECURITY.md`; no reports yet |
| RS.MA-03 | Incidents categorized and prioritized | Partial | `docs/security/isms/operations.md` §8.2 |
| RS.MA-04 | Incidents escalated as needed | Partial | Escalation path is a public advisory; a solo maintainer has no internal escalation |
| RS.MA-05 | Criteria for starting recovery applied | Partial | Restore from a backup taken before the first bad audit row (`docs/security/incident-response.md` §4) |
| RS.AN-03 | Root cause established | Partial | Runbook step 5; post-mortems in `docs/decisions.md` |
| RS.AN-06 | Investigation actions recorded with integrity | Partial | Private advisory thread; container log capture in runbook §2 |
| RS.AN-07 | Incident data collected and preserved | Operator | Snapshot step in `docs/security/incident-response.md` §2; audit trail |
| RS.AN-08 | Incident magnitude estimated | Partial | Severity criteria; no worked example |
| RS.CO-02 | Stakeholders notified of incidents | Partial | GitHub Security Advisories (`SECURITY.md`); operators notify their own users |
| RS.CO-03 | Information shared with designated stakeholders | Partial | Advisories and release notes |
| RS.MI-01 | Incidents contained | Operator | `docs/security/incident-response.md` §2 |
| RS.MI-02 | Incidents eradicated | Operator | `docs/security/incident-response.md` §3 |

## RECOVER (RC)

| ID | Outcome (short) | Status | Evidence or gap |
| --- | --- | --- | --- |
| RC.RP-01 | Recovery plan executed | Operator | `docs/security/incident-response.md` §4 |
| RC.RP-02 | Recovery actions selected and performed | Operator | Same |
| RC.RP-03 | Backup integrity verified before restore | Not achieved | `scripts/backup-data.sh` records no checksum and does not verify before restoring (RA-20) |
| RC.RP-04 | Post-incident operational norms set | Partial | Runbook §4: watch the audit trail and logs for a day |
| RC.RP-05 | Restored assets verified and normal operation confirmed | Partial | Recreate from a known-good release tag; images are unsigned, so origin cannot be verified (RA-07) |
| RC.RP-06 | End of recovery declared on criteria | Not achieved | No end-of-recovery criteria in the runbook (RA-10) |
| RC.CO-03 | Recovery progress communicated | Partial | Advisory updates |
| RC.CO-04 | Public recovery updates through approved channels | Partial | GitHub advisories and release notes are the approved channels (`SECURITY.md`); not yet used |

## Counts

Counted with `grep` over the table rows on 2026-09-13.

| Function | Subcategories | Achieved | Partial | Not achieved | Operator | N/A |
| --- | --- | --- | --- | --- | --- | --- |
| GOVERN | 31 | 12 | 13 | 4 | 0 | 2 |
| IDENTIFY | 21 | 9 | 9 | 2 | 1 | 0 |
| PROTECT | 22 | 5 | 9 | 0 | 6 | 2 |
| DETECT | 11 | 1 | 7 | 1 | 1 | 1 |
| RESPOND | 13 | 0 | 10 | 0 | 3 | 0 |
| RECOVER | 8 | 0 | 4 | 2 | 2 | 0 |
| **Total** | **106** | **27** | **52** | **9** | **13** | **5** |

## Target Profile note

The target is to move by 2027-09-13 every *Not achieved* row, and every *Partial* row whose gap is a
Remaining action, to *Achieved*. The largest gaps are:

1. **Govern: supply chain (GV.SC-05, -08, -10) and oversight (GV.OV).** Add a supplier assessment, an
   exit plan and supplier contacts in the runbook (RA-17, RA-10). Oversight reaches Achieved after two
   management reviews run on schedule.
2. **Identify and Protect: release integrity (ID.AM-02, PR.PS-01, RC.RP-05).** Publish an SBOM and a
   build-provenance attestation with each release (RA-07). The drifted `apps/api/Dockerfile` was already removed (RA-06, done).
3. **Protect: access and separation of duties (PR.AA-01, -03, -05).** Review access, remove unneeded
   ruleset bypass, require CI, and record 2FA (RA-03, RA-04, RA-05).
4. **Detect: correlation and provider monitoring (DE.AE-03, DE.CM-03, DE.CM-06).** Add the GitHub audit
   and security log to the monthly measurement in `docs/security/isms/operations.md` §9.1.
5. **Respond and Recover: exercise the plan (RS.MA-01, RC.RP-03, RC.RP-06).** Run a tabletop exercise, add
   checksum verification and end-of-recovery criteria to the runbook and the backup script (RA-10, RA-20).

GV.OC-03's Target rests on RA-19. The *Operator* rows stay Operator by design; their target is better
operator guidance, not a change of owner.
