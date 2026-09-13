"""Optional API authentication — static key and/or Supabase login.

Auth is OFF until at least one credential source is configured, so a bare
localhost dev box stays open. It turns ON (and is then ENFORCED on every
non-public route) when either is set:

  * ``API_KEY``  — a static shared secret, supplied via the ``X-API-Key``
    header (or, on a WebSocket upgrade only, the ``key.<credential>``
    subprotocol or ``?key=``; see ``WsSubprotocolMiddleware``). For server/MCP
    callers and CI.
  * Supabase     — ``SUPABASE_JWT_SECRET`` (preferred) or ``SUPABASE_URL`` +
    ``SUPABASE_ANON_KEY``. Callers then present a Supabase **access token** —
    the JWT the browser receives after signing in — via ``Authorization:
    Bearer <jwt>`` (on WS upgrades, which can't set headers, the ``key.<jwt>``
    subprotocol or ``?key=<jwt>``).
    This is "the API key you get from Supabase".

``?key=`` is accepted ONLY on WebSocket upgrades (``require_ws_key``). On an
HTTP request it would land in proxy access logs and browser history, and no
HTTP client of this API needs it (the web app sends headers via ``apiFetch``),
so HTTP ignores it. ``RedactKeyFilter`` scrubs it from uvicorn's access log.

Token validation is LOCAL when it can be: ES256/RS256 against the project JWKS
(SUPABASE_URL set), HS256 when the JWT secret is set; otherwise a call to
GoTrue's ``/auth/v1/user`` with the anon key. A locally verified token is still
re-checked with GoTrue (``_session_live``) when URL + anon key are set. Either
way a successful check is cached per-token until the token's own ``exp``
(capped at 60 s, so a revoked session stops within a minute) and the 1 Hz
ADS-B poll validates at most once a minute, not once per request.

Three credential kinds, and where each is accepted
(``docs/security/auth-and-sessions.md`` has the full table):

  * static ``API_KEY``        — middleware, ``require_api_key``, WS.
  * Supabase user session    — everywhere, and the ONLY kind that resolves a
    user (``keys.current_user``, ``security.principal_for_token``).
  * internal service token   — minted by ``mcp_server`` for its self-hop, with
    ``aud``/``iss`` ``velocity-internal``. Accepted by ``ApiKeyMiddleware`` and
    ``require_api_key`` only: never on a WS, never as a user.

Every path counts failed credentials per client (``failure_limiter``) and
answers 429 with ``Retry-After`` past ``AUTH_FAILURE_LIMIT_PER_MIN``.

Public diag/asset routes (`/api/health`, `/api/config`, `/tiles/*`, the docs)
skip auth because the browser needs them before it can render or before a
session exists.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import time

import httpx
from fastapi import Header, HTTPException, Request, WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from app.config import Settings, get_settings
from app.ratelimit import SlidingWindow, client_key, is_compute_path

log = logging.getLogger("app.auth")

# /docs, /redoc and /openapi.json are NOT public (ASVS V13.4.5): with auth on,
# the full route map needs a credential; a keyless dev box still serves them
# because the middleware passes everything there.
PUBLIC_PATHS = {
    "/api/health", "/api/status", "/api/config",
    "/api/news/edition",  # public Velocity News page — keyless by design
}
# ``/api/ingest/`` is public to the MIDDLEWARE only: an external sender has no
# session, and the per-dataset X-Ingest-Token checked in routes/ingest.py is the
# whole gate there (apps/api/CLAUDE.md, Auth). Before 2026-09-13 it was missing
# here, so an authenticated box 401'd every sender before the token was read.
PUBLIC_PREFIXES = ("/tiles/", "/api/ingest/")


# ── auth-enabled predicate ──────────────────────────────────────────────────


def _auth_enabled(s: Settings) -> bool:
    return bool(
        s.api_key
        or s.supabase_jwt_secret
        or (s.supabase_url and s.supabase_anon_key)
    )


def log_auth_mode(s: Settings) -> None:
    """Emit a clear one-line startup banner describing the auth posture so an
    operator can never be surprised that a box is serving unauthenticated
    (issue #8). Called once from the app lifespan."""
    log = logging.getLogger("app.auth")
    if _auth_enabled(s):
        log.info("auth ENABLED — non-public routes require a credential")
    elif s.allow_unauthenticated:
        log.warning(
            "auth DISABLED and ALLOW_UNAUTHENTICATED=1 — ALL routes (including "
            "LLM/recon/OSINT compute) are served with NO authentication. Use only "
            "on a trusted local box; set API_KEY or Supabase for any exposed deploy."
        )
    else:
        log.warning(
            "auth DISABLED — keyless data layers are open; cost/compute endpoints "
            "(LLM, recon, OSINT, imagery-detect) FAIL CLOSED (503). Set API_KEY / "
            "Supabase to enable auth, or ALLOW_UNAUTHENTICATED=1 for trusted local use."
        )


# ── JWT helpers (HS256, matches the Supabase legacy signing scheme) ──────────

# The internal service token (mcp_server self-hop). A distinct audience AND
# issuer, so it can never satisfy the user-session check, and a Supabase token
# can never satisfy this one; PostgREST also refuses it (its role is not a
# database role), so it opens this API's middleware and nothing else.
INTERNAL_AUDIENCE = "velocity-internal"
INTERNAL_ISSUER = "velocity-internal"
INTERNAL_MAX_LIFETIME_S = 3600

# Shortest secrets accepted at startup. 32 characters of a random key is ~190
# bits from a base64 alphabet; GoTrue itself refuses a JWT secret under 32.
MIN_API_KEY_LEN = 32
MIN_JWT_SECRET_LEN = 32

# How long a positive validation is trusted before the token is checked again.
TOKEN_CACHE_TTL_S = 60.0


def _b64url_decode(seg: str) -> bytes:
    return base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))


