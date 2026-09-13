# Security policy

## Supported versions

Only the latest published release (the newest `vX.Y.Z` tag / GHCR image, and
`master`) is supported with security fixes. This is a self-hosted,
single-maintainer project — there is no long-term-support branch. Upgrade to
the latest release before reporting an issue; an older tag will not receive a
backported fix.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through **GitHub Security
Advisories**, not a public issue:

<https://github.com/AndrewCTF/velocity/security/advisories/new>

Do not open a public issue, discussion, or pull request for a suspected
vulnerability until a fix has shipped — this repo has no bug bounty, but
responsible disclosure is credited in the advisory and release notes on
request.

Include what you'd want if you were fixing it: affected version/commit,
reproduction steps or PoC, and impact (what an attacker gains, and who is
exposed — a keyless local instance, an authenticated multi-user deployment, or
both).

### Response targets

- **Acknowledgement:** within 72 hours.
- **Triage** (confirmed/not, severity, affected versions): within 7 days.
- **Fix timeline for confirmed issues:** high/critical severity patched and
  released within 7 days of triage; medium/low severity folded into the next
  regular release. These are targets for a project run by one maintainer, not
  contractual SLAs.

## Update cadence

- **Dependencies:** Dependabot runs weekly across npm, uv/pip, cargo,
  github-actions, and the Docker base images (`.github/dependabot.yml`).
  Minor/patch bumps are grouped per ecosystem; major bumps land as individual
  PRs for manual review.
- **Major version reviews:** dependency majors (a new FastAPI/Pydantic/Tauri
  major, a new base-image major) are reviewed at least monthly, not left to
  accumulate.
- **Advisories:** once a fix is available, high/critical-severity advisories
  affecting this project's own code are patched and released within 7 days;
  the same applies to a high/critical advisory in a direct dependency once an
  upstream fix exists.
- **Static analysis:** CodeQL runs on every push to `master`, every pull
  request, and weekly on a schedule (`.github/workflows/codeql.yml`), across
  the TypeScript/JavaScript and Python code.

## Scope

In scope: the FastAPI backend (`apps/api`), the web console (`apps/web`), the
desktop shell (`apps/desktop`), the MCP server, the Docker images and compose
files under `infra/`, and the CI/CD workflows under `.github/`.

Out of scope: third-party upstream data sources this platform reads from
(ADS-B/AIS feeds, basemap tiles, satellite catalogs, etc.) and vulnerabilities
that require an attacker to already have the level of access a legitimate
operator/administrator has to their own deployment (e.g. direct filesystem or
Docker-host access) — those are deployment hardening questions, not bugs in
this project.
