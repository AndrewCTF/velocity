"""Process logging: one root handler, ISO-8601 UTC timestamps, ``LOG_LEVEL``.

Before this (ASVS V16.3.x, 2026-09-13) nothing configured logging: app
loggers fell through to Python's last-resort handler (WARNING and up, no
timestamp), so ``LOG_LEVEL`` did nothing for them and a security event had no
time on it. uvicorn keeps its own ``uvicorn.*`` handlers.

Security events go to the ``app.security`` / ``app.auth`` loggers as one line of
``key=value`` pairs (``event client=… path=… reason=…``) and never carry a
credential: see ``docs/security/auth-and-sessions.md``. The formatter escapes
control characters in the message, and the httpx/httpcore request loggers are
held at WARNING so an upstream key in a URL never logs.
"""

from __future__ import annotations

import logging
import re
import time

_MARK = "_velocity_root_handler"


# C0 controls, DEL, C1 controls and the Unicode line/paragraph separators. A
# request path or refusal reason carrying ESC sequences or U+2028 could otherwise
# forge the look of a log line in a viewer that honours them (ASVS V16.4.1).
_UNSAFE = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029]")

# Loggers that write a full request URL at INFO. Upstream API keys ride in URL
# paths and queries (FIRMS puts MAP_KEY in the path), so these stay at WARNING
# whatever LOG_LEVEL says (ASVS V16.2.5).
_URL_LOGGERS = ("httpx", "httpcore")


def _escape(text: str) -> str:
    def _sub(m: re.Match[str]) -> str:
        c = ord(m.group())
        return f"\\x{c:02x}" if c <= 0xFF else f"\\u{c:04x}"

    return _UNSAFE.sub(_sub, text)


class _UTCFormatter(logging.Formatter):
    converter = time.gmtime

    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:  # noqa: N802
        ms = int((record.created - int(record.created)) * 1000)
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{ms:03d}Z"

    def formatMessage(self, record: logging.LogRecord) -> str:  # noqa: N802
        # The rendered message only: a traceback (exc_text / stack_info) is
        # appended after this and keeps its real newlines.
        return _escape(super().formatMessage(record))


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
    for name in _URL_LOGGERS:
        lg = logging.getLogger(name)
        if lg.level < logging.WARNING:
            lg.setLevel(logging.WARNING)
