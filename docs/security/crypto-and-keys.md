# Cryptography and key management

| Field | Value |
| --- | --- |
| Covers | OWASP ASVS 5.0 V11.1.1 (key management policy), V11.1.2 (cryptographic inventory), V12.3.3 (internal transport, accepted risk); ISO/IEC 27001:2022 A.8.24 |
| Version | 1.1 (Draft until merged to `master`) |
| Adopted | 2026-09-13 (1.0); revised 2026-09-13 (1.1: NIST SP 800-57 basis, sharing rule, permitted-use columns, MultiFernet, missing keys) |
| Owner | Maintainer (policy); Operator (keys of a deployment) |
| Review | Yearly with the Statement of Applicability, and on any trigger event in §1.1 |
| Code citations | Cells revised in 1.1 cite the working tree of branch `compliance-2026-09` read on 2026-09-13 (base commit `56db34f`). Files that parallel work was still changing (`auth.py`, `config.py`, `security.py`, the sidecar spawners, compose and nginx) are cited by symbol name instead of line, and marked `<!-- recheck -->`. Cells not revised still cite commit `2cd38d9`; read them with `git show 2cd38d9:<path>` |

Every claim about behaviour cites the line that implements it. "Policy" marks a rule that this document
sets and the code does not enforce.

## 1. Key management policy (V11.1.1)

### 1.0 Basis

This policy follows the key-management principles of **NIST SP 800-57 Part 1 Rev. 5, *Recommendation for
Key Management: Part 1 – General***. It applies them by name as follows:

- **Key lifecycle states.** Every key moves through pre-activation (generated, not yet in `.env`), active
  (loaded by a running process), deactivated (kept only to decrypt or verify old data, as a second
  `BYOK_ENC_KEY` entry is during rotation), compromised, and destroyed. §1.2 states generation, storage,
  rotation and destruction for each key.
- **Cryptoperiod.** Each key has a stated maximum active period (the "Rotation" column). A cryptoperiod
  ends early on any trigger event in §1.1.
- **Key-usage separation.** One key serves one purpose. §1.2 names each key's permitted and forbidden
  uses. The one deviation is recorded there: `SUPABASE_JWT_SECRET` both verifies user sessions and signs
  the internal MCP token.
- **Least exposure, including limited sharing.** A key is held by as few entities as its purpose
  allows (rule 6 below).
- **Compromise recovery.** A suspected compromise is handled by [`incident-response.md`](incident-response.md)
  §3, which revokes and replaces the key before anything else.
- **Accountability.** Each key has a named holder ("Held by").

### 1.1 General rules (policy, adopted 2026-09-13)

1. Generate secrets with a CSPRNG: `secrets.token_urlsafe`, `openssl rand`, or `Fernet.generate_key()`.
   Never derive them from passwords or words.
2. Keep deployment secrets only in the operator's `.env`, or in a secret manager that injects environment
   variables. `.env` and `*.env` are gitignored (`.gitignore:11-13`). GitHub push protection is enabled on
   the repository ([`isms/statement-of-applicability.md`](isms/statement-of-applicability.md), 5.17).
3. Never log a secret, and never return one after the response that mints it. Never put a secret in a URL
   that a client or library may log; where an upstream requires one (FIRMS puts its key in the URL path),
   the URL-logging libraries must stay silenced ([`logging.md`](logging.md), L4).
4. Rotate a key at once, whatever its schedule, on any of these **trigger events**: suspected or confirmed
   leak; a person who knew the key loses their role (maintainer change, departing co-operator); the host,
   a backup or the `.env` is exposed; a dependency advisory affects the primitive. The full procedure is in
   [`incident-response.md`](incident-response.md) §3.
5. Destroy a key by removing it from `.env` and the secret manager, recreating the containers so no
   process still holds it, and deleting or re-keying any backup that contains the `.env`.
