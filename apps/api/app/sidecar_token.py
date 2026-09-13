"""Per-spawn bearer tokens for the loopback browser sidecars (ASVS V13.2.1).

The ADS-B feeder (:8090), the AIS feeders (:8091-8093) and browser-fetch (:8095)
bind 127.0.0.1 and used to answer any local caller. browser-fetch is a general
real-Chrome fetch proxy, so any process on the box, or a DNS-rebinding page in a
desktop browser, could drive it. Each spawn now mints ``secrets.token_urlsafe(32)``
(the llama.cpp sidecar's pattern), hands it to the child as ``SIDECAR_TOKEN``, and
the API sends ``Authorization: Bearer`` on every data request. ``/health`` stays
open: supervision's liveness probe must work whoever holds the token.

The complication llama.cpp does not have: these sidecars are REUSED across
backend restarts (a Cloudflare clear costs 20-60 s, see apps/api/CLAUDE.md,
sidecar supervision), and a sidecar spawned by the previous API process holds
the previous token. So the token is also written to a 0600 file under the data
dir; a restart reads it back and keeps using the adopted sidecar. If the file is
gone, or the running sidecar predates token enforcement (see :func:`mismatch`),
the spawner evicts it and spawns one that knows a token we hold — a one-off
Cloudflare clear on the first boot after an upgrade, not a storm: a respawned
sidecar holds the token on file, so the next restart adopts it again.
"""

from __future__ import annotations

import contextlib
import logging
import os
import secrets
from pathlib import Path

import httpx

log = logging.getLogger("sidecar_token")

_CACHE: dict[str, str] = {}


def token_dir() -> Path:
    """``SIDECAR_TOKEN_DIR`` or ``<history_db_path dir>/sidecar-tokens``."""
    override = os.getenv("SIDECAR_TOKEN_DIR", "").strip()
    if override:
        return Path(override)
    from app.config import get_settings  # noqa: PLC0415

    return Path(get_settings().history_db_path).resolve().parent / "sidecar-tokens"


def _path(name: str) -> Path:
    return token_dir() / f"{name}.token"


def mint(name: str) -> str:
    """New token for a sidecar about to be spawned; persisted 0600, best-effort."""
    token = secrets.token_urlsafe(32)
    _CACHE[name] = token
    path = _path(name)
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{secrets.token_hex(4)}.partial")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(token)
        tmp.replace(path)
    except OSError as e:
        # Without the file a restart cannot adopt this sidecar and respawns it
        # instead — slower, never insecure.
        log.warning("could not persist sidecar token for %s: %s", name, e)
    return token


def current(name: str) -> str | None:
    """Token for ``name``: this process's, else the one a previous process wrote."""
    tok = _CACHE.get(name)
    if tok:
        return tok
    try:
        tok = _path(name).read_text().strip()
    except OSError:
        return None
    if tok:
        _CACHE[name] = tok
    return tok or None


def forget(name: str) -> None:
    _CACHE.pop(name, None)
    with contextlib.suppress(OSError):
        _path(name).unlink()


def headers(name: str) -> dict[str, str]:
    tok = current(name)
    return {"Authorization": f"Bearer {tok}"} if tok else {}


async def mismatch(base: str, name: str) -> bool:
    """Is there CONCRETE evidence the sidecar on ``base`` cannot be driven with our token?

    True when ``/auth`` answers 404 (a sidecar from before enforcement, still open
    to every local caller), or 401 to our token (a token we do not hold), or 401
    to a bare request while we hold no token at all. Anything else, including an
    unreachable port, is not evidence: liveness is decided by the caller's own
    probes, and a respawn must never be triggered by a flaky read here.
    """
    tok = current(name)
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            if tok is None:
                r = await c.get(f"{base}/auth")
                return r.status_code in (401, 404)
            r = await c.get(f"{base}/auth", headers={"Authorization": f"Bearer {tok}"})
            return r.status_code in (401, 404)
    except Exception:  # noqa: BLE001 — not answering is not a mismatch
        return False