def _jwt_claims(token: str) -> dict | None:
    try:
        _, payload, _ = token.split(".")
        return json.loads(_b64url_decode(payload))
    except Exception:  # noqa: BLE001 — malformed token → no claims
        return None


def expected_issuer(s: Settings) -> str:
    """The ``iss`` a Supabase session from THIS project carries, or "" when the
    deployment has no URL to derive it from (JWT-secret-only)."""
    if s.supabase_jwt_issuer:
        return s.supabase_jwt_issuer
    return (s.supabase_url.rstrip("/") + "/auth/v1") if s.supabase_url else ""


def _signed_claims(token: str, secret: str) -> dict | None:
    """Claims of a token whose header says HS256 and whose HMAC-SHA256 signature
    verifies under ``secret``; None otherwise. The header is checked, not just
    the signature: a token labelled RS256 (or none) is refused even when an HMAC
    over it happens to verify, so no algorithm-confusion path exists."""
    try:
        header, payload, sig = token.split(".")
        head = json.loads(_b64url_decode(header))
        if not isinstance(head, dict) or head.get("alg") != "HS256":
            return None
        if head.get("typ", "JWT") != "JWT":
            return None
        expected = hmac.new(
            secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256
        ).digest()
        if not hmac.compare_digest(_b64url_decode(sig), expected):
            return None
        claims = json.loads(_b64url_decode(payload))
        return claims if isinstance(claims, dict) else None
    except Exception:  # noqa: BLE001 — malformed/short token
        return None


def _times_ok(claims: dict, max_lifetime_s: float) -> bool:
    """exp REQUIRED and in the future; nbf, when present, in the past; the
    token's lifetime (exp - iat, or exp - now without iat) within the cap."""
    try:
        now = time.time()
        exp = claims.get("exp")
        if exp is None or isinstance(exp, bool) or float(exp) <= now:
            return False
        nbf = claims.get("nbf")
        if nbf is not None and float(nbf) > now:
            return False
        iat = claims.get("iat")
        start = float(iat) if iat is not None else now
        return float(exp) - start <= max_lifetime_s
    except (TypeError, ValueError):
        return False


def _aud_has(claims: dict, value: str) -> bool:
    aud = claims.get("aud")
    return aud == value or (isinstance(aud, list) and value in aud)


def _signed_in_at(claims: dict) -> float | None:
    """When the user actually authenticated: the earliest ``amr[].timestamp``
    (Supabase keeps it across refreshes, unlike ``iat``). None when absent."""
    amr = claims.get("amr")
    stamps: list[float] = []
    if isinstance(amr, list):
        for entry in amr:
            ts = entry.get("timestamp") if isinstance(entry, dict) else None
            if isinstance(ts, int | float) and not isinstance(ts, bool):
                stamps.append(float(ts))
    return min(stamps) if stamps else None