6. **Sharing rule.** A shared secret is held by at most the deployment itself and **one** class of client.
   `API_KEY` is the case this rule exists for: give each CI job, MCP client or script that needs server
   access its own Supabase account (multi-user mode) instead of copying `API_KEY` to it. Where a deployment
   must copy `API_KEY` to more than one client class, the operator records that in their own risk register
   and rotates it whenever any holder changes. Never build `API_KEY` into a web bundle
   ([`auth-and-sessions.md`](auth-and-sessions.md), "`API_KEY` is not a browser credential").
7. **Permitted use only.** A key is used only for the purpose in its row of §1.2. A workflow control
   block's `auth_env` field names an environment variable whose value is sent as a bearer token
   (`apps/api/app/workflows/control.py:274-285`). The code accepts any variable name there, so policy
   restricts it: `auth_env` names only a variable created for that one target (for example
   `DRONE_SERVER_TOKEN`), never `API_KEY`, `SUPABASE_JWT_SECRET`, `BYOK_ENC_KEY` or a provider key.

### 1.2 Per key

Data classes D1–D6 are defined in [`data-protection.md`](data-protection.md) §1.1.

| Key | Purpose and permitted use | Forbidden use | Algorithm and generation | Storage | Rotation (cryptoperiod) and triggers | Held by | Destruction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `API_KEY` | Static shared secret authenticating server, CLI, CI and MCP callers, and the one user of a single-user deployment. Gates access to D1–D6 | Browser bundles (`VITE_API_KEY`); `auth_env` in workflows; any upstream request | Random string compared in constant time (`secrets.compare_digest` against `s.api_key` in `apps/api/app/auth.py`). Operator generates it with `python -c "import secrets;print(secrets.token_urlsafe(32))"`. The backend refuses to start with fewer than 32 characters (`MIN_API_KEY_LEN` and `check_credential_strength` in `apps/api/app/auth.py`) <!-- recheck --> | `.env`, loaded as `Settings.api_key` (`apps/api/app/config.py`). HTTP accepts it only in the `X-API-Key` header (`ApiKeyMiddleware`); `?key=` only on WebSocket upgrades (`require_ws_key`), both in `apps/api/app/auth.py` <!-- recheck --> | Yearly (policy), and on every trigger in §1.1. One key is one principal (`docs/decisions.md`, 2026-09-13), so rotating it logs every client out | Operator; the clients allowed by rule 6 | Remove from `.env`; rebuild the web bundle if `VITE_API_KEY` was ever set; recreate containers |
| `SUPABASE_JWT_SECRET` | Verifies Supabase HS256 user session JWTs locally (`_signed_claims`, `_verify_hs256` in `apps/api/app/auth.py`) <!-- recheck -->. **Also** signs the internal MCP token (`apps/api/app/mcp_server.py:166`, `apps/api/app/mcp_server.py:200`). That second use is a recorded key-usage-separation deviation: a separate internal signing key would remove it | Any use outside this process; signing tokens for other systems | HMAC-SHA256 key issued by the Supabase project (JWT settings). Backend refuses fewer than 32 characters (`check_credential_strength`, `apps/api/app/auth.py`) | `.env`, `Settings.supabase_jwt_secret` (`apps/api/app/config.py`) | On every trigger. Rotating it in Supabase invalidates every session and the MCP token, which is re-minted on the next call | Operator; Supabase | Rotate in Supabase; remove the old value from `.env` |
| `SUPABASE_ANON_KEY` | Public client key that lets the backend call GoTrue `/auth/v1/user` and PostgREST as the caller (`s.supabase_anon_key` checks in `apps/api/app/security.py` and `apps/api/app/auth.py`) <!-- recheck -->, and lets the browser reach Supabase (`VITE_SUPABASE_ANON_KEY` in `apps/web/src/transport/supabase.ts`) | Treating it as a secret control: it is public by design and grants only what row-level security allows | JWT issued by Supabase | `.env` (`Settings.supabase_anon_key`, `apps/api/app/config.py`); embedded in the web bundle as `VITE_SUPABASE_ANON_KEY` | When Supabase rotates project keys | Operator; every browser | Rotate in Supabase |
| `BYOK_ENC_KEY` (Fernet) | Encrypts users' own upstream API keys (D2) before they are stored in Supabase `public.user_keys` | Encrypting anything else; use as a token | Fernet: AES-128-CBC with HMAC-SHA256, 32 random bytes from `Fernet.generate_key()`. The value is one key or a comma-separated list, newest first, read into a `MultiFernet` (`apps/api/app/keys.py:96-110`). A malformed key makes BYOK routes return 503 (`apps/api/app/keys.py:109-110`) | `.env`, `Settings.byok_enc_key` (`apps/api/app/config.py`). Ciphertext only in the database | Yearly (policy), and on every trigger. **Procedure:** prepend the new key to the list, so new ciphertext uses it and old rows still decrypt (`apps/api/app/keys.py:96-101`); re-encrypt each stored row with `rotate_value` (`apps/api/app/keys.py:113-116`), or let users re-save; then remove the old key. Test: `apps/api/tests/test_asvs_v11_v17.py::test_byok_decrypts_under_an_old_key_after_rotation` | Operator | Remove the old key from the list after every row is re-encrypted |
| Foundry ingest tokens | Bearer credential for `POST /api/ingest/{dataset_id}` only | Any other route | `secrets.token_urlsafe(32)` (`apps/api/app/foundry/store.py:346`): 256 random bits | Only the SHA-256 is stored, compared with `compare_digest` (`apps/api/app/foundry/store.py:196`, `apps/api/app/foundry/store.py:395`); plaintext is shown once | On every trigger, and when a sender is decommissioned. Re-minting replaces the previous token | Operator; the one sending system | Re-mint, or delete the dataset |
| MCP internal token | Short-lived HS256 JWT the MCP server mints for its own calls to `/api/intel/*` when no static key is set | Operator routes; WebSockets; acting as a user (`docs/security/auth-and-sessions.md`, pathway table) | HS256 over `SUPABASE_JWT_SECRET`, minted with PyJWT (`apps/api/app/mcp_server.py:166-200`); `aud` and `iss` `velocity-internal` (`INTERNAL_AUDIENCE`, `INTERNAL_ISSUER` in `apps/api/app/auth.py`) | Memory only | Automatic: 10-minute lifetime (`apps/api/app/mcp_server.py:162`) | The API process | Expires; process restart clears it |
| Browser sidecar tokens (`SIDECAR_TOKEN`) | Bearer token between the API and the loopback ADS-B, AIS and browser-fetch sidecars; `/health` stays open | Anything else | `secrets.token_urlsafe(32)` per spawn (`mint` in `apps/api/app/sidecar_token.py`); the sidecar compares it with `crypto.timingSafeEqual` (`tokenOk` in `tools/browser-fetch/index.js`) <!-- recheck --> | Passed to the child as the `SIDECAR_TOKEN` environment variable; persisted to a `0600` file in a `0700` directory under the data directory so a restarted API can reuse a running sidecar (`token_dir`, `mint` in `apps/api/app/sidecar_token.py`) <!-- recheck --> | Every spawn | The API process and its sidecar | Replaced on the next spawn; delete the token directory to force one |
| Local model sidecar keys (llama.cpp, vLLM) | Bearer key between the API and the llama.cpp or vLLM server on loopback | Anything else | `secrets.token_urlsafe(32)` per boot (`_api_key` in `apps/api/app/llamacpp_sidecar.py` and `apps/api/app/vllm_sidecar.py`) | Process memory. **Passed to the child on its command line** (`--api-key` in the same files), so any local user who can list processes can read it while the sidecar runs <!-- recheck --> | Every boot | The API process and its sidecar | Process exit |
| `MAVLINK_BRIDGE_TOKEN` | Bearer token the loopback MAVLink bridge requires before it forwards drone commands (`apps/api/app/mavlink_bridge.py:317-318`). The bridge refuses to start an armed uplink without it (`apps/api/app/mavlink_bridge.py:375-379`) | Any other target | Operator-generated random string (policy: `secrets.token_urlsafe(32)`), compared with `hmac.compare_digest` | `.env`. The bridge child receives only allowlisted variables, including those prefixed `MAVLINK_` (`childenv.child_env` call in `apps/api/app/mavlink_sidecar.py`) <!-- recheck -->; a workflow block sends it through `auth_env` (§1.1 rule 7) | Yearly (policy), and on every trigger | Operator | Remove from `.env`; restart |
| Upstream provider keys | Authenticate this deployment to paid or registered upstreams, one key per provider: for example `CESIUM_ION_TOKEN`, `AISSTREAM_KEY`, `FIRMS_MAP_KEY`, `GFW_TOKEN`, `GMAPS_KEY`, `ACLED_KEY`, `UCDP_TOKEN`, `CLOUDFLARE_TOKEN`, `OPENAIP_KEY`, `MINIMAX_API_KEY`, `NVIDIA_API_KEY`, `DEEPSEEK_API_KEY`, `MARINETRAFFIC_KEY`, `HIBP_API_KEY` (the matching `Settings` fields in `apps/api/app/config.py`) | Sending a key to any host other than its provider; `auth_env` | Issued by each provider | `.env`. Cesium and Google keys are returned by `/api/config` only to a caller holding a credential when auth is enabled (`get_config` in `apps/api/app/routes/config.py`) <!-- recheck --> | On every trigger, and per the provider's own rules | Operator | Revoke at the provider; remove from `.env` |
| TLS certificate and private key | HTTPS for a deployment | — | The operator's host reverse proxy (for example ACME). Policy: ECDSA P-256 or RSA 2048 or larger; TLS 1.2 minimum | On the host proxy. **Not in this repository:** nginx listens on plain HTTP bound to `127.0.0.1:8080` (nginx `ports:` in `docker-compose.prod.yml`) <!-- recheck --> | The proxy's automatic renewal; revoke and reissue on key exposure | Operator | Revoke with the CA; delete from the host |
| Maintainer commit signing key | SSH signature on commits, required by the repository ruleset | Any other signing | `ssh-keygen -t ed25519`; git configured with `gpg.format=ssh` and `commit.gpgsign=true` (read with `git config` on 2026-09-13) | Maintainer endpoint (`~/.ssh`); public half registered on GitHub | Yearly (policy), and on endpoint loss or compromise | Maintainer | Remove from GitHub signing keys; delete the private key; see RA-08 (endpoint baseline) |

