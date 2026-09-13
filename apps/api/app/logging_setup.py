"""Process logging: one root handler, ISO-8601 UTC timestamps, ``LOG_LEVEL``.

Before this (ASVS V16.3.x, 2026-09-13) nothing configured logging: app
loggers fell through to Python's last-resort handler (WARNING and up, no
timestamp), so ``LOG_LEVEL`` did nothing for them and a security event had no
time on it. uvicorn keeps its own ``uvicorn.*`` handlers.

Security events go to the ``app.security`` / ``app.auth`` loggers as one line of
``key=value`` pairs (``event client=… path=… reason=…``) and never carry a
credential: see ``docs/security/auth-and-sessions.md``.
"""

from __future__ import annotations

import logging
import time

_MARK = "_velocity_root_handler"


class _UTCFormatter(logging.Formatter):
    converter = time.gmtime

    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:  # noqa: N802
        ms = int((record.created - int(record.created)) * 1000)
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{ms:03d}Z"


def build_formatter() -> logging.Formatter:
    return _UTCFormatter("%(asctime)s %(levelname)s %(name)s %(message)s")


def level_for(name: str) -> int:
    lvl = logging.getLevelName(str(name or "").upper())
    return lvl if isinstance(lvl, int) else logging.INFO


def configure(log_level: str) -> None:
    """Idempotent: installs the root handler once, then only moves the level."""
    root = logging.getLogger()
    if not any(getattr(h, _MARK, False) for h in root.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(build_formatter())
        setattr(handler, _MARK, True)
        root.addHandler(handler)
    root.setLevel(level_for(log_level))