def _user_claims_ok(
    claims: dict,
    *,
    issuer: str = "",
    max_lifetime_s: float = 86_400,
    session_max_age_s: float = 0,
    require_aal2: bool = False,
) -> bool:
    """The claim rules every USER session obeys, whichever path verified it."""
    if not _times_ok(claims, max_lifetime_s):
        return False
    if session_max_age_s > 0:
        # Absolute session lifetime (V7.3.2): refreshes renew iat, not this.
        signed_in = _signed_in_at(claims)
        if signed_in is None or time.time() - signed_in > session_max_age_s:
            return False
    if require_aal2 and claims.get("aal") != "aal2":
        return False
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        return False
    # Supabase session tokens carry aud "authenticated" (string or list).
    if not _aud_has(claims, "authenticated") or _aud_has(claims, INTERNAL_AUDIENCE):
        return False
    if issuer and claims.get("iss") != issuer:
        return False
    # Only a signed-in USER session passes. The public anon key is a validly
    # signed JWT too (role "anon") — without this it would be accepted as a
    # credential, which it must not be. Service-role tokens are server
    # secrets, not browser sessions, so they're excluded as well.
    return claims.get("role") == "authenticated"


def _verify_hs256(token: str, secret: str, **rules: object) -> bool:
    """A Supabase USER session signed with the project secret. ``rules`` are
    ``_user_claims_ok``'s keyword arguments (issuer, max_lifetime_s, …)."""
    claims = _signed_claims(token, secret)
    return claims is not None and _user_claims_ok(claims, **rules)  # type: ignore[arg-type]


def _verify_internal(token: str, secret: str) -> bool:
    """The backend's own service token (``mcp_server._mint_internal_jwt``)."""
    claims = _signed_claims(token, secret)
    if claims is None or not _times_ok(claims, INTERNAL_MAX_LIFETIME_S):
        return False
    return claims.get("aud") == INTERNAL_AUDIENCE and claims.get("iss") == INTERNAL_ISSUER


def check_credential_strength(s: Settings) -> None:
    """Refuse to boot with a guessable static secret (ASVS V6.3.1 / V11.2.3).
    Called from the lifespan, so a misconfigured deploy fails at start, loudly,
    rather than serving behind a short key."""
    if s.api_key and len(s.api_key) < MIN_API_KEY_LEN:
        raise RuntimeError(
            f"API_KEY is {len(s.api_key)} characters; at least {MIN_API_KEY_LEN} are "
            "required. Generate one with: python -c 'import secrets; "
            "print(secrets.token_urlsafe(32))'"
        )
    if s.supabase_jwt_secret and len(s.supabase_jwt_secret) < MIN_JWT_SECRET_LEN:
        raise RuntimeError(
            f"SUPABASE_JWT_SECRET is {len(s.supabase_jwt_secret)} characters; at least "
            f"{MIN_JWT_SECRET_LEN} are required (copy it from Supabase > Settings > API)"
        )


# ── failed-credential throttle (V6.3.1) ─────────────────────────────────────

_failures = SlidingWindow()


def failure_limiter() -> SlidingWindow:
    return _failures


def _locked(key: str, s: Settings) -> int | None:
    lim = s.auth_failure_limit_per_min
    return _failures.retry_after(key, limit=lim) if lim > 0 else None


def credential_kind(credential: str | None) -> str:
    """What sort of credential was presented, by shape only (never its value):
    a three-segment JWT is a ``session`` attempt, anything else ``static``."""
    if not credential:
        return "none"
    return "session" if credential.count(".") == 2 else "static"


def record_auth_failure(
    key: str, s: Settings, reason: str, path: str = "", kind: str = ""
) -> None:
    """Count one failed credential for ``key`` and log it (never the credential)."""
    if s.auth_failure_limit_per_min > 0:
        _failures.record(key, limit=s.auth_failure_limit_per_min)
    log.warning(
        "auth failure client=%s path=%s reason=%s kind=%s", key, path, reason, kind or "-"
    )


# ── per-token validation cache ───────────────────────────────────────────────

