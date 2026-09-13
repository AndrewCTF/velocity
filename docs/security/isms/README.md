# Velocity information security management system (ISMS)

| Field | Value |
| --- | --- |
| Standard | ISO/IEC 27001:2022, clauses 4 to 10 |
| Version | 1.0 (Draft until merged to `master`) |
| Adopted | 2026-09-13 |
| Owner | Maintainer (GitHub `AndrewCTF`) |
| Next review | At the first management review, due by 2026-12-15 (see [`operations.md`](operations.md#93-management-review)) |

This ISMS was adopted on 2026-09-13. Before that date the project had security practices (CI, guard
tests, a disclosure policy) but no ISMS. Nothing here is a certificate; see
[`../README.md`](../README.md#certification-status).

| Document | Clauses |
| --- | --- |
| This file | 4.1–4.4, 5.1–5.3, 6.2, 6.3, 7.1–7.5 |
| [`risk-assessment.md`](risk-assessment.md) | 6.1.1–6.1.3, 8.2, 8.3 |
| [`statement-of-applicability.md`](statement-of-applicability.md) | 6.1.3 d), Annex A |
| [`operations.md`](operations.md) | 8.1, 9.1, 9.2, 9.3, 10.1, 10.2 |

## 1. Context and scope

### 1.1 Context (4.1)

Velocity is an open-source, self-hosted OSINT and geospatial intelligence platform, published as
`AndrewCTF/velocity` on GitHub under AGPL-3.0-or-later (`LICENSE`). The project has one maintainer, no
employees and no offices. It ships source code, version tags and container images
(`.github/workflows/publish.yml`). Each operator runs their own deployment, holds its `.env` and owns the
data it collects (`DISCLAIMER.md`).

The issues that shape the ISMS are:
- Operators trust the release channel. A compromised dependency, action or maintainer account reaches
  every deployment that upgrades.
- The software fetches untrusted third-party content, runs operator-authored workflow code, and can be
  deployed with no authentication (keyless boot is a product requirement).
- One person does all the work, so segregation of duties has to come from automation.

### 1.2 Scope and boundaries (4.3)

**In scope**
- Development of the Velocity software in `AndrewCTF/velocity`: source, branches, pull requests, the
  repository ruleset and security settings.
- Build and release: GitHub Actions workflows under `.github/workflows/`, version tags, and the GHCR
  images `ghcr.io/andrewctf/velocity-api` and `ghcr.io/andrewctf/velocity-web`.
- The dependency set declared in the lockfiles.
- The maintainer's GitHub account, signing key and development workstation.
- The maintainer's reference deployment: the `docker-compose.prod.yml` shape on a maintainer-controlled
  host. Its live configuration was not inspected for this document, so controls that depend on the host
  are marked Partial or Operator in the SoA.

**Out of scope**
- Deployments run by operators other than the maintainer. Controls that only operate there carry the
  owner **Operator** in the SoA, with a note on how the software supports them.
- Upstream data sources the software reads (ADS-B, AIS, basemaps, satellite catalogues). They are
  suppliers of data, not part of the system (`SECURITY.md`, Scope).
- GitHub's own infrastructure. GitHub is a supplier; its facilities are covered by the owner
  **Upstream provider** in the SoA.

**Interfaces**: GitHub (repository, Actions, GHCR, advisories), package registries (npm, PyPI,
crates.io), base-image registries (Docker Hub), and the operator, who pulls images or source.

### 1.3 Interested parties (4.2)

| Party | Needs and expectations | Addressed by |
| --- | --- | --- |
| Operators (self-hosters) | Releases free of known high or critical vulnerabilities; honest security defaults; a way to verify and upgrade; clear responsibilities | `SECURITY.md`, `docker-compose.prod.yml`, `docs/security/incident-response.md`, SoA "Operator" rows |
| End users of a deployment (analysts) | Their sessions and data are protected by the operator's instance | Application controls in `apps/api/CLAUDE.md` (Auth) |
| People who appear in collected data | Their personal data is handled lawfully by the operator | `DISCLAIMER.md` (operator is data controller) |
| Security researchers | A private channel, acknowledgement, credit | `SECURITY.md`; GitHub private vulnerability reporting |
| Contributors | Clear rules for changes; their PRs are reviewed and tested | CI workflows, ruleset |
| Collaborators with write access | Defined permissions | Access review (RA-03 in the SoA) |
| Upstream data providers | Their terms of use are respected | `DISCLAIMER.md`, `docs/commercial-licensing.md` |
| Suppliers: GitHub, npm, PyPI, crates.io, Docker Hub | Use within their terms | Standard terms (SoA 5.20) |
| Authorities and regulators | Lawful processing and breach notification by data controllers | Operator responsibility (SoA 5.5, 5.34) |

Requirements that the ISMS must address (4.2 c): the AGPL licence, the response targets the project
publishes in `SECURITY.md`, and the terms of the suppliers above. Data-protection law binds operators,
not the maintainer, because the maintainer processes no operator data.

### 1.4 The ISMS (4.4)

The ISMS is the set of documents in `docs/security/` together with the automated checks they point to.
Most controls are code: CI jobs, CodeQL, Dependabot, guard tests and repository settings. The documents
record scope, risk, decisions and the review cycle around those checks.

## 2. Suppliers

| Supplier | Service | Criticality |
| --- | --- | --- |
| GitHub | Repository, Actions, GHCR, secret scanning, Dependabot, CodeQL, advisories | Critical |
| npm registry | JavaScript packages (`pnpm-lock.yaml`) | Critical |
| PyPI | Python packages (`apps/api/uv.lock`) | Critical |
| crates.io | Rust crates (`apps/desktop/src-tauri/Cargo.lock`) | High |
| Docker Hub | Base images `python`, `node`, `nginx` pinned by digest | High |
| Upstream data sources | Public feeds read at runtime | Medium (availability only; see `DISCLAIMER.md`) |

## 3. Information security policy (5.2)

Adopted 2026-09-13 by the maintainer. It applies to everything in scope (§1.2) and is published with the
source so operators and contributors can read it.

1. **Security fixes come first.** A confirmed high or critical vulnerability is patched and released
   within 7 days of triage, as `SECURITY.md` states.
2. **Every change goes through a pull request and CI.** Tests, lint, dependency audit and CodeQL run on it,
   and no known high or critical finding is merged.
3. **Dependencies are locked and watched.** Installs use the lockfiles. Dependabot runs weekly, and GitHub
   Actions and base images are pinned to immutable references.
4. **Secrets never enter the repository.** Secret scanning and push protection stay enabled, and the
   software keeps credentials out of logs and responses.
5. **Defaults fail closed.** Code execution, compute routes and outbound requests refuse when their guard
   cannot run. Any exception is an explicit operator setting, and it is documented.
6. **Every operator decision that weakens a default is recorded** in `docs/decisions.md`, together with the
   guard test that holds it.
7. **Claims need evidence.** A control is only called implemented when a file, setting or command output
   shows it (`CLAUDE.md`, Operating rules).
8. **Vulnerability reports are received privately** and acknowledged within 72 hours.
9. **Operator responsibilities are stated plainly**, together with the support the software gives for them.
10. **The ISMS is reviewed and improved.** There is an annual internal audit and a management review at
    least twice a year, and nonconformities are tracked to closure ([`operations.md`](operations.md)).

Topic-specific rules live where they are enforced: `apps/api/CLAUDE.md` (application security
invariants), `SECURITY.md` (disclosure and patching), `docs/security/incident-response.md` (incidents).

## 4. Roles, responsibilities and authorities (5.1, 5.3)

The maintainer (GitHub `AndrewCTF`) holds every role:

| Role | Responsibilities |
| --- | --- |
| Top management | Approves the policy, the risk acceptance and the resources; chairs management review |
| ISMS owner | Maintains these documents, the risk register and the SoA |
| Security officer | Triages vulnerability reports and alerts; leads incident response |
| Release manager | Tags releases; owns the publish workflow and GHCR images |
| Internal auditor | Runs the annual self-audit ([`operations.md`](operations.md#92-internal-audit)) |
| Developer and reviewer | Writes and approves changes |

A second GitHub account, `SimonRos1`, holds write access (read with `gh api` on 2026-09-13). No ISMS role
is assigned to it, and its access is due for review (RA-03).

### 4.1 Segregation of duties

One person cannot independently review their own work. These automated controls stand in for a second
person:

| Compensating control | Evidence | Working today? |
| --- | --- | --- |
| CI `web`, `api` and `security` jobs on every PR | `.github/workflows/ci.yml`; all green on PR #87 | Runs, but it is **not a required status check** in the ruleset (RA-04) |
| CodeQL on push, PR and weekly, gated by the ruleset `code_scanning` rule (high or higher blocks) | `.github/workflows/codeql.yml`; ruleset 18510846 | Yes |
| Branch ruleset "Security" (no deletion, no force push, linear history, PR with 1 approval, signed commits) | ruleset 18510846, `enforcement: active` | **Partly.** Two RepositoryRole bypass actors have `bypass_mode: always`. PR #87 merged with no human approval, and 7 of the last 8 `master` commits are unsigned (RA-04) |
| Required signatures | same ruleset | Not effective while bypass is used (RA-04) |
| Dependabot and secret scanning run independently of the maintainer | GitHub setting: security_and_analysis | Yes |

The remaining gap is recorded as risk R07 and is scored High until RA-03 and RA-04 are done.

## 5. Objectives (6.2)

Measured as described in [`operations.md`](operations.md#91-monitoring-and-measurement). The first
measurement was taken on 2026-09-13.

| # | Objective | Target | Measure | 2026-09-13 |
| --- | --- | --- | --- | --- |
| O1 | No open high or critical dependency advisories | 0 | Open Dependabot alerts; `pnpm audit --audit-level=high`; `pip-audit` | 0 alerts; pnpm 0 across 566; pip-audit none found. **Met** |
| O2 | High or critical vulnerabilities reach a release quickly | Released within 7 days of triage or fix availability | Days from fix merged to release tag | PR #87 fixes merged 2026-09-13; last release v1.0.1 (2026-07-16). **At risk, due 2026-09-20** (RA-01) |
| O3 | CI security job green on `master` | Every run green; a red run fixed within 7 days | Actions run history for `ci` | `security` job green on `master`. The whole `ci` run on `f38a912` failed in the `api` job and was green again 7 minutes later on `bbb28be`. **Met** |
| O4 | No open code-scanning alerts rated high or above | 0 | Open code-scanning alerts | 0. **Met** |
| O5 | No secret exposure in the repository | 0 open secret-scanning alerts | Open secret-scanning alerts | 0. **Met** |
| O6 | Vulnerability reports acknowledged on time | 100% within 72 h | Advisory timestamps | 0 reports received. **No data** |
| O7 | Planned actions closed on time | 100% of RA items closed by target date, or re-dated at a management review | SoA Remaining actions | 20 raised, 3 closed on 2026-09-13 (RA-02, RA-06, RA-20), 17 open, none overdue. **On track** |
| O8 | Controls that are enforced as code keep their guard | API test suite green, without falling below the recorded baseline | `scripts/verify.sh` | 2632 passed, 2 skipped (per `docs/security/gap-analysis-2026-09.md`; not re-run for this document) |

Plans to achieve them (6.2 e–i) are the Remaining actions in the SoA, each with an owner and target date.

### 5.1 Planning of changes (6.3)

A change to the ISMS itself (scope, policy, roles, objectives) is made by a pull request that edits these
files, and it is recorded in the next management review. A change to a guarded security behaviour follows
`CLAUDE.md`: both the guard and the file stating the decision are changed, and `docs/decisions.md` records
why.

## 6. Information classification

| Class | Examples | Handling |
| --- | --- | --- |
| Public | Source code, docs, releases, closed advisories | Published in the repository |
| Embargoed | Unfixed vulnerability details, incident notes before disclosure | Private GitHub security advisory only; never in issues, PRs or commit messages until fixed |
| Secret | Signing key, GitHub tokens, `.env` values, provider API keys | Never committed (push protection); held on the maintainer endpoint or in the operator's `.env`; rotated per `docs/security/incident-response.md` §3 |

## 7. Support (7.1–7.5)

- **Resources (7.1).** The maintainer's time, plus the GitHub security features that are free for public
  repositories (CodeQL, Dependabot, secret scanning, private vulnerability reporting).
- **Competence (7.2).** Self-directed. The evidence is the framework mapping in
  `docs/security/gap-analysis-2026-09.md` and the security invariants in `apps/api/CLAUDE.md`. No formal
  training record exists (SoA 6.3).
- **Awareness (7.3).** The policy is published in this file. Contributors meet it through CI results and
  `SECURITY.md`.
- **Communication (7.4).**

  | What | To whom | How | When |
  | --- | --- | --- | --- |
  | Security advisories | Operators, public | GitHub Security Advisory and release notes | When a fix ships |
  | Breaking security defaults | Operators | `docs/decisions.md` entry and release notes | Each release |
  | Report acknowledgement | Reporter | The private advisory thread | Within 72 h |
  | ISMS status | Public | These documents | At each management review |

- **Documented information (7.5).** See §8.

## 8. Document control (7.5)

| Rule | How it works here |
| --- | --- |
| Location | `docs/security/` in the repository. The copy on `master` is the approved one |
| Identification | Each document has a header table with version, adoption date, owner and next review |
| Approval | Merging a pull request to `master` is the approval. Until then a document is a Draft (these are on branch `compliance-2026-09`) |
| Change history | git history of the file; significant changes also get a line in the next management review record |
| Availability | Public on GitHub. Embargoed material is kept out of these files (§6) |
| Retention | Kept for as long as the repository exists; superseded versions stay in git history |
| External documents | Framework PDFs are listed with hashes in `docs/security/references/README.md`. ISO/IEC 27001 text is not stored; only control numbers and titles are cited |

## 9. Who maintains the ISMS, and how

The maintainer owns and maintains the ISMS. The cycle, adopted 2026-09-13:

| Activity | Cadence | Record |
| --- | --- | --- |
| Metrics O1–O8 | Monthly, and before each release | [`operations.md`](operations.md#91-monitoring-and-measurement) measurement log |
| Risk register and SoA update | At each trigger in `risk-assessment.md` §4, and at least yearly | These files, via PR |
| Management review | At least twice a year: by 2026-12-15, then every six months | [`operations.md`](operations.md#93-management-review) |
| Internal audit | Yearly; the next is due by 2027-09-13 | [`operations.md`](operations.md#92-internal-audit) |
| Nonconformity tracking | Continuous | [`operations.md`](operations.md#10-improvement) |
