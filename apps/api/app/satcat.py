"""CelesTrak SATCAT — NORAD catalog metadata (owner, launch, RCS, ops status).

Keyless. https://celestrak.org/pub/satcat.csv (~69.8k rows, one row per
tracked object). CelesTrak 403-rate-limits bursts (see
``docs/decisions.md#celestrak``), so this is a single TtlCache-gated pull —
24h TTL, lazy on first request (never fetched at import time; also never
fetched when ``OSINT_DISABLE_BACKGROUND`` is set, so the unit test suite
never touches the network — tests monkeypatch ``get_client`` instead).

Columns (CelesTrak CSV header, 2026-07):
OBJECT_NAME, OBJECT_ID, NORAD_CAT_ID, OBJECT_TYPE, OPS_STATUS_CODE, OWNER,
LAUNCH_DATE, LAUNCH_SITE, DECAY_DATE, PERIOD, INCLINATION, APOGEE, PERIGEE,
RCS, DATA_STATUS_CODE, ORBIT_CENTER, ORBIT_TYPE.
"""

from __future__ import annotations

import csv
import io
from typing import Any

from app.upstream import cache, get_client

SATCAT_URL = "https://celestrak.org/pub/satcat.csv"
SATCAT_TTL_SEC = 24 * 3600.0
_CACHE_KEY = "satcat:rows"


def _parse_csv(text: str) -> dict[str, dict[str, Any]]:
    """CSV text -> {NORAD_CAT_ID (str): row dict}. Never raises on malformed
    input — an unparseable body just yields an empty catalog (route degrades
    to 'no SATCAT row for this object', not a 500)."""
    out: dict[str, dict[str, Any]] = {}
    try:
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            norad = str(row.get("NORAD_CAT_ID") or "").strip()
            if not norad:
                continue
            out[norad] = dict(row)
    except csv.Error:
        return {}
    return out


async def _load() -> dict[str, dict[str, Any]]:
    try:
        r = await get_client().get(SATCAT_URL)
    except Exception:  # noqa: BLE001 — upstream down/slow must not raise
        return {}
    if r.status_code != 200:
        return {}
    return _parse_csv(r.text)


async def satcat() -> dict[str, dict[str, Any]]:
    """The full SATCAT, keyed by NORAD_CAT_ID (string). Fetched once per 24h
    TTL window; a failed fetch caches an empty dict for the TTL rather than
    hammering CelesTrak on every request (its own rate-limit protection)."""
    return await cache.get_or_fetch(_CACHE_KEY, SATCAT_TTL_SEC, _load)


async def satcat_row(norad_id: str) -> dict[str, Any] | None:
    """One object's SATCAT row by NORAD catalog number, or None if unknown."""
    rows = await satcat()
    return rows.get(str(norad_id).strip())
