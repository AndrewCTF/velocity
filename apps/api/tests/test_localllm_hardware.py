"""Unit tests for app.localllm.hardware — detection parsing + preset logic.

No network/subprocess in the preset tests (build_report takes gpu/ram/disk as
plain args); detect_gpu/detect_ram_mb are covered separately with a
monkeypatched subprocess.run / a temp /proc-style file.
"""

from __future__ import annotations

import subprocess

import pytest

from app.localllm import hardware

# ── detect_gpu ──────────────────────────────────────────────────────────────


def test_detect_gpu_parses_nvidia_smi(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResult:
        returncode = 0
        stdout = "32607, NVIDIA GeForce RTX 5090\n"
        stderr = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeResult())
    gpu = hardware.detect_gpu()
    assert gpu == {"name": "NVIDIA GeForce RTX 5090", "vram_mb": 32607}


def test_detect_gpu_absent_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(*a, **k):
        raise FileNotFoundError("no nvidia-smi")

    monkeypatch.setattr(subprocess, "run", _raise)
    assert hardware.detect_gpu() is None


def test_detect_gpu_nonzero_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResult:
        returncode = 1
        stdout = ""
        stderr = "no devices"

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeResult())
    assert hardware.detect_gpu() is None


def test_detect_gpu_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(*a, **k):
        raise subprocess.TimeoutExpired(cmd="nvidia-smi", timeout=5)

    monkeypatch.setattr(subprocess, "run", _raise)
    assert hardware.detect_gpu() is None


# ── detect_ram_mb ────────────────────────────────────────────────────────────


def test_detect_ram_mb_parses_meminfo(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:       131951616 kB\nMemFree:        1000 kB\n")
    real_open = open

    def fake_open(path, *a, **k):
        if path == "/proc/meminfo":
            return real_open(meminfo, *a, **k)
        return real_open(path, *a, **k)

    monkeypatch.setattr("builtins.open", fake_open)
    assert hardware.detect_ram_mb() == 131951616 // 1024


def test_detect_ram_mb_missing_file(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(*a, **k):
        raise FileNotFoundError()

    monkeypatch.setattr("builtins.open", _raise)
    assert hardware.detect_ram_mb() == 0


# ── detect_disk_free_mb ──────────────────────────────────────────────────────


def test_detect_disk_free_mb(tmp_path) -> None:
    d = tmp_path / "models"
    free_mb = hardware.detect_disk_free_mb(d)
    assert free_mb > 0
    assert d.is_dir()  # created as a side effect


# ── preset logic (research-serving-security.md "Preset logic") ──────────────


def test_presets_5090_box_from_design_doc() -> None:
    # The exact box the design doc was written against: RTX 5090 32GB VRAM,
    # 121GB RAM, 195GB disk free.
    gpu = {"name": "NVIDIA GeForce RTX 5090", "vram_mb": 32 * 1024}
    report = hardware.build_report(gpu, ram_mb=121 * 1024, disk_free_mb=195 * 1024)

    assert report["gpu"] == gpu
    speed, medium, quality = (report["presets"][k] for k in ("speed", "medium", "quality"))

    # speed: largest tier fully inside ~30GB usable VRAM -> 30b (22.4GB).
    assert speed["fits"] is True
    assert speed["tier"] == "30b"

    # medium: VRAM + half of RAM -> bigger than speed.
    assert medium["fits"] is True
    assert medium["tier"] in ("70b", "120b", "200b", "300b", "700b")
    assert catalog_tier_rank(medium["tier"]) > catalog_tier_rank(speed["tier"])

    # quality: RAM (121GB) clears the 32GB floor, and picks the biggest tier
    # that still fits VRAM + most of RAM -> at least as big as medium.
    assert quality["fits"] is True
    assert catalog_tier_rank(quality["tier"]) >= catalog_tier_rank(medium["tier"])

    assert report["recommendation"]["preset"] in ("speed", "medium", "quality")
    assert report["recommendation"]["repo_id"] is not None


def catalog_tier_rank(tier: str) -> int:
    from app.localllm.catalog import TIER_ORDER

    return TIER_ORDER.index(tier)


def test_quality_refused_below_32gb_ram() -> None:
    gpu = {"name": "some gpu", "vram_mb": 24 * 1024}
    report = hardware.build_report(gpu, ram_mb=16 * 1024, disk_free_mb=500 * 1024)
    quality = report["presets"]["quality"]
    assert quality["fits"] is False
    assert "refused_reason" in quality
    assert "32GB" in quality["refused_reason"]


def test_speed_refused_with_no_gpu_and_tiny_ram() -> None:
    report = hardware.build_report(None, ram_mb=4 * 1024, disk_free_mb=500 * 1024)
    speed = report["presets"]["speed"]
    assert speed["fits"] is False
    assert speed["repo_id"] is None
    assert "Ollama" in speed["reason"]


def test_small_gpu_box_speed_picks_8b(tmp_path=None) -> None:
    gpu = {"name": "small gpu", "vram_mb": 12 * 1024}  # ~10GB usable
    report = hardware.build_report(gpu, ram_mb=16 * 1024, disk_free_mb=500 * 1024)
    speed = report["presets"]["speed"]
    assert speed["fits"] is True
    assert speed["tier"] == "8b"


def test_disk_preflight_refuses_when_disk_too_small() -> None:
    # Plenty of VRAM/RAM, but almost no disk free -> nothing can be recommended.
    gpu = {"name": "big gpu", "vram_mb": 32 * 1024}
    report = hardware.build_report(gpu, ram_mb=121 * 1024, disk_free_mb=1)  # ~1MB free
    speed = report["presets"]["speed"]
    assert speed["fits"] is False


def test_recommendation_reason_present_and_none_when_nothing_fits() -> None:
    report = hardware.build_report(None, ram_mb=1024, disk_free_mb=100)
    rec = report["recommendation"]
    assert rec["preset"] is None
    assert rec["repo_id"] is None
    assert "reason" in rec and rec["reason"]
