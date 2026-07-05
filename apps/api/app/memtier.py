"""Memory-tier policy: size caches to currently-available RAM.

A single, keyless authority the disk-backed / bounded caches consult so the
platform keeps more in RAM on a big box and spills to disk on a small one —
instead of every cache hard-coding a static byte cap.

Governs bounded / disk caches only (tilecache, history retention, and the new
detection caches). It deliberately does NOT touch the live ADS-B snapshot,
``_HOT_BLOB``, or the motion pipeline — those are guarded perf paths whose sizes
are dictated by feed coverage, not by a memory budget.

Linux-only source (``/proc/meminfo``); stdlib only, no psutil dependency. On any
other platform or an unreadable file it degrades to a conservative constant so
callers still get a sane cap.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)

# ponytail: /proc/meminfo covers the Linux deploy target; add psutil only if this
# must ever run off-Linux. Until then a fixed fallback keeps CI / non-Linux sane.
_FALLBACK_AVAILABLE = 2 * 1024**3  # 2 GiB — assume a modest box when we can't tell
_FALLBACK_TOTAL = 4 * 1024**3

# Fraction of *currently-available* RAM a single named cache may claim. A global
# policy: sum of fractions across all consulted caches stays well under 1.0 so no
# single cache can starve the box. Unknown names get the default.
_CACHE_FRACTION: dict[str, float] = {
    "tilecache": 0.10,
    "history": 0.05,
    "detections": 0.05,
}
_DEFAULT_FRACTION = 0.05


def _meminfo() -> tuple[int, int]:
    """(MemAvailable, MemTotal) in bytes. Falls back to constants off-Linux.

    Factored out so tests can monkeypatch it without touching /proc.
    """
    avail = total = 0
    try:
        with open("/proc/meminfo", encoding="ascii") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    avail = int(line.split()[1]) * 1024  # kB → bytes
                elif line.startswith("MemTotal:"):
                    total = int(line.split()[1]) * 1024
                if avail and total:
                    break
    except (OSError, ValueError, IndexError):
        pass
    if avail <= 0:
        avail = _FALLBACK_AVAILABLE
    if total <= 0:
        total = max(_FALLBACK_TOTAL, avail)
    return avail, total


def available_bytes() -> int:
    """Bytes of RAM currently available to allocate without swapping."""
    return _meminfo()[0]


def total_bytes() -> int:
    """Total physical RAM in bytes."""
    return _meminfo()[1]


def cache_budget_bytes(name: str, *, floor: int, ceil: int) -> int:
    """Byte cap for cache ``name``, scaled to available RAM and clamped to [floor, ceil].

    ``ceil`` is the operator-configured hard ceiling (e.g. the existing static
    config value) — the budget never exceeds it. ``floor`` guarantees a usable
    cache even on a memory-starved box.
    """
    if floor > ceil:
        floor = ceil
    frac = _CACHE_FRACTION.get(name, _DEFAULT_FRACTION)
    scaled = int(available_bytes() * frac)
    return max(floor, min(scaled, ceil))


def prefer_ram(need_bytes: int, *, headroom: float = 0.5) -> bool:
    """True if holding ``need_bytes`` in RAM still leaves ``headroom`` of available free.

    Drives the RAM-dict vs disk-spill decision for the detection caches. With the
    default headroom=0.5, a payload is kept in RAM only if it fits within half of
    currently-available memory.
    """
    if need_bytes <= 0:
        return True
    return need_bytes <= available_bytes() * (1.0 - headroom)


def snapshot() -> dict[str, object]:
    """Observable policy state for the health route — the real per-cache ceilings."""
    avail, total = _meminfo()
    from app.config import get_settings

    s = get_settings()
    tile_ceil = int(s.tile_cache_max_bytes)
    hist_ceil = int(s.history_max_bytes)
    return {
        "available_bytes": avail,
        "total_bytes": total,
        "budgets": {
            "tilecache": cache_budget_bytes("tilecache", floor=256 * 1024**2, ceil=tile_ceil),
            "history": cache_budget_bytes("history", floor=64 * 1024**2, ceil=hist_ceil),
            # detections store is defined in Phase 3; 512 MiB placeholder ceiling.
            "detections": cache_budget_bytes("detections", floor=32 * 1024**2, ceil=512 * 1024**2),
        },
    }
