# Security gap analysis — 2026-09

Scope: the whole repository at `0011de5` (branch `security-hardening-2026-09`). That covers the FastAPI
backend (`apps/api`), the web console (`apps/web`), the Tauri desktop shell, the feeder sidecars
(`tools/`), the container images and compose stacks (`infra/`, `docker-compose*.yml`), and CI
(`.github/workflows`).

Out of scope: the organizational half of an ISO 27001 ISMS, meaning clauses 4–10, the risk register, the
Statement of Applicability, HR controls (A.6) and physical controls (A.7). A code review cannot produce
those. See [Residual and organizational](#residual-and-organizational).

## Method

Three freely published frameworks sit on one axis each, and ISO/IEC 27001:2022 Annex A is the umbrella
that every finding cites:

| Framework | Level | Used for |
| --- | --- | --- |
| ISO/IEC 27001:2022 Annex A (93 controls) | organization | the control each finding violates; titles checked against the 2022 Annex A table |
| NIST CSF 2.0 (CSWP 29) | organization / program | function coverage: Govern, Identify, Protect, Detect, Respond, Recover |
| NIST SP 800-218 SSDF 1.1 | software supply chain and SDLC | practices PO, PS, PW, RV |
| OWASP ASVS 5.0.0 | application | chapters V1–V17 |

The references and their hashes are in [`references/README.md`](references/README.md). Every finding
comes from reading code or running a command in this session, and each one below names its evidence.
Status is one of **fixed** (commit plus verification output), **accepted** (a deliberate design choice,
with the reason given) or **residual** (still open, with the reason given).

## Baseline measurements (before)

| Measure | Command | Result |
| --- | --- | --- |
| npm advisories | `pnpm audit --json` (metadata) | critical 3, high 11, moderate 27, low 6 across 652 dependencies |
| Python advisories (lock) | `uv export --frozen --no-emit-project` then `uvx pip-audit --no-deps --disable-pip` | 34 vulns in 6 packages: pillow 12.2.0 (25), httpx2 2.4.0 (3), cryptography 49.0.0 (2), mcp 1.28.0 (2), httpcore2 2.4.0 (1), pydantic-settings 2.14.1 (1) |
| Python advisories (dev venv) | `pip freeze` of `apps/api/.venv` then pip-audit | 40 vulns in 7 packages (the lock's 6 plus pyasn1 0.6.3 (6)). The venv has drifted from the lock (awscli, botocore, matplotlib are not in `uv.lock`) |
| Outdated Python packages | `pip list --outdated` | 64 |
| Dependency update automation | look for `.github/dependabot.yml` or `renovate.json` | none |
| Supply-chain scanning in CI | grep of `.github/workflows` | none (no audit, CodeQL or secret scan) |

## Findings

| # | Gap | Evidence | ISO 27001:2022 Annex A | SSDF | ASVS 5.0 | CSF 2.0 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | Known-vulnerable JS dependencies, 3 of them critical | pnpm audit: maplibre-gl 5.24 sanitizer XSS; react-router-dom 6.30.3 open redirect; dompurify / protobufjs through cesium 1.141; vitest 2.1.9 UI file read; `request`/`form-data@2` through `@macrostrat/cesium-martini → get-pixels` (node-only path, since get-pixels' `browser` field uses `dom-pixels.js`) | 8.8 Management of technical vulnerabilities | PW.4, RV.1 | V15.2 | ID.RA-01 | open |
| G2 | Python installs ignore the lockfile, and the dev venv has drifted from it | `.github/workflows/ci.yml:47` and `infra/docker/api.Dockerfile:13` run `pip install -e .` while `apps/api/uv.lock` exists; `pyproject.toml` pins with `>=` floors only; `pyproject.toml:30-37` records an outage when mcp 2.0 was picked up silently | 8.8; 8.32 Change management; 8.19 Installation of software on operational systems | PS.3, PW.4 | V15.2 | PR.PS-02 | open |
| G3 | No automated update or scan loop | no Dependabot/Renovate; CI has no pnpm audit, pip-audit or CodeQL | 8.8; 8.29 Security testing in development and acceptance | RV.1, PW.7, PW.8 | V15.1 | ID.RA-01, DE.CM | open |
| G4 | Supply-chain pinning | every GitHub Action pinned by tag, not SHA; base images `python:3.12-slim`, `node:22-alpine`, `nginx:1.27-alpine` without digests; prod compose uses `:latest`; `apps/native` has no Cargo.lock; `tools/*` feeders have no lockfiles; `@mapbox/martini` resolves from a GitHub tarball | 5.21 Managing information security in the ICT supply chain; 8.9 Configuration management | PS.1, PS.2, PO.3 | V15.2 | GV.SC | open |
| G5 | Unneeded and duplicate dependencies | `@mkkellogg/gaussian-splats-3d` is never imported (`@sparkjsdev/spark` renders splats); `requests`, `aiohttp` have no imports in `apps/api/app`; stdlib `urllib` in `intel/lod1.py` next to httpx in 31 files; five separate playwright copies over two version ranges; tracked scratch `tmp/redesign/` | 8.8; 8.27 Secure system architecture and engineering principles | PW.4 | V15.2 | PR.PS | open |
| G6 | Unbounded upload bodies | `routes/foundry.py:282,305,325` `await file.read()`; `routes/recon.py:560-584` copies multi-file uploads without a cap. Evidence upload already caps (`routes/evidence.py:163-185`) | 8.26 Application security requirements; 8.28 Secure coding; 8.6 Capacity management | PW.5 | V5.2 | PR.PS | open |
| G7 | Analyst-reachable LAN webhook (SSRF) | `routes/alert_rules.py:148` and `intel/watch.py:702` validate `sink_url` with `workflows/control.check_url`, which blocks only link-local/IMDS on purpose (the operator's control server lives on the LAN). Alert-rule create/update depend on `current_user_or_local` (`:174`), not `require_operator`, so any analyst session can aim deliveries at loopback/LAN services. There are also three separate SSRF helpers (`control.py`, `intel/evidence.py`, `news/images.py`) | 8.26; 8.28; 8.20 Networks security | PW.5 | V1.3, V15.3 | PR.PS | open |
| G8 | Credentials accepted in the query string on HTTP routes | `auth.py:225-232` reads `?key=` for every request. The web client only needs it for WebSocket upgrades (`apps/web/src/transport/http.ts:100-108`), yet on HTTP the key lands in proxy access logs and browser history | 8.5 Secure authentication; 5.17 Authentication information; 8.15 Logging | PW.5 | V6.2, V4.1 | PR.AA | open |
| G9 | JWT audience not checked | `auth.py:101-119` `_verify_hs256` checks signature, `exp` and `role`, but not `aud` | 8.5 | PW.5 | V9.2 | PR.AA | open |
| G10 | One key means one role | `security.py:155-188`: with no Supabase configured, the static-key holder is the operator | 5.15 Access control; 8.2 Privileged access rights; 5.3 Segregation of duties | — | V8.2 | PR.AA | **accepted**: documented design (single-user deployment has one principal); use Supabase to separate roles |
| G11 | Rate limiting only on compute paths; one shared bucket behind nginx | `ratelimit.py:34-55` compute prefixes only; `TRUSTED_PROXIES` defaults to loopback while the prod nginx reaches the api from a bridge IP | 8.6; 8.20 | PW.5 | V2.4 | PR.PS, DE.CM | open |
| G12 | Missing browser hardening headers | hosted web build has no CSP (`apps/web/vite.config.ts:19-49` injects one only for desktop); Tauri `"csp": null`; `infra/nginx/nginx.prod.conf` sends no security headers and no `limit_req`, and `server_tokens` is on | 8.9; 8.26 | PW.9 | V3.4 | PR.PS-01 | open |
| G13 | `op.python` sandbox binary missing from the image | `workflows/python_exec.py:98-150` jails with bubblewrap and falls back to rlimits-only; `infra/docker/api.Dockerfile` never installs bubblewrap | 8.22 Segregation of networks (the jail is `--unshare-net`); 8.27 | PW.9 | V15.3 | PR.PS | open |
| G14 | Container hardening | prod compose: nginx publishes `8080` on all interfaces, no `cap_drop`, `no-new-privileges`, pids or memory limits | 8.9; 8.20 | PW.9 | V13 | PR.PS-01, PR.IR-01 | open |
| G15 | Audit trail covers 3 route modules | `audit()` called from `routes/extract.py`, `routes/countries.py` and `routes/osint.py` only; workflows, foundry, evidence, model download/delete, ingest and MCP mutations leave no record | 8.15 Logging; 8.16 Monitoring activities; 5.28 Collection of evidence | PO.5 | V16.2, V16.3 | DE.CM-03 | open |
| G16 | No disclosure, incident or backup process | no `SECURITY.md`, no incident runbook, no backup/restore for the `osint_data` volume | 5.24 Incident management planning; 5.26 Response to incidents; 5.5 Contact with authorities; 5.30 ICT readiness for business continuity; 8.13 Information backup | RV.1, RV.2, RV.3, PO.1 | — | GV.PO, RS.MA, RC.RP | open |
| G17 | No secret scanning | no gitleaks, pre-commit or GitHub push protection config; `.env` correctly untracked (`git log --all` shows no `*.env`) | 8.12 Data leakage prevention; 5.17 | PS.1 | V13.3 | PR.DS | open |

## Already in place (credit where due)

- Workflows mutations and actuation carry operator authority (`security.py:155`), and compute routes refuse a keyless box unless `ALLOW_UNAUTHENTICATED=1` (`auth.py:214-220`).
- Static key comparison is constant-time (`auth.py:184`). The anon Supabase JWT is rejected as a credential (`auth.py:113-118`).
- Containers run as uid 10001. Workflow tokens are `contents: read`. There is no `pull_request_target`.
- `op.sql` runs read-only in in-memory SQLite with an interrupt timeout (`foundry/sqlrun.py`). No `shell=True` subprocesses.
- BYOK user API keys are Fernet-encrypted at rest. DSNs are stored as env-var names, never values.
- The evidence blob endpoint serves `default-src 'none'; sandbox` (`routes/evidence.py:327`).
- Sidecars bind loopback (`tools/*/index.js`, llama.cpp/vLLM `--host 127.0.0.1`).

## Remediation log

Filled in as each fix lands: commit, verification command and output.

## After measurements

Pending.

## Operator decisions

Pending.

## Residual and organizational

- ISO 27001 certification needs an ISMS: scope (cl. 4.3), risk assessment and treatment (6.1.2–6.1.3), a Statement of Applicability, internal audit (9.2) and management review (9.3). None of these are code artifacts.
- A.6 people controls and A.7 physical controls are out of repository scope.
