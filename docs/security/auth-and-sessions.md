# Authentication, sessions and authorization

This page covers how a caller proves who they are, how long that proof lasts, and what each
caller may do. It is written against ASVS 5.0 Level 2 (V6 authentication, V7 session management,
V8 authorization, V9 self-contained tokens, V10 OAuth/OIDC). The code is `apps/api/app/auth.py`,
`apps/api/app/security.py` and `apps/api/app/keys.py`. The SQL is in
`apps/api/supabase/migrations/`. Each rule below names the test that enforces it.

## Deployment modes

The backend runs in one of three modes. The mode decides which rules apply.

| Mode | Configured with | Who the callers are |
| --- | --- | --- |
| **Keyless** | nothing | Anyone who can reach the port. Cheap data layers are open. Compute, LLM, workflows, Foundry and `/mcp` refuse with 503 unless `ALLOW_UNAUTHENTICATED=1`. |
| **Static key** | `API_KEY` only | One operator. Holding the key makes you the operator. |
| **Multi-user** | `SUPABASE_JWT_SECRET`, or `SUPABASE_URL` + `SUPABASE_ANON_KEY` (an `API_KEY` may also be set) | Several people, told apart by their Supabase user id (`sub`). Roles come from `public.profiles`. |

The code tests for multi-user mode with `security._multi_user` and `keys.multi_user`. Supabase
being configured is the signal. Which store a feature uses does not matter.

## Authentication pathways (V6.1.1, V6.1.3, V6.3.4)