_token_ok_until: dict[str, float] = {}  # user token -> wall-clock expiry
_internal_ok_until: dict[str, float] = {}  # internal token -> wall-clock expiry
_live_until: dict[str, float] = {}  # user token -> expiry of a GoTrue "active"
# client -> wall-clock time its static-key success was last logged. The static
# key has no validation cache, and the 1 Hz ADS-B poll must not log every second.
_static_logged_at: dict[str, float] = {}
# JWKS url -> (expiry, {kid: jwk}); and when a refetch for an unknown kid last ran.
_jwks_cache: dict[str, tuple[float, dict[str, dict]]] = {}
_jwks_refetched_at: dict[str, float] = {}
JWKS_TTL_S = 600.0
JWKS_REFETCH_MIN_S = 30.0


def reset_state() -> None:
    """Drop cached validations and failure counts (tests; also safe at runtime)."""
    _token_ok_until.clear()
    _internal_ok_until.clear()
    _live_until.clear()
    _static_logged_at.clear()
    _jwks_cache.clear()
    _jwks_refetched_at.clear()
    _failures.clear()


def _bounded_put(d: dict[str, float], key: str, until: float, cap: int, now: float) -> None:
    d[key] = until
    if len(d) > cap:  # bound: drop already-expired entries
        for k in [k for k, v in d.items() if v <= now]:
            d.pop(k, None)


async def _gotrue_user(token: str, s: Settings) -> tuple[int, dict]:
    """GoTrue's ``/auth/v1/user`` for this token: (status, body). (0, {}) when
    GoTrue is unreachable, which every caller treats as a refusal."""
    url = s.supabase_url.rstrip("/") + "/auth/v1/user"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(8.0, connect=5.0),
            # IPv4-pinned: some egress hosts publish broken AAAA (see app.llm).
            transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=1),
        ) as c:
            r = await c.get(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": s.supabase_anon_key,
                },
            )
        try:
            body = r.json() if r.status_code == 200 else {}
        except ValueError:
            body = {}
        return r.status_code, body if isinstance(body, dict) else {}
    except Exception:  # noqa: BLE001 — upstream down → deny (fail closed)
        return 0, {}


async def _gotrue_status(token: str, s: Settings) -> int:
    return (await _gotrue_user(token, s))[0]


def _banned(body: dict) -> bool:
    raw = body.get("banned_until")
    if not raw:
        return False
    try:
        from datetime import UTC, datetime  # noqa: PLC0415

        until = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        return until > datetime.now(UTC)
    except ValueError:
        return True  # unparseable ban marker: treat as banned (fail closed)


async def _session_live(token: str, s: Settings) -> bool:
    """Is the session behind a locally verified token still active in GoTrue
    (not signed out, banned or deleted)? Cached per token for at most 60 s.

    Applies to EVERY user validation, not only operator routes (ASVS V7.4.1 /
    V7.4.2): a signature proves the token was issued, not that the session still
    exists. Fails closed when GoTrue is unreachable. A JWT-secret-only deployment
    has no GoTrue URL, so there the token's own ``exp`` (<= JWT_MAX_LIFETIME_S)
    is the only revocation: a documented residual in
    docs/security/auth-and-sessions.md. The test conftest stubs this hook."""
    if not (s.session_liveness_check and s.supabase_url and s.supabase_anon_key):
        return True
    now = time.time()
    hit = _live_until.get(token)
    if hit and hit > now:
        return True
    status, body = await _gotrue_user(token, s)
    ok = status == 200 and not _banned(body)
    if ok:
        _bounded_put(_live_until, token, now + TOKEN_CACHE_TTL_S, 4096, now)
    else:
        _live_until.pop(token, None)
    return ok


# ── asymmetric session tokens (ES256 / RS256 via the project JWKS) ───────────

_ASYMMETRIC = {"ES256": "EC", "RS256": "RSA"}


def _allowed_algs(s: Settings) -> set[str]:
    return {a.strip().upper() for a in s.supabase_jwt_algorithms.split(",") if a.strip()}


def _jwt_header(token: str) -> dict:
    try:
        head = json.loads(_b64url_decode(token.split(".")[0]))
        return head if isinstance(head, dict) else {}
    except Exception:  # noqa: BLE001 — malformed token
        return {}


