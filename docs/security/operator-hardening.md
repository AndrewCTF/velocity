# Operator hardening checklist

| Field | Value |
| --- | --- |
| Covers | Every OWASP ASVS 5.0 Level 2 requirement the assessment marked **Operator** (§5), plus the operator-side conditions of accepted risks R27–R30; ISO/IEC 27001:2022 A.8.9, A.8.20, A.8.21, A.8.24 |
| Version | 1.0 (Draft until merged to `master`) |
| Adopted | 2026-09-13 |
| Owner | Maintainer (content); Operator (doing it, per deployment) |
| Review | Yearly with the SoA, and when the ASVS assessment is repeated |
| Code citations | Working tree of branch `compliance-2026-09`, read on 2026-09-13 (base commit `56db34f`). Lines marked `<!-- recheck -->` sit in files parallel work was changing |

These controls cannot be set from this repository. The production compose file serves plain HTTP on
`127.0.0.1:8080` and expects a TLS reverse proxy on the host in front of it
(`docker-compose.prod.yml`, nginx `ports:` comment). A deployment that skips this page does not meet ASVS
Level 2, whatever the application does. Tick each box on every multi-user or internet-facing deployment,
and repeat the check after upgrades and yearly.

## 1. TLS and the host reverse proxy

- [ ] **TLS on every path.** Terminate HTTPS for `/`, `/api/`, `/tiles/`, `/ws/` and `/mcp`. Redirect
      HTTP to HTTPS with 301 **only for the web pages**; for `/api/`, `/ws/` and `/mcp`, refuse plain HTTP
      (close the port or answer 403) so a client that mistakenly sends a credential over HTTP gets an error,
      not a redirect after the credential has already been sent. (ASVS V4.1.2, V12.2.1)
- [ ] **Protocol versions.** TLS 1.3 enabled; TLS 1.2 as the minimum; TLS 1.0, 1.1 and SSLv3 disabled.
      (V12.1.1)
- [ ] **Cipher suites.** TLS 1.2 limited to ECDHE key exchange with AEAD ciphers (AES-GCM or
      ChaCha20-Poly1305); no CBC, RC4, 3DES, static RSA key exchange or export suites. The Mozilla
      "intermediate" profile meets this. Where the proxy supports it, enable hybrid post-quantum key
      exchange (X25519MLKEM768). (V12.1.2)
- [ ] **Certificate.** Issued by a publicly trusted CA for the exact host name (ACME is fine), renewed
      automatically, private key readable only by the proxy. Key: ECDSA P-256 or RSA 2048 or larger.
      (V12.2.2; key row in [`crypto-and-keys.md`](crypto-and-keys.md) §1.2)
- [ ] **HSTS.** The bundled nginx sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`
      (`infra/nginx/nginx.prod.conf`) <!-- recheck -->. Make sure the host proxy passes it through, or
      sets the same header.
- [ ] **Access-log scrubbing.** Strip the query string from the proxy's access log, or at least the `key=`
      parameter. WebSocket upgrades carry the Supabase session token or `API_KEY` as `?key=`, because
      browsers cannot set headers on an upgrade. The bundled nginx and the api already keep it out of their
      own logs ([`logging.md`](logging.md), L2, L3 and L9); the host proxy's log (L11) is yours. Examples:
      nginx `log_format` using `$uri` instead of `$request`; Caddy `log { format filter { request>uri
      query { delete key } } }`. (Condition of R27; V10.1.1)
- [ ] **Timeouts.** Read timeout at least 330 s for `/api/workflows/`, and long (hours) for `/ws/`, `/mcp`
      and the SSE routes `/api/intel/agent` and recon job events
      ([`input-and-files.md`](input-and-files.md) §3.1). (V15.1.3)
- [ ] **Forwarded address.** The proxy overwrites, not appends to, `X-Forwarded-For`, and the api's
      `TRUSTED_PROXIES` lists only addresses that really are proxies (set in `docker-compose.prod.yml`)
      <!-- recheck -->. A wrong value lets a client choose the address the lockout and rate limiter see.
- [ ] **Host names.** Set `CORS_ORIGINS` to the public `https://` origin and, if needed, `ALLOWED_HOSTS`
      to the public host name (`Settings.cors_origins`, `Settings.allowed_hosts`). The compose
      default `CORS_ORIGINS` is `http://localhost:8080` (`docker-compose.prod.yml`) <!-- recheck -->.
- [ ] **Topology.** Keep nginx and the api on the same host, and do not publish the api port. Splitting
      them across hosts voids accepted risk R28; add TLS or a WireGuard tunnel between them if you do.

## 2. Supabase project (multi-user mode)

The same list, with the reasons, is the "Delegated Supabase settings checklist" in
[`auth-and-sessions.md`](auth-and-sessions.md). Setting names follow the Supabase dashboard on 2026-09-13
and may move; they are not verifiable from this repository.

- [ ] **Dedicated project.** One Supabase project per deployment, used by nothing else. Every user of the
      project is a user of Velocity and gets the default role.
- [ ] **Sign-up OFF, invite-only.** Authentication > Providers > Email > "Allow new users to sign up": off.
      Invite users from Authentication > Users. New accounts receive the `analyst` role by default
      (`apps/api/supabase/migrations/0001_gotham_substrate_acl_audit.sql:21`) <!-- recheck -->. (V8.2.1)