## 2. Cryptographic inventory (V11.1.2)

Libraries resolved in `apps/api/uv.lock` at `2cd38d9`: `cryptography` 50.0.1, `httpx` 0.28.1,
`certifi` 2026.7.22, `pyjwt` 2.14.0. Declared in `apps/api/pyproject.toml:24`, `apps/api/pyproject.toml:43-44`.

| Algorithm | Library | Purpose | Security role | Data classes protected | Location |
| --- | --- | --- | --- | --- | --- |
| HMAC-SHA256 (JWT HS256 verify) | stdlib `hmac`, `hashlib` (hand-written) | Verify Supabase session JWTs; header `alg` must be `HS256` | Authentication | Access to D3–D6 | `_signed_claims`, `_verify_hs256` in `apps/api/app/auth.py` <!-- recheck --> |
| HMAC-SHA256 (JWT HS256 sign) | PyJWT | Mint the MCP internal token | Authentication | Access to D1, D4 through MCP | `apps/api/app/mcp_server.py:166-200` |
| Constant-time comparison | stdlib `hmac.compare_digest` / `secrets.compare_digest` | JWT signature, static key, ingest token hash, MAVLink bearer; `crypto.timingSafeEqual` for sidecar tokens | Timing-attack resistance | D2 | `_signed_claims` and the static-key check in `apps/api/app/auth.py` <!-- recheck -->, `apps/api/app/foundry/store.py:395`, `apps/api/app/mavlink_bridge.py:317`, `tokenOk` in `tools/browser-fetch/index.js` |
| Fernet (AES-128-CBC, PKCS7, HMAC-SHA256, versioned token), `MultiFernet` for rotation | `cryptography.fernet` | Encrypt user BYOK keys at rest | Confidentiality and integrity | D2 (users' keys) | `apps/api/app/keys.py:24`, `apps/api/app/keys.py:96-131` |
| SHA-256 | stdlib `hashlib` | Ingest token storage (the token has 256 bits of entropy, so no salt or KDF is needed) | Credential storage | D2 | `apps/api/app/foundry/store.py:196` |
| SHA-256 | stdlib `hashlib` | Evidence content addressing, and a manifest hash over the member hashes | Integrity, chain of custody | D4 | At `2cd38d9`: `apps/api/app/intel/evidence.py:99`, `apps/api/app/intel/evidence.py:719`; re-verified before serving (`apps/api/app/routes/evidence.py:330-331`) |
| SHA-256 | stdlib `hashlib` | Verify downloaded llama.cpp binaries and model files | Integrity of fetched executables | — | At `2cd38d9`: `apps/api/app/localllm/binary.py:175`, `apps/api/app/localllm/manager.py:462` |
| CSPRNG | stdlib `secrets` | Ingest tokens and sidecar keys | Key generation | D2 | `apps/api/app/foundry/store.py:346`; `apps/api/app/sidecar_token.py` (`mint`); `_api_key` in `apps/api/app/llamacpp_sidecar.py` and `apps/api/app/vllm_sidecar.py` |
| TLS (system OpenSSL; CA bundle from certifi) | `httpx` default verification | All outbound HTTPS to upstreams through the shared client. No `verify=False` in `apps/api/app` (`git grep` on `2cd38d9`) | Transport confidentiality and server authentication | D1, D4, D6 in transit | At `2cd38d9`: `apps/api/app/upstream.py:344-349` |
| TLS (inbound) | Operator's host proxy | Client-to-deployment HTTPS | Transport | All classes in transit | Outside the repository (nginx `ports:` comment in `docker-compose.prod.yml`) |
| None (plaintext HTTP) | — | nginx to api over the compose bridge; api to loopback sidecars | **Accepted risk R28** (§2.1) | D2–D6 on the internal hop | `set $api_upstream api:8000` and `proxy_pass http://$api_upstream` in `infra/nginx/nginx.prod.conf`; `networks: front` in `docker-compose.prod.yml` <!-- recheck --> |
| SSH Ed25519 signatures | OpenSSH through git | Commit signing | Source integrity | — | Maintainer git configuration (§1.2) |
| MD5 | stdlib `hashlib` | Gravatar and Libravatar lookup keys, which those services require | **Not a security use** | — | At `2cd38d9`: `apps/api/app/osint/connectors.py:262`, `apps/api/app/osint/sources/social.py:77` |
| MD5 | stdlib `hashlib` | Cache keys and ETags | **Not a security use** | — | At `2cd38d9`: `apps/api/app/routes/adsb.py:536`, `apps/api/app/routes/adsb.py:2314`, `apps/api/app/routes/adsb.py:2332`, `apps/api/app/routes/maritime.py:410`, `apps/api/app/news/analyze.py:820`, `apps/api/app/places.py:191` |
| SHA-1 (truncated) | stdlib `hashlib` | Stable short identifiers | **Not a security use** | — | At `2cd38d9`: `apps/api/app/intel/promotion.py:55`, `apps/api/app/localllm/manager.py:62`, `apps/api/app/routes/ai_selection.py:377` |
| SHA-256 (truncated to 16 hex) | stdlib `hashlib` | Fetch cache key | **Not a security use** | — | At `2cd38d9`: `apps/api/app/osint/fetch.py:354` |
| SHA-256 key derivation for Apple Maps tokens | stdlib `hashlib` | Reproduces a third-party client's token scheme | Interoperability, not protection of project data | — | At `2cd38d9`: `apps/api/app/apple_maps.py:122`, `tools/apple-flyover/apple3d/auth.py:26` |

Web client: the Supabase session is kept in `localStorage` by supabase-js (`persistSession: true` in
`apps/web/src/transport/supabase.ts`; accepted risk R27). No application-level cryptography runs in the
browser.

### 2.1 Internal transport without TLS (V12.3.3, accepted risk)

**Decision (2026-09-13).** Traffic between components on one host is not encrypted:

- nginx proxies to the api as plain HTTP to `api:8000` (`set $api_upstream api:8000` and
  `proxy_pass http://$api_upstream` in `infra/nginx/nginx.prod.conf`) over the compose bridge network
  `front`, subnet `172.28.0.0/24` (`networks:` in `docker-compose.prod.yml`). The api service publishes no
  port; only nginx does, on `127.0.0.1:8080` (nginx `ports:` in `docker-compose.prod.yml`) <!-- recheck -->.
- The api reaches its sidecars over plain HTTP on `127.0.0.1` (for example `Settings.llamacpp_host` in
  `apps/api/app/config.py`, and the `listen(PORT, '127.0.0.1')` calls in `tools/adsb-globe-feeder/index.js`,
  `tools/ais-myshiptracking-feeder/index.js` and `tools/browser-fetch/index.js`). Those hops carry a bearer
  token (§1.2), but in clear text <!-- recheck -->.

Reason: both hops stay inside one kernel. An attacker who can read the bridge or loopback traffic already
has root or container-escape access on the host, and can then read `.env` and the data volume directly.
TLS on these hops would add certificate management to every deployment and protect nothing that attacker
cannot already reach. Conditions: the api keeps no published port, and nginx and the api run on the same
host. An operator who splits them across hosts must add TLS (or a WireGuard tunnel) between them. Risk
register entry: R28 in [`isms/risk-assessment.md`](isms/risk-assessment.md).

## 3. Deprecation and post-quantum note

- **Hand-written HS256.** `_signed_claims` (`apps/api/app/auth.py`) re-implements verification that
  PyJWT, already a dependency, provides. It now refuses any header whose `alg` is not `HS256`, so the
  algorithm-confusion path is closed, but a library path would also reject malformed headers by
  construction. Review it at the next ASVS cycle.
- **Symmetric JWTs.** HS256 means every verifier can also mint tokens (the MCP server does, at
  `apps/api/app/mcp_server.py:166-200`). Supabase's asymmetric signing keys (ES256 or RS256 through JWKS)
  remove that property. Parallel work on 2026-09-13 was adding an ES256/RS256 path against the project
  JWKS to `apps/api/app/auth.py` (`_allowed_algs`, `_jwks_key`); when it lands, add the JWKS signing key
  to §1.2 and §2, and prefer it over `SUPABASE_JWT_SECRET` <!-- recheck -->.
- **Fernet.** It uses AES-128-CBC with HMAC-SHA256. It is not deprecated, and 128-bit AES keeps an
  adequate margin against Grover-type quantum search for data at rest. If the project moves to an AEAD
  (AES-256-GCM or ChaCha20-Poly1305), the prepend, re-encrypt, remove procedure in §1.2 carries the
  migration.
- **MD5 and SHA-1** are used only as non-security identifiers (§2). They must never be used for integrity or
  credentials; CodeQL flags new uses (`.github/workflows/codeql.yml`).
- **Post-quantum.** Everything here that a quantum computer threatens is **asymmetric**: TLS key exchange
  and certificates at the operator's proxy, and Ed25519 commit signatures. The symmetric primitives
  (HMAC-SHA256, SHA-256, AES-128) are not broken by Shor's algorithm. Actions: (a) operators should enable
  hybrid post-quantum key exchange (X25519MLKEM768) on their TLS proxy when their proxy supports it, which
  protects captured traffic against later decryption; (b) review commit signing when git and GitHub support
  a post-quantum signature scheme. The project controls neither schedule. This note is reviewed yearly with
  the SoA.
