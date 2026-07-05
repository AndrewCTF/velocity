"""memtier cache sizing policy."""

from __future__ import annotations

from app import memtier


def test_available_bytes_positive() -> None:
    assert memtier.available_bytes() > 0
    assert memtier.total_bytes() >= memtier.available_bytes()


def test_budget_clamps_to_floor_and_ceil(monkeypatch) -> None:
    # Tiny available RAM → floor wins.
    monkeypatch.setattr(memtier, "_meminfo", lambda: (10 * 1024**2, 20 * 1024**2))
    b = memtier.cache_budget_bytes("tilecache", floor=256 * 1024**2, ceil=1024**3)
    assert b == 256 * 1024**2

    # Huge available RAM → ceil wins (10% of 1 TiB > 1 GiB ceil).
    monkeypatch.setattr(memtier, "_meminfo", lambda: (1024**4, 1024**4))
    b = memtier.cache_budget_bytes("tilecache", floor=256 * 1024**2, ceil=1024**3)
    assert b == 1024**3

    # Mid RAM → scaled fraction between floor and ceil.
    monkeypatch.setattr(memtier, "_meminfo", lambda: (4 * 1024**3, 8 * 1024**3))
    b = memtier.cache_budget_bytes("tilecache", floor=256 * 1024**2, ceil=1024**3)
    assert b == int(4 * 1024**3 * 0.10)  # 10% of 4 GiB, within [floor, ceil]


def test_budget_floor_never_exceeds_ceil(monkeypatch) -> None:
    monkeypatch.setattr(memtier, "_meminfo", lambda: (10 * 1024**2, 20 * 1024**2))
    b = memtier.cache_budget_bytes("x", floor=1024**3, ceil=64 * 1024**2)
    assert b == 64 * 1024**2  # floor clamped down to ceil


def test_prefer_ram_flips_across_threshold(monkeypatch) -> None:
    monkeypatch.setattr(memtier, "_meminfo", lambda: (1024**3, 2 * 1024**3))  # 1 GiB avail
    # headroom 0.5 → need must be <= 512 MiB to stay in RAM.
    assert memtier.prefer_ram(400 * 1024**2) is True
    assert memtier.prefer_ram(600 * 1024**2) is False
    assert memtier.prefer_ram(0) is True


def test_snapshot_shape() -> None:
    s = memtier.snapshot()
    assert s["available_bytes"] > 0
    assert set(s["budgets"]) == {"tilecache", "history", "detections"}