- [ ] **Password length.** Minimum 15 (at least 8). (V6.2.1)
- [ ] **Leaked-password protection** (HaveIBeenPwned) on. This is also the compensating control for the
      context-specific word list GoTrue cannot enforce. Needs the Pro plan on hosted Supabase. (V6.2.4,
      V6.2.12, V6.2.11)
- [ ] **Secure password change** and **secure email change** on.
- [ ] **Email OTP expiry ≤ 600 s.** (V6.5.5)
- [ ] **TOTP MFA enabled**, and every account with the `admin` role enrolled. Keep
      `OPERATOR_REQUIRE_MFA` at its default, on (`Settings.operator_require_mfa`). (V6.3.3)
- [ ] **Redirect URL allowlist.** Authentication > URL Configuration: the Site URL and **exact** redirect
      URLs of this deployment. No wildcards on a production host. (V10.4.1)
- [ ] **Refresh token reuse detection** on ("Detect and revoke potentially compromised refresh tokens"),
      reuse interval ≤ 10 s. (V10.4.5)
- [ ] **Session time-box 12 h** and **inactivity timeout 30 min** (Authentication > Sessions; Pro plan).
      Without Pro, refresh tokens have no absolute lifetime; record that as an accepted risk in your own
      register. (V10.4.8, V7.1.1)
- [ ] **JWT expiry ≤ 3600 s.** The api refuses tokens whose lifetime exceeds `JWT_MAX_LIFETIME_S`
      (default 24 h, `Settings.jwt_max_lifetime_s`).
- [ ] **Single session per user** set according to the concurrent-session policy
      ([`auth-and-sessions.md`](auth-and-sessions.md), Session lifecycle). (V7.1.2)
- [ ] **Rate limits** for sign-in, sign-up, OTP, verify and token refresh left at or below the defaults.
- [ ] Migrations `0000`, `0001` and `0002` applied in order.
- [ ] A written **lost-authenticator procedure** that your admins follow
      ([`auth-and-sessions.md`](auth-and-sessions.md), Lost authenticator procedure). (V6.4.4)

## 3. Host, network and logs

- [ ] **Egress.** If the deployment does not need arbitrary public egress, set `WORKFLOWS_HTTP_ALLOW_HOSTS`,
      set `WORKFLOWS_HTTP_BLOCK_PRIVATE=1`, and add a host egress firewall or a domain-allowlist proxy
      ([`communications.md`](communications.md) §3). (V13.2.4, V13.2.5; R29)
- [ ] **Volume encryption.** Put the `osint_data` volume on an encrypted disk
      ([`data-protection.md`](data-protection.md) §3.1).
- [ ] **Backups** encrypted, checksummed and off host ([`data-protection.md`](data-protection.md) §4.2).
- [ ] **Container logs** rotated (`max-size`, `max-file`) or shipped off host with a logging driver; kept
      90 days ([`logging.md`](logging.md) §2). The api container's `/tmp` sidecar logs are lost on restart.
- [ ] **`AUDIT_RETENTION_DAYS=365`** (or your own policy value) so local audit rows are pruned
      ([`logging.md`](logging.md), L6) <!-- recheck -->.
- [ ] **`docker` group** holds no one but administrators; it is equivalent to root.
- [ ] **NTP** running on the host (SoA 8.17).
- [ ] **Evidence files** opened only in an isolated VM; optional read-only out-of-band scanning
      ([`input-and-files.md`](input-and-files.md) §5). (V5.4.3; R26)
- [ ] **Shared machines.** Do not run keyless or static-key mode in a shared browser profile; its
      investigation data stays in the browser ([`data-protection.md`](data-protection.md) §6). (R30)

## 4. Application settings

- [ ] `ALLOW_UNAUTHENTICATED` unset (default off, `Settings.allow_unauthenticated`) on anything reachable
      beyond the operator's own machine.
- [ ] `API_KEY`, if used, generated with `secrets.token_urlsafe(32)`, never in `VITE_API_KEY`, and given
      to no more than one class of client ([`crypto-and-keys.md`](crypto-and-keys.md) §1.1 rule 6).
- [ ] `BYOK_ENC_KEY` generated with `Fernet.generate_key()` and rotated yearly with the prepend procedure.
- [ ] Workflow `auth_env` fields name only dedicated per-target token variables
      ([`crypto-and-keys.md`](crypto-and-keys.md) §1.1 rule 7).
- [ ] `MAVLINK_BRIDGE_TOKEN` set before arming a MAVLink uplink.

## 5. ASVS requirements assessed as Operator

| ASVS 5.0 | Level | Requirement area | Where on this page |
| --- | --- | --- | --- |
| 4.1.2 | 2 | HTTP to HTTPS redirect only for user-facing endpoints | §1 TLS on every path |
| 6.2.1 | 1 | Minimum password length | §2 Password length |
| 6.2.4 | 1 | Check against common passwords | §2 Leaked-password protection |
| 6.2.12 | 2 | Check against breached passwords | §2 Leaked-password protection |
| 10.4.1 | 1 | Exact redirect URI allowlist | §2 Redirect URL allowlist |
| 10.4.5 | 1 | Refresh token replay protection | §2 Refresh token reuse detection |
| 10.4.8 | 2 | Absolute refresh token lifetime | §2 Session time-box |
| 12.1.1 | 1 | TLS 1.2 minimum, 1.3 preferred | §1 Protocol versions |
| 12.1.2 | 2 | Recommended cipher suites only | §1 Cipher suites |
| 12.2.1 | 1 | TLS for all external HTTP connectivity | §1 TLS on every path |
| 12.2.2 | 1 | Publicly trusted certificates | §1 Certificate |