def jwks_url(s: Settings) -> str:
    return (s.supabase_url.rstrip("/") + "/auth/v1/.well-known/jwks.json") if s.supabase_url else ""


async def _fetch_jwks(url: str) -> dict | None:
    """The JWKS document, or None when unreachable. IPv4-pinned like GoTrue."""
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(8.0, connect=5.0),
            transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=1),
        ) as c:
            r = await c.get(url)
        if r.status_code != 200:
            return None
        body = r.json()
        return body if isinstance(body, dict) else None
    except Exception:  # noqa: BLE001 — JWKS down → no key → refuse (fail closed)
        return None


async def _jwks_key(kid: str, s: Settings) -> dict | None:
    url = jwks_url(s)
    now = time.time()
    hit = _jwks_cache.get(url)
    keys = hit[1] if hit and hit[0] > now else None
    # Unknown kid: the project may have rotated; refetch, but not on every
    # forged kid (at most once per JWKS_REFETCH_MIN_S).
    stale = keys is None or (
        kid not in keys and now - _jwks_refetched_at.get(url, 0.0) >= JWKS_REFETCH_MIN_S
    )
    if stale:
        _jwks_refetched_at[url] = now
        doc = await _fetch_jwks(url)
        if doc is not None:
            keys = {
                str(k["kid"]): k
                for k in doc.get("keys", [])
                if isinstance(k, dict) and k.get("kid")
            }
            _jwks_cache[url] = (now + JWKS_TTL_S, keys)
    return (keys or {}).get(kid)


async def _verify_jwks(token: str, alg: str, s: Settings) -> dict | None:
    """Claims of an ES256/RS256 token signed by a key in the project JWKS, or
    None. The key's type must match the header ``alg`` and PyJWT is told that
    one algorithm only, so neither the HS256 secret nor a public key can be
    used under the other scheme (no algorithm confusion). Claim rules are
    applied by the caller, in one place."""
    kid = _jwt_header(token).get("kid")
    if not isinstance(kid, str) or not kid:
        return None
    jwk = await _jwks_key(kid, s)
    if jwk is None or jwk.get("kty") != _ASYMMETRIC[alg]:
        return None
    if jwk.get("alg") not in (None, alg) or jwk.get("use") not in (None, "sig"):
        return None
    try:
        import jwt  # noqa: PLC0415 — pyjwt, a declared dependency

        key = jwt.PyJWK(jwk, algorithm=alg).key
        claims = jwt.decode(
            token,
            key=key,
            algorithms=[alg],
            options={
                "verify_signature": True,
                "verify_exp": False,
                "verify_nbf": False,
                "verify_iat": False,
                "verify_aud": False,
                "verify_iss": False,
            },
        )
    except Exception:  # noqa: BLE001 — bad signature / malformed key or token
        return None
    return claims if isinstance(claims, dict) else None


async def _valid_supabase_token(token: str, s: Settings) -> bool:
    """True for a valid Supabase USER session. Never true for the internal token.

    Signature, by header ``alg`` (each must be in SUPABASE_JWT_ALGORITHMS):
    ES256/RS256 against the project JWKS when SUPABASE_URL is set; HS256 with the
    project secret; with neither, GoTrue vouches. Then the shared claim rules,
    then (local verification only) the GoTrue liveness check."""
    if not token:
        return False
    now = time.time()
    cached = _token_ok_until.get(token)
    if cached and cached > now:
        return True

    issuer = expected_issuer(s)
    rules = {
        "issuer": issuer,
        "max_lifetime_s": s.jwt_max_lifetime_s,
        "session_max_age_s": s.session_max_age_s,
        "require_aal2": s.require_mfa_all_users,
    }
    allowed = _allowed_algs(s)
    alg = str(_jwt_header(token).get("alg") or "")
    if alg in _ASYMMETRIC and s.supabase_url:
        if alg not in allowed:
            return False
        claims = await _verify_jwks(token, alg, s)
        ok = (
            claims is not None
            and _user_claims_ok(claims, **rules)
            and await _session_live(token, s)
        )
    elif s.supabase_jwt_secret:
        ok = (
            "HS256" in allowed
            and _verify_hs256(token, s.supabase_jwt_secret, **rules)
            and await _session_live(token, s)
        )
    elif s.supabase_url and s.supabase_anon_key:
        # GoTrue vouches for the signature and the session; the claim rules are
        # still ours to apply (a 200 alone said nothing about role or audience).
        claims = _jwt_claims(token)
        ok = (
            claims is not None
            and _user_claims_ok(claims, **rules)
            and await _gotrue_status(token, s) == 200
        )
    else:
        return False

    if ok:
        exp = (_jwt_claims(token) or {}).get("exp")
        _bounded_put(_token_ok_until, token, min(now + TOKEN_CACHE_TTL_S, float(exp)), 4096, now)
    return ok


