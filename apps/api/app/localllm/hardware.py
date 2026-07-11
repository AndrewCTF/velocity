"""Hardware detection + speed/medium/quality preset recommendation.

Detection (all best-effort, tolerate absence — a box with no GPU / no
``/proc/meminfo`` still gets a usable, honestly-degraded report):
  - GPU: ``nvidia-smi --query-gpu=memory.total,name`` (argv-exec, no shell).
  - RAM: ``/proc/meminfo`` ``MemTotal``.
  - Disk: ``shutil.disk_usage`` on the models directory.

Preset logic (research-serving-security.md "Preset logic" section):
  - speed:   largest catalog tier whose recommended quant fits ENTIRELY in
             VRAM (fastest, no CPU offload).
  - medium:  largest tier fitting VRAM + a conservative slice of RAM (MoE
             hybrid, some experts offloaded to CPU).
  - quality: largest tier fitting VRAM + most of RAM; REFUSED outright below
             a 32GB RAM floor rather than recommending something that would
             thrash, per the approved design.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

from . import catalog

_QUALITY_RAM_FLOOR_MB = 32 * 1024

# Fraction of RAM counted toward the "medium" combined-memory budget — smaller
# than the quality fraction (catalog.RAM_OFFLOAD_FACTOR-ish) so medium sits
# clearly between speed (VRAM-only) and quality (near-full RAM) in practice.
_MEDIUM_RAM_FACTOR = 0.5
_QUALITY_RAM_FACTOR = 0.85


def detect_gpu() -> dict[str, Any] | None:
    """First NVIDIA GPU's name + total VRAM (MB), or None if unavailable."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total,name", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    line = out.stdout.strip().splitlines()[0]
    parts = [p.strip() for p in line.split(",", 1)]
    if len(parts) != 2:
        return None
    try:
        vram_mb = int(float(parts[0]))
    except ValueError:
        return None
    return {"name": parts[1], "vram_mb": vram_mb}


def detect_ram_mb() -> int:
    """Total system RAM in MB from /proc/meminfo; 0 if unreadable."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return kb // 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


def detect_disk_free_mb(models_dir: Path | str) -> int:
    """Free disk space (MB) on the filesystem holding *models_dir*."""
    p = Path(models_dir)
    try:
        p.mkdir(parents=True, exist_ok=True)
        return shutil.disk_usage(p).free // (1024 * 1024)
    except OSError:
        return 0


def _pick_largest_fitting(predicate) -> catalog.CatalogEntry | None:
    for tier in reversed(catalog.TIER_ORDER):
        entry = catalog.BY_TIER[tier]
        if predicate(entry):
            return entry
    return None


def _preset_dict(
    entry: catalog.CatalogEntry | None, reason: str, *, refused: bool = False
) -> dict[str, Any]:
    if entry is None:
        d: dict[str, Any] = {
            "tier": None,
            "repo_id": None,
            "quant": None,
            "est_size_gb": None,
            "fits": False,
            "reason": reason,
        }
        if refused:
            d["refused_reason"] = reason
        return d
    return {
        "tier": entry.tier,
        "repo_id": entry.repo_id,
        "quant": entry.recommended_quant,
        "est_size_gb": entry.recommended.size_gb,
        "fits": True,
        "reason": reason,
    }


def build_report(
    gpu: dict[str, Any] | None, ram_mb: int, disk_free_mb: int
) -> dict[str, Any]:
    """The ``GET /api/ai/hardware`` response body."""
    vram_mb = gpu["vram_mb"] if gpu else None
    ram_gb = ram_mb / 1024.0
    disk_free_gb = disk_free_mb / 1024.0
    usable_vram = catalog.usable_vram_gb(vram_mb)

    def _disk_ok(entry: catalog.CatalogEntry) -> bool:
        return entry.recommended.size_gb <= disk_free_gb

    speed_entry = _pick_largest_fitting(
        lambda e: e.recommended.size_gb <= usable_vram and _disk_ok(e)
    )
    speed = _preset_dict(
        speed_entry,
        (
            f"largest model that fits entirely in ~{usable_vram:.0f}GB usable VRAM"
            if speed_entry
            else "no catalog tier's recommended quant fits fully in VRAM on this "
            "hardware; consider the built-in Ollama small-model path"
        ),
    )

    medium_budget = usable_vram + ram_gb * _MEDIUM_RAM_FACTOR
    medium_entry = _pick_largest_fitting(
        lambda e: e.recommended.size_gb <= medium_budget and _disk_ok(e)
    )
    medium = _preset_dict(
        medium_entry,
        (
            f"MoE hybrid: fits VRAM + partial RAM offload (~{ram_gb:.0f}GB RAM)"
            if medium_entry
            else "no catalog tier fits within available VRAM + partial RAM offload"
        ),
    )

    if ram_mb < _QUALITY_RAM_FLOOR_MB:
        quality = _preset_dict(
            None,
            "quality tier needs at least 32GB system RAM for MoE hybrid "
            "offload; add RAM or use the speed/medium preset",
            refused=True,
        )
    else:
        quality_budget = usable_vram + ram_gb * _QUALITY_RAM_FACTOR
        quality_entry = _pick_largest_fitting(
            lambda e: e.recommended.size_gb <= quality_budget and _disk_ok(e)
        )
        if quality_entry is None:
            quality = _preset_dict(
                None,
                "no catalog tier fits within available VRAM + RAM even at the "
                "lowest quant on this hardware",
                refused=True,
            )
        else:
            quality = _preset_dict(
                quality_entry,
                f"largest MoE hybrid this hardware can hold (~{ram_gb:.0f}GB RAM available)",
            )

    presets = {"speed": speed, "medium": medium, "quality": quality}

    # Balanced default recommendation: medium > speed > quality > none.
    for name in ("medium", "speed", "quality"):
        p = presets[name]
        if p["fits"]:
            recommendation = {
                "preset": name,
                "tier": p["tier"],
                "repo_id": p["repo_id"],
                "quant": p["quant"],
                "reason": p["reason"],
            }
            break
    else:
        recommendation = {
            "preset": None,
            "tier": None,
            "repo_id": None,
            "quant": None,
            "reason": "no catalog tier fits this hardware; consider the built-in "
            "Ollama small-model path",
        }

    return {
        "gpu": gpu,
        "ram_mb": ram_mb,
        "disk_free_mb": disk_free_mb,
        "recommendation": recommendation,
        "presets": presets,
    }
