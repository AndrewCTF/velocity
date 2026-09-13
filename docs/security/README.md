# Security and compliance documentation

This folder holds Velocity's security documents: the ISMS, the framework mappings, the gap analysis, and
the runbooks. The vulnerability disclosure policy is [`SECURITY.md`](../../SECURITY.md) at the repository root.

## Certification status

**Velocity is not ISO/IEC 27001 certified.** Certification requires an accredited certification body to
audit an ISMS that has been operating over time, with internal audits and management reviews on record.
The documents below **establish** that ISMS as of 2026-09-13. They are not a certificate and do not claim
conformity. The SSDF and CSF documents are self-assessments by the maintainer; no third party has verified them.

OWASP ASVS 5.0 Level 2 was assessed on 2026-09-13; the results are in [`asvs-l2-assessment.md`](asvs-l2-assessment.md).
That is also a self-assessment.

## Index

| Document | What it is | Framework |
| --- | --- | --- |
| [`isms/README.md`](isms/README.md) | ISMS overview: scope, interested parties, policy, roles, objectives, document control | ISO/IEC 27001:2022 cl. 4–7 |
| [`isms/risk-assessment.md`](isms/risk-assessment.md) | Risk method, acceptance criteria, and a register of 31 risks with treatment and acceptance record | ISO/IEC 27001:2022 cl. 6.1, 8.2–8.3 |
| [`isms/statement-of-applicability.md`](isms/statement-of-applicability.md) | All 93 Annex A controls with applicability, status, evidence, owner, and the Remaining actions list | ISO/IEC 27001:2022 Annex A |
| [`isms/operations.md`](isms/operations.md) | Operational control, metrics, internal audit programme and first audit record, management review, nonconformities | ISO/IEC 27001:2022 cl. 8–10 |
| [`crypto-and-keys.md`](crypto-and-keys.md) | Key management policy on NIST SP 800-57 Part 1 principles, per-key permitted use, cryptographic inventory, internal-transport decision, deprecation and post-quantum note | ASVS 5.0 V11.1.1–V11.1.2, V12.3.3; ISO/IEC 27001:2022 8.24 |
| [`auth-and-sessions.md`](auth-and-sessions.md) | Authentication pathways, passwords and context-specific words, MFA and lost-authenticator procedure, session lifetimes and concurrency, authorization matrix, security events, Supabase checklist | ASVS 5.0 V6–V10, V16.3 |
| [`communications.md`](communications.md) | Every inbound listener and outbound destination, and the egress policy decision | ASVS 5.0 V13.1.1, V13.2.4–V13.2.5; ISO/IEC 27001:2022 8.20–8.22 |
| [`logging.md`](logging.md) | Every log sink with format, location, access and retention; known deviations | ASVS 5.0 V16.1.1, V16.2.3; ISO/IEC 27001:2022 8.15 |
| [`operator-hardening.md`](operator-hardening.md) | Checklist of what an operator must set outside the repository: TLS proxy, Supabase, host, egress, logs | ASVS 5.0 Operator items (4.1.2, 6.2.1, 6.2.4, 6.2.12, 10.4.1, 10.4.5, 10.4.8, 12.1.1, 12.1.2, 12.2.1, 12.2.2) |
| [`data-protection.md`](data-protection.md) | Data classes, protection requirements, at-rest controls and retention per store, encrypted backup guidance, third-party disclosure of lookups | ASVS 5.0 V14.1.1, V14.1.2, V14.2.4, V14.3.3; ISO/IEC 27001:2022 5.12, 5.34, 8.10, 8.13 |
| [`input-and-files.md`](input-and-files.md) | Input validation rules, business-logic limits, timeouts, upload routes and archive limits, malware-scanning position | ASVS 5.0 V2.1.1–V2.1.3, V5.1.1, V5.4.3, V15.1.3; ISO/IEC 27001:2022 8.26 |
| [`ssdf-attestation.md`](ssdf-attestation.md) | Status of every SSDF 1.1 task (42 active, 5 retired identifiers) | NIST SP 800-218 |
| [`csf-profile.md`](csf-profile.md) | Current Profile of all 106 subcategories, Tier, and Target Profile note | NIST CSF 2.0 |
| [`asvs-l2-assessment.md`](asvs-l2-assessment.md) | Application verification at Level 2, per requirement, 2026-09-13 | OWASP ASVS 5.0.0 |
| [`gap-analysis-2026-09.md`](gap-analysis-2026-09.md) | Code, CI and container gap analysis (G1–G20) with fixes and evidence; the findings of the first internal audit | All four |
| [`incident-response.md`](incident-response.md) | Runbook for a compromised deployment: detect, contain, eradicate, recover, learn | ISO/IEC 27001:2022 5.24–5.28 |
| [`references/README.md`](references/README.md) | Source URLs and sha256 hashes of the framework documents | — |

## Snapshot (2026-09-13)

| Framework | Result |
| --- | --- |
| ISO/IEC 27001:2022 Annex A (93) | 23 Implemented, 35 Partial, 6 Planned, 12 Operator, 17 N/A |
| NIST SSDF 1.1 (42 active tasks) | 18 Met, 22 Partial, 2 Not met (plus 5 retired identifiers, N/A) |
| NIST CSF 2.0 (106) | 27 Achieved, 52 Partial, 9 Not achieved, 13 Operator, 5 N/A; overall Tier 2 |
| Risk register (31) | 6 inherent High; 2 High today (R03 unreleased fixes, R07 ruleset bypass and access review); R26–R31 from the ASVS assessment accepted |

Open work, with owners and dates, is in the Statement of Applicability under
[Remaining actions](isms/statement-of-applicability.md#remaining-actions).

## Maintenance

The maintainer keeps these documents current on the cycle set out in
[`isms/README.md`](isms/README.md#9-who-maintains-the-isms-and-how) §9. A document is approved when it is
merged to `master`.