def _valid_internal_token(token: str, s: Settings) -> bool:
    if not token or not s.supabase_jwt_secret:
        return False
    now = time.time()
    cached = _internal_ok_until.get(token)
    if cached and cached > now:
        return True
    if not _verify_internal(token, s.supabase_jwt_secret):
        return False
    exp = (_jwt_claims(token) or {}).get("exp")
    _internal_ok_until[token] = min(now + TOKEN_CACHE_TTL_S, float(exp))
    if len(_internal_ok_until) > 256:
        for k in [k for k, v in _internal_ok_until.items() if v <= now]:
            _internal_ok_until.pop(k, None)
    return True


def _bearer(headers) -> str | None:  # type: ignore[no-untyped-def]
    h = headers.get("authorization") or headers.get("Authorization") or ""
    return h[7:] if h.lower().startswith("bearer ") else None


async def _authorized(
    static_supplied: str | None,
    token: str | None,
    s: Settings,
    *,
    allow_internal: bool = True,
    who: str = "",
    path: str = "",
) -> bool:
    """True if the static key matches, the token is a valid user session, or
    (HTTP only) it is the backend's internal service token.

    A success is logged once per validation-cache miss with the credential kind
    and never the credential (ASVS V16.3.1); the static key, which has no cache,
    at most once a minute per client. ``who``/``path`` only feed that line."""
    now = time.time()
    if s.api_key and secrets.compare_digest(static_supplied or "", s.api_key):
        if now - _static_logged_at.get(who, 0.0) >= TOKEN_CACHE_TTL_S:
            _bounded_put(_static_logged_at, who, now, 4096, now - TOKEN_CACHE_TTL_S)
            log.info("auth success client=%s path=%s kind=static", who, path)
        return True
    tok = token or ""
    if allow_internal and tok:
        miss = _internal_ok_until.get(tok, 0.0) <= now
        if _valid_internal_token(tok, s):
            if miss:
                log.info("auth success client=%s path=%s kind=internal", who, path)
            return True
    miss = _token_ok_until.get(tok, 0.0) <= now
    ok = await _valid_supabase_token(tok, s)
    if ok and miss:
        sub = (_jwt_claims(tok) or {}).get("sub")
        log.info("auth success client=%s path=%s kind=session sub=%s", who, path, sub)
    return ok


def _too_many(retry: int) -> JSONResponse:
    return JSONResponse(
        {"detail": "too many failed credentials from this client; retry later"},
        status_code=429,
        headers={"Retry-After": str(retry)},
    )


# ── middleware + dependencies ────────────────────────────────────────────────


class ApiKeyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:  # type: ignore[no-untyped-def]
        s = get_settings()
        path = request.url.path
        if not _auth_enabled(s):
            # Fail CLOSED for the agent endpoint: the backend origin is publicly
            # resolvable, so /mcp must NEVER be served on a deployment that has
            # no credential configured (set API_KEY and/or Supabase).
            if path == "/mcp" or path.startswith("/mcp/"):
                return JSONResponse(
                    {"detail": "mcp endpoint requires authentication to be configured"},
                    status_code=503,
                )
            # Fail CLOSED for the COST/COMPUTE endpoints too (issue #8): they
            # spend hosted-LLM credits and GPU/CPU time, so an unconfigured box
            # must not serve them to anonymous callers unless the operator has
            # explicitly opted into open mode (ALLOW_UNAUTHENTICATED=1) on a
            # trusted local/dev box. The cheap keyless DATA layers stay open, so
            # the keyless product invariant is preserved.
            if not s.allow_unauthenticated and (
                is_compute_path(path) or path == "/tiler" or path.startswith("/tiler/")
            ):
                return JSONResponse(
                    {"detail": "this endpoint spends compute/credits and is disabled "
                               "on an unauthenticated deployment; configure API_KEY / "
                               "Supabase, or set ALLOW_UNAUTHENTICATED=1 for trusted local use"},
                    status_code=503,
                )
            # Every other (cheap, keyless) route stays open on an unconfigured box.
            return await call_next(request)
        if path in PUBLIC_PATHS or any(path.startswith(p) for p in PUBLIC_PREFIXES):
            return await call_next(request)
        # HTTP only (BaseHTTPMiddleware never sees a WS scope): headers, never
        # ?key=. The Supabase token may be a Bearer header or in X-API-Key.
        static_supplied = request.headers.get("x-api-key")
        token = _bearer(request.headers) or static_supplied
        # Return a response directly: an HTTPException raised inside a
        # BaseHTTPMiddleware is NOT seen by FastAPI's exception handlers
        # (they sit deeper in the ASGI stack), so it would surface as a 500.
        who = client_key(request.client.host if request.client else "", request.headers)
        # Checked BEFORE the credential, so a locked-out client cannot tell a
        # right guess from a wrong one.
        retry = _locked(who, s)
        if retry is not None:
            log.warning("auth lockout client=%s path=%s reason=too-many-failures", who, path)
            return _too_many(retry)
        if not await _authorized(static_supplied, token, s, who=who, path=path):
            if token:
                record_auth_failure(who, s, "bad-credential", path, credential_kind(token))
            else:
                log.warning("auth failure client=%s path=%s reason=no-credential", who, path)
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)


# ── WebSocket credential (ASVS V14.2.1) ─────────────────────────────────────
#
# A browser cannot set headers on a WebSocket upgrade, so the credential used to
# ride in ``?key=``, where the operator's TLS proxy logs it. The scheme now:
#
#   client:  new WebSocket(url, ["velocity.v1", "key." + credential])
#   request: Sec-WebSocket-Protocol: velocity.v1, key.<credential>
#   server:  accepts with Sec-WebSocket-Protocol: velocity.v1   (never the key)
#
# ``<credential>`` is the Supabase access token or the static API key, verbatim
# (both are RFC 7230 token characters; a static key that is not cannot use this
# carrier). Precedence: Authorization / X-API-Key header, then the ``key.``
# subprotocol, then ``?key=`` (kept for older clients).

WS_PROTOCOL = "velocity.v1"
WS_KEY_PREFIX = "key."


def _subprotocol_credential(headers) -> str | None:  # type: ignore[no-untyped-def]
    raw = (headers.get("sec-websocket-protocol") or "") if headers is not None else ""
    for item in raw.split(","):
        item = item.strip()
        if item.startswith(WS_KEY_PREFIX) and len(item) > len(WS_KEY_PREFIX):
            return item[len(WS_KEY_PREFIX):]
    return None


def ws_credential(ws) -> str | None:  # type: ignore[no-untyped-def]
    """The credential a WS upgrade presented, by the precedence above. Routes
    that resolve a user from the socket should call this."""
    return (
        _bearer(ws.headers)
        or ws.headers.get("x-api-key")
        or _subprotocol_credential(ws.headers)
        or ws.query_params.get("key")
    )