| Pathway | Carried as | Strength | Checks applied | Accepted at |
| --- | --- | --- | --- | --- |
| Keyless | nothing | none | Compute paths and `/mcp` fail closed. Everything else is open. | cheap data routes only |
| Static `API_KEY` | `X-API-Key` header | One shared secret, single factor, never expires. At least 32 characters, or the backend will not start. | constant-time compare; failed-credential lockout | `ApiKeyMiddleware`, `require_api_key`, WebSocket upgrades |
| WebSocket subprotocol | `Sec-WebSocket-Protocol: velocity.v1, key.<credential>` on the upgrade (the web client's carrier; the server selects `velocity.v1` only) | same as the credential it carries | Same as the header forms; never in a URL or access log. | `WsSubprotocolMiddleware`, `require_ws_key` |
| WebSocket `?key=` | query string on the upgrade only (older clients, or a key with characters a subprotocol cannot carry) | same as the credential it carries | Same as the header forms. Redacted from `uvicorn.access` and `uvicorn.error`. Ignored on plain HTTP. | `require_ws_key` |
| Supabase session, local HS256 | `Authorization: Bearer <jwt>` | Password, plus TOTP when the session is `aal2` | header `alg` = `HS256` (and `typ` = `JWT` if present); signature; `exp` required and in the future; `nbf` in the past; `exp - iat` ≤ `JWT_MAX_LIFETIME_S` (24 h); `sub` required; `aud` contains `authenticated`; `role` = `authenticated`; `iss` = `SUPABASE_URL/auth/v1` (or `SUPABASE_JWT_ISSUER`) when a URL is set; lockout | everywhere; the only kind that resolves a user |
| Supabase session, GoTrue | same | same | Every claim rule above except the signature, which GoTrue checks when it answers `/auth/v1/user` with 200. | same |
| Internal MCP token | `Authorization: Bearer <jwt>`, minted by `mcp_server._mint_internal_jwt` | HS256 over the project secret. 10-minute lifetime, 1-hour ceiling. | `alg` = `HS256`; signature; `exp` required; `aud` and `iss` both `velocity-internal`. `role` is not `authenticated`, so PostgREST refuses it too. | `ApiKeyMiddleware` and `require_api_key` only. Never on a WebSocket. Never as a user: `current_user` returns 401. |
| Supabase session in `X-API-Key` | a Supabase access token sent in the `X-API-Key` header instead of `Authorization` | same as the session it carries | `ApiKeyMiddleware` takes the Bearer header, or else the `X-API-Key` value, as the token (`apps/api/app/auth.py`) <!-- recheck -->, and `keys.current_user` does the same (`apps/api/app/keys.py:156`). The same claim rules and lockout apply as for the Bearer forms | everywhere the Bearer form is |
| `/api/config` credential probe | `X-API-Key` or `Authorization` on `GET /api/config` | same as the credential it carries | The route checks the credential only to decide whether to return the Cesium and Google keys; an invalid one gets blanks, not 401. **Not counted toward the failed-credential lockout** (docstring of `get_config`, `apps/api/app/routes/config.py`), so it tells a caller whether a credential is valid, limited only by the general per-client rate limit and the nginx edge rate <!-- recheck --> | `/api/config` only |
| MAVLink bridge bearer | `Authorization: Bearer` from the API to the loopback bridge (`MAVLINK_BRIDGE_TOKEN`) | operator-generated shared secret | `hmac.compare_digest` (`apps/api/app/mavlink_bridge.py:317-318`); required when an uplink is armed (`apps/api/app/mavlink_bridge.py:375-379`); the bridge binds `127.0.0.1` only (`apps/api/app/mavlink_bridge.py:381`). Off by default (`Settings.mavlink_bridge_enabled`) | the bridge process only, not the API |
| Ingest token | `X-Ingest-Token` on `POST /api/ingest/{dataset_id}` | 256-bit random value, stored as sha256 | Constant-time compare. An unknown dataset and an unarmed one both return the same 404. The body is capped before it is parsed. Lockout applies. | that route only. The middleware treats `/api/ingest/` as public, so the token is the whole gate. |

Tests: `tests/test_auth_asvs.py`, `tests/test_auth_query_key_and_jwt.py`,
`tests/test_mcp_internal_jwt.py`, `tests/test_ingest_webhook.py`.

**Failed-credential lockout (V6.3.1).** Every pathway above counts failures per client. The client
is the peer address, or the rightmost untrusted `X-Forwarded-For` hop when the peer is in
`TRUSTED_PROXIES`. After `AUTH_FAILURE_LIMIT_PER_MIN` failures (default 20), every attempt from
that client gets 429 with `Retry-After`, even one with the right credential. That way a locked-out
guesser learns nothing. Only attempts that present a credential count, so a signed-out browser
that keeps polling is not locked out. The lockout is per IP address, not per account, so nobody
can lock a victim's account by guessing at it. Password sign-in happens at GoTrue and uses
GoTrue's own rate limits (see the checklist below).

**Minimum secret length.** The lifespan calls `auth.check_credential_strength`. It refuses to boot
with an `API_KEY` or `SUPABASE_JWT_SECRET` shorter than 32 characters. Generate a key with
`python -c 'import secrets; print(secrets.token_urlsafe(32))'`.

## Passwords (V6.1.2, V6.2.1, V6.2.4, V6.2.11, V6.2.12)

Passwords are set and checked by GoTrue, not by this repository. The web form only sets
`minLength` to 8 (`PASSWORD_MIN` in `apps/web/src/auth/AuthForm.tsx`), which a
caller can bypass by talking to GoTrue directly. Every password control below is therefore a Supabase
project setting, listed in the checklist at the end of this page and in
[`operator-hardening.md`](operator-hardening.md).

**Context-specific words (V6.1.2).** A password must not contain any of these, case-insensitively:

- the product and project names: `velocity`, `osint`, `gotham`, `foundry`, `watchofficer`;
- the name of the organisation running the deployment, and its domain name without the TLD;
- the local part of the user's own email address;
- the words `password`, `admin`, `operator`, `analyst`, `supabase`.

**Decision (2026-09-13, V6.2.11).** This list is not enforced in code. GoTrue's password policy offers a
minimum length, required character classes and the leaked-password (HaveIBeenPwned) check, and has no
custom word list, so a server-side check would need a proxy in front of GoTrue. The repository has no
client-side check either: `apps/web/src/auth/AuthForm.tsx` passes the password to `supabase.auth.signUp` and
`supabase.auth.updateUser` without inspecting its content (no word check found on 2026-09-13)
<!-- recheck -->, and a client check would be bypassable in any case. The
compensating controls are GoTrue's leaked-password protection, which rejects passwords already seen in
breaches (common product-name passwords are among them), a minimum length of 15 on deployments that
follow the checklist, and TOTP on every operator account. Operators who need the list enforced must
place an auth proxy in front of GoTrue. Risk: low, recorded with the ASVS assessment.

**Browser-facing requests with no credential (V3.5, V4.4.2, V13.4.5, V13.3.2).**

- `app/origin_guard.py` refuses a `Host` header outside `ALLOWED_HOSTS` with 400. By default that
  list is the loopback names plus the hosts in `CORS_ORIGINS`. `*` turns the check off. This stops
  DNS rebinding.
- For any method other than GET, HEAD or OPTIONS, and for every WebSocket upgrade, the same module
  returns 403 when `Origin` (or, if there is no `Origin`, `Referer`) is present and is neither in
  `CORS_ORIGINS` nor the request's own host. Callers that send neither header, such as scripts,
  the MCP hop and feeders, pass.
- With auth enabled, `/docs`, `/redoc` and `/openapi.json` need a credential. A keyless dev box
  still serves them.
- `/api/config` is public, but it returns the Cesium and Google keys only to a caller with a
  credential when auth is enabled.

**`API_KEY` is not a browser credential (V7.2.2).** `API_KEY` is for servers, the CLI, CI and the
MCP server. Never build it into a hosted web bundle. Anything in a JavaScript bundle can be read
by everyone who loads the page, and this key never expires and carries operator authority. The web
build refuses `VITE_API_KEY` for hosted builds (`apps/web/src/buildGuard.test.ts`). Browsers use
Supabase sessions.

## Operator authority and MFA (V6.3.3, V6.8.4, V10.3.4)

`security.require_operator` gates the routes that carry operator authority:

- running `op.python` or actuation blocks;
- model downloads and deletes;
- every workflow route except the block catalog;
- every Foundry mutation.

In keyless and static-key modes it always passes, because the one user is the operator. In
multi-user mode it checks three things, in order:

1. The `admin` role in `public.profiles`. Otherwise it returns 403.
2. `aal` = `aal2` in the verified token, meaning the admin passed a TOTP challenge. Otherwise it
   returns 403, and the message tells the user to enrol an authenticator. `OPERATOR_REQUIRE_MFA=0`
   turns this check off, for example while TOTP is being rolled out.
3. The account is still active in GoTrue (see revocation below). Otherwise it returns 401.

A static `API_KEY` is single-factor. In static-key mode that is an accepted risk: the holder is
the only user, and the key lives on servers, not in browsers. To require MFA, run multi-user mode.
The internal MCP token never reaches an operator route. None of the MCP tools call one.

Tests: `test_auth_asvs.py::test_aal1_admin_is_refused_with_an_mfa_message`, `::test_aal2_admin_passes`,
`::test_mfa_requirement_can_be_switched_off`, `::test_single_user_modes_need_no_mfa`,
`::test_operator_mfa_end_to_end_over_http`.

## Session lifecycle (V7.1.1, V7.1.2, V7.1.3, V7.3.1, V7.3.2, V7.6.1)

| Component | Lifetime | Where it is set |
| --- | --- | --- |
| Supabase access token (JWT) | GoTrue's JWT expiry. Default 3600 s, recommended ≤ 3600 s. The backend refuses any token whose `exp - iat` exceeds 24 h. | Supabase > Auth > Sessions, `JWT_MAX_LIFETIME_S` |
| Supabase refresh token | Rotates on use. It lives until the time-box or inactivity timeout ends the session. | Supabase > Auth > Sessions |
| Backend positive token cache | ≤ 60 s, and never past the token's `exp` | `auth.TOKEN_CACHE_TTL_S` |
| Operator liveness cache (GoTrue `/auth/v1/user`) | ≤ 60 s per token | `security._ACTIVE_TTL` |
| Profile (roles, clearance) cache | 60 s per user | `security._TTL` |
| Internal MCP token | 10 min. Re-minted about 60 s before expiry. | `mcp_server._INTERNAL_JWT_TTL_S` |
| Static `API_KEY` | Until rotated. Rotating means changing the env var and restarting. | operator |
| Web idle sign-out | 30 min without input, with a warning toast 60 s before (`DEFAULT_IDLE_MINUTES`, `IDLE_WARNING_MS` in `apps/web/src/auth/idle.ts`). The time of the last input is kept in `localStorage` (`LAST_ACTIVITY_KEY`), so a tab reopened after the limit signs out at once. Runs only in the browser and only with a Supabase session (`useIdleSignOut`). The web reads `sessionIdleTimeoutMin` from `/api/config` (`idleMinutesFrom`), but `RuntimeConfig` in `apps/api/app/routes/config.py` does not send that field, so the value is fixed at 30 min <!-- recheck --> | `auth/idle.ts` |

**Revocation (V7.4.1, V7.4.2, V7.4.5).** An admin can sign a user out, ban them or delete them in
the Supabase dashboard. How fast that takes effect depends on the route:

- **Operator routes** check with GoTrue at most once a minute. A signed-out, banned or deleted
  admin loses operator authority within 60 s. This needs `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- **Other routes on a deployment with `SUPABASE_URL` and no JWT secret** re-ask GoTrue once the
  60-second cache expires. They also stop within about a minute.
- **Other routes on a deployment with a JWT secret** check tokens locally. A copied access token
  stays valid there until its own `exp`, which is at most the JWT expiry (default one hour) after
  sign-out. This is the residual risk. To shrink it, lower the JWT expiry in Supabase.
- **A JWT-secret-only deployment** (no `SUPABASE_URL`) has no GoTrue to ask, even for operator
  routes. Every session there lasts until `exp`.
- **`API_KEY`** is revoked by rotating it. Rotate it whenever staff change.

**Recommended Supabase session settings.** Auth > Sessions:

- **Time-box user sessions**: 12 h. Needs the Pro plan.
- **Inactivity timeout**: 30–60 min. Needs the Pro plan.
- **JWT expiry**: ≤ 3600 s.
- **Single session per user**: on, if a user should not stay signed in on two devices. This is a
  deployment choice. The backend works either way.

The web client refreshes tokens automatically. The Supabase time-box and inactivity timeout are
what actually end a session on the server side.

**Why these values (V7.1.1).** NIST SP 800-63B sets reauthentication limits per assurance level.
Revision 3 (§4.2.3) requires AAL2 reauthentication at least every 12 hours and after 30 minutes of
inactivity; Revision 4 relaxes this to 24 hours and 1 hour. Velocity's operator routes require AAL2
(password plus TOTP), so the recommended settings follow the stricter Revision 3 figures: a 12-hour
time-box and a 30-minute inactivity limit. An access token lifetime of at most 3600 s bounds how long a
copied token outlives a sign-out (see Revocation).

**Without Supabase Pro.** The time-box and inactivity timeout need the Pro plan. On the free plan, or a
self-hosted GoTrue without those settings, refresh tokens have no absolute expiry, and the only
inactivity control is the 30-minute browser timer above. That timer does not help when a refresh token
has been stolen, because the attacker's client never runs it. Operators handling D4 data on such a plan
accept that risk in their own register, or use Pro.

**Concurrent sessions (V7.1.2).** Policy: **unlimited concurrent sessions per account by default.** An
analyst commonly works on a desktop and a laptop, and each session is individually bounded by the time-box
and inactivity limit. A deployment that wants one session per account turns on **Single session per
user** in Supabase. According to Supabase's documentation, the most recent sign-in then keeps its
session and older sessions are terminated when they next refresh; this behaviour is Supabase's and was not
verified from this repository. No user-visible notice is shown on the older device beyond being signed
out. A user can end their own other sessions from the account page ("Sign out other sessions", after
re-entering the current password), and a password change or reset offers the same; both call
`supabase.auth.signOut({ scope: 'others' })` in `apps/web/src/auth/AuthForm.tsx` <!-- recheck -->. Admins can end
every session of a user from the Supabase dashboard (Authentication > Users > the user > Sign out) at any
time.

## Multi-factor authentication (V6.4.4, V6.5.1, V6.5.5)

TOTP enrolment, challenge and verification are GoTrue's. The web client enrols, challenges and removes
factors through supabase-js (`supabase.auth.mfa.enroll` and `mfa.unenroll` in `apps/web/src/auth/AuthForm.tsx`).
There are no recovery codes.

**Accepted upstream deviations.** GoTrue validates TOTP with a 30-second period and a skew of one step,
so a code is accepted for about 90 seconds, and it does not record used codes, so the same code can pass
a second challenge inside that window (V6.5.1, V6.5.5). Each challenge can be verified only once. The
repository cannot change this. The email one-time code used for reauthentication before a password
change (`supabase.auth.reauthenticate` in `apps/web/src/auth/AuthForm.tsx`) must expire within 600 seconds (checklist below).
Source: the GoTrue implementation (`supabase/auth`, TOTP validation), read by the assessor on 2026-09-13
and not re-verified here.

### Lost authenticator procedure (V6.4.4)

A user who has lost their TOTP device cannot remove the factor themselves: removal needs an `aal2`
session. Recovery is done by a Supabase project admin, as follows.

1. **Request.** The user asks through a channel the organisation already trusts (not a reply to an email
   the user just sent from an unknown address).
2. **Identity proofing, at least as strong as enrolment.** The admin confirms the request out of band,
   using contact details recorded before the loss (a known phone number or an in-person or video check
   against the person the account was issued to). If the account holds the `admin` role, a **second**
   admin must also confirm.
3. **Password first.** If the user also lost their password, they reset it through the normal reset email
   before the factor is removed, so that one person never controls both steps.
4. **Remove the factor.** In the Supabase dashboard, Authentication > Users > the user > delete the
   factor (or `DELETE /auth/v1/admin/users/{id}/factors/{factor_id}` with the service-role key). Then sign
   the user out of all sessions from the same page.
5. **Record it.** Write an entry in the organisation's change record with: date and time (UTC), user id,
   admin(s) who approved, the proofing method used, and the factor id removed. Velocity's own audit log
   does not see Supabase dashboard actions; the GoTrue audit log in Supabase (Authentication > Logs) holds
   the corresponding event.
6. **Re-enrol.** The user signs in (reaching `aal1`), enrols a new authenticator at once, and an admin
   confirms `aal2` works on an operator route before the ticket is closed.

## Authorization matrix (V8.1.1, V8.1.2)

"Owner" means rows are filtered by the caller's Supabase `sub`. "All" means everyone who passed
authentication. In keyless and static-key modes there is one identity, `local`, so owner scoping
has no effect there.

| Route group | Keyless | Static key | Multi-user: analyst | Multi-user: admin |
| --- | --- | --- | --- | --- |
| Data layers (`/api/adsb`, AIS, hazards, `/tiles`, …) | open | key | all | all |
| Compute (`/api/intel/agent`, recon, imagery detect, LLM briefs) | 503 unless `ALLOW_UNAUTHENTICATED` | key | all | all |
| Ontology, situations, maps, evidence | `local` | `local` | owner | owner |
| `/ws/cop` follow-along rooms | open room by id | key | owner of the map only. Rooms are keyed by owner + map id. There is no sharing model yet. | same |
| Alert rules | `local` | `local` | owner | owner |
| `/api/alerts`, `/ws/alerts` | all | all | system-wide alerts plus the caller's own watch-rule firings | same |
| `/api/alerts/deliveries` (sink URLs) | all | all | owner | owner |
| Timeline, correlations, incident brief, analytics | all alerts | all alerts | system-wide alerts only | same |
| Action proposals (list, approve, reject) | n/a (needs a user) | n/a | owner. Another user's proposal returns 404. | all |
| Actions dispatch | n/a | n/a | all (audited by `sub`) | all |
| Watch-officer briefs: read | open | key | all | all |
| Watch-officer briefs: ack, dismiss | open | key | needs a user (a static key alone is refused); audited | same |
| Workflows: every route except `/blocks` | 503 unless opted in | key | **403** | admin + aal2 + active |
| AI models: mutations | 503 unless opted in | key | **403** | admin + aal2 + active |
| Foundry: reads | 503 unless opted in | key | all | all |
| Foundry: mutations (including `POST /sql` and `/transforms/preview`) | 503 unless opted in | key | **403** | admin + aal2 + active |
| `/api/audit` | local log | local log | **403** | auditor or admin |
| BYOK keys, targets | n/a | n/a | owner (RLS) | owner |
| Collab docs | n/a | n/a | owner, or cleared for the classification and compartments | same, plus admin write |

Tests: `tests/test_multi_user_scoping.py` covers each multi-user row with two distinct users.
`tests/test_security_hardening.py::test_every_mutating_actuation_route_carries_the_operator_gate`
and `test_multi_user_scoping.py::test_every_foundry_mutation_carries_the_operator_gate` are the
anti-rot walks.

### Field-level rules

**`public.profiles`.** After migration `0002`, a user can read their own row and write none of it.

- `roles`, `clearance` and `compartments` change only through the service role or
  `public.admin_set_profile_access(user, roles, clearance, compartments)`.
- That RPC is `SECURITY DEFINER`. It refuses any caller without `admin`. It will not grant a
  clearance or compartment the calling admin does not hold.
- `email` is written by triggers from `auth.users`. It is not self-writable, because it is the
  principal's email in the audit log.
- Guard: `tests/test_profile_privilege_sql.py` replays every migration's grants and revokes.

**Classified rows** (`objects`, `links`, `target_board`, `collab_docs`):

- A user cannot create a row, or raise one, above their own clearance or outside their
  compartments. The restrictive `*_clf_ceiling` policies enforce this.
- Only signed-in users can read shared rows. The anon key reads nothing (migration `0002`).
- A collab doc's owner cannot be set to someone else.

**Evidence objects.** Custody properties (`sha256`, `media_type` and related) are written by
`/api/evidence` on ingest. See `docs/security/input-and-files.md` for the rule on writes through
the generic ontology route.

## Security event logging (V16.3.1–V16.3.4)

Logging is configured once in `app/logging_setup.py`: one root handler, ISO-8601 UTC timestamps,
and the level from `LOG_LEVEL`. Security events are single `WARNING` lines on the `app.auth` and
`app.security` loggers, written as `key=value` pairs. A line never includes a credential, a token
or a full sink URL.

| Event | Line starts with | Fields |
| --- | --- | --- |
| Bad or missing credential at the middleware, WebSocket or ingest route | `auth failure` | client, path, reason |
| Client locked out by the failed-credential throttle | `auth lockout` | client, path |
| A route answered 401, 403 or 429 (role, MFA, owner, audit gate) | `unauthorized` / `forbidden` / `throttled` | client, method, path, reason |
| Rate limiter refused a request | `rate limit exceeded` | client, path, bucket |
| Outbound fetch refused: alert sink, evidence capture, `/tiler` | `ssrf refused` | where, host, reason |
| Host header or cross-site request refused | `host refused` / `cross-site refused` | client, path, host or origin |

"Client" is the address the rate limiter uses: the peer, or the rightmost untrusted
`X-Forwarded-For` hop when the peer is in `TRUSTED_PROXIES`. Tests:
`tests/test_asvs_v11_v17.py::test_auth_failures_rate_limits_and_ssrf_refusals_are_logged`,
`::test_forbidden_responses_are_logged`.

## Delegated Supabase settings checklist

These controls live in the Supabase project, not in this repository. Set them on every
multi-user deployment. [`operator-hardening.md`](operator-hardening.md) repeats them together with the
host, proxy and network settings.

- [ ] **Auth > Providers > Email > Allow new users to sign up: OFF** (invite-only). Any account that
      exists gets the `analyst` role by default (`apps/api/supabase/migrations/0001_gotham_substrate_acl_audit.sql:21`)
      <!-- recheck -->, and with that the compute, LLM and Foundry read routes. With sign-up on, anyone who
      can reach the project can create one. With it off, the web `/signup` page
      (`apps/web/src/AppRouter.tsx:63`) returns GoTrue's refusal. Invite users from Authentication > Users.

- [ ] **Auth > Providers > Email > Minimum password length**: at least 8, 15 recommended
      (`GOTRUE_PASSWORD_MIN_LENGTH`).
- [ ] **Auth > Providers > Email > Password requirements**: leaked-password protection
      (HaveIBeenPwned) on.
- [ ] **Auth > Providers > Email > Secure password change** on. Reauthentication is required
      before `updateUser({password})`.
- [ ] **Auth > Providers > Email > Secure email change** on. Both addresses must confirm.
- [ ] **Auth > Multi-Factor > TOTP** enabled. Needed for operator `aal2`.
- [ ] **Auth > Rate Limits**: sign-in, sign-up, verify, token refresh and OTP limits per IP left
      at or below the defaults.
- [ ] **Auth > URL Configuration**: Site URL and **exact** redirect URLs. No wildcards on a
      production host.
- [ ] **PKCE** flow for the web client (`flowType: 'pkce'`). Owned by the web client.
- [ ] **Auth > Providers > Email > Email OTP expiry**: ≤ 600 s (ASVS V6.5.5 caps out-of-band codes at 10 minutes).
- [ ] **Auth > Sessions > Detect and revoke compromised refresh tokens** (refresh-token reuse
      detection) on, with a reuse interval ≤ 10 s.
- [ ] **Auth > Sessions**: time-box, inactivity timeout and JWT expiry as listed under session
      lifecycle.
- [ ] **Auth > Sessions > Single session per user**: set per the concurrent-session policy above.
- [ ] Use a **dedicated Supabase project** for each deployment. Do not share one with another
      application: every user of that project is a user here.
- [ ] **Host reverse proxy access log**: strip the query string, or at least the `key=` parameter.
      WebSocket upgrades carry the session token or `API_KEY` as `?key=` (`require_ws_key`).
      The bundled nginx already logs the path without the query (`log_format noquery` in
      `infra/nginx/nginx.prod.conf`) and the api redacts uvicorn's lines (`RedactKeyFilter`), but the host
      proxy in front of them is the operator's ([`logging.md`](logging.md), L11).
- [ ] Migrations `0000`, `0001` and `0002` applied in order (`infra/db/README.md`).