class WsSubprotocolMiddleware:
    """Pure ASGI. For a WS upgrade offering ``velocity.v1``: (1) a browser fails
    the handshake unless the server selects an offered subprotocol, and the
    routes call a bare ``ws.accept()``, so select ``velocity.v1`` on the accept
    message; (2) copy a ``key.<credential>`` entry into ``Authorization`` when
    none was sent, so routes reading ``_bearer(ws.headers)`` resolve the same
    user ``require_ws_key`` authorized. The ``key.`` entry is never echoed."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):  # type: ignore[no-untyped-def]
        if scope.get("type") != "websocket" or WS_PROTOCOL not in (scope.get("subprotocols") or []):
            await self.app(scope, receive, send)
            return
        headers = list(scope.get("headers") or [])
        names = {k.lower() for k, _ in headers}
        cred = next(
            (p[len(WS_KEY_PREFIX):] for p in scope["subprotocols"] if p.startswith(WS_KEY_PREFIX)),
            "",
        )
        if cred and b"authorization" not in names and b"x-api-key" not in names:
            headers.append((b"authorization", f"Bearer {cred}".encode("latin-1", "replace")))
            scope = {**scope, "headers": headers}

        async def _send(message):  # type: ignore[no-untyped-def]
            if message.get("type") == "websocket.accept" and not message.get("subprotocol"):
                message = {**message, "subprotocol": WS_PROTOCOL}
            await send(message)

        await self.app(scope, receive, _send)


async def require_ws_key(ws: WebSocket) -> bool:
    """For WS routes: check the credential before accept(). True if allowed."""
    s = get_settings()
    if not _auth_enabled(s):
        return True
    static_supplied = (
        ws.headers.get("x-api-key")
        or _subprotocol_credential(ws.headers)
        or ws.query_params.get("key")
    )
    token = ws_credential(ws)
    client = getattr(ws, "client", None)
    who = client_key(client.host if client else "", ws.headers)
    path = getattr(getattr(ws, "url", None), "path", "") or ""
    if _locked(who, s) is not None:
        log.warning("auth lockout client=%s path=%s reason=too-many-failures", who, path)
        return False
    # No internal token here: the MCP self-hop is HTTP, and a WS is a user's.
    if await _authorized(static_supplied, token, s, allow_internal=False, who=who, path=path):
        return True
    if token:
        record_auth_failure(who, s, "bad-credential", path, credential_kind(token))
    return False


async def require_compute_enabled() -> None:
    """FastAPI dependency for a single POST route that must fail closed the
    same way ``ApiKeyMiddleware``'s compute-path gate does (issue #8), without
    listing the route in ``is_compute_path`` — used when a GET sibling on the
    same path must stay open (e.g. ``POST /api/ai/local`` gains write
    authority over the local engine/selection-model, but ``GET /api/ai/local``
    is a pure keyless status probe the settings UI polls). When auth is
    enabled, ``ApiKeyMiddleware`` already enforces a credential on this route;
    when ``ALLOW_UNAUTHENTICATED=1``, the operator opted into open mode — both
    cases pass through here unchanged."""
    s = get_settings()
    if not _auth_enabled(s) and not s.allow_unauthenticated:
        raise HTTPException(
            status_code=503,
            detail="this endpoint spends compute/credits and is disabled "
                   "on an unauthenticated deployment; configure API_KEY / "
                   "Supabase, or set ALLOW_UNAUTHENTICATED=1 for trusted local use",
        )


async def require_api_key(
    request: Request,
    x_api_key: str | None = Header(default=None),
) -> None:
    """Optional FastAPI Depends() form for individual routes (static or token)."""
    s = get_settings()
    if not _auth_enabled(s):
        return
    token = _bearer(request.headers) or x_api_key
    who = client_key(request.client.host if request.client else "", request.headers)
    retry = _locked(who, s)
    if retry is not None:
        raise HTTPException(
            status_code=429,
            detail="too many failed credentials from this client; retry later",
            headers={"Retry-After": str(retry)},
        )
    path = getattr(getattr(request, "url", None), "path", "")
    if not await _authorized(x_api_key, token, s, who=who, path=path):
        if token:
            record_auth_failure(who, s, "bad-credential", path, credential_kind(token))
        raise HTTPException(status_code=401, detail="unauthorized")


class RedactKeyFilter(logging.Filter):
    """Scrub credential-named query values (``key=``, ``token=``, ``apikey=``,
    ``map_key=``, …) from access-log records (uvicorn passes the request
    path+query as a positional log arg)."""

    _RE = re.compile(
        r"([?&](?:key|token|access_token|api_key|apikey|map_key|secret)=)[^&\s\"]*",
        re.IGNORECASE,
    )

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                self._RE.sub(r"\1[redacted]", a) if isinstance(a, str) else a
                for a in record.args
            )
        if isinstance(record.msg, str):
            record.msg = self._RE.sub(r"\1[redacted]", record.msg)
        return True


def install_access_log_redaction() -> None:
    # HTTP requests log on uvicorn.access; the WS handshake line (the path that
    # really carries ?key=) logs on uvicorn.error. Logger filters do not inherit.
    for name in ("uvicorn.access", "uvicorn.error"):
        lg = logging.getLogger(name)
        if not any(isinstance(f, RedactKeyFilter) for f in lg.filters):
            lg.addFilter(RedactKeyFilter())

