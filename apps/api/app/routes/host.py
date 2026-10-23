"""GET /api/status/host: this box's own hardware and process readings.

The AIP copy's ground-station pages (gotham/aip/_build_features_b.py, TITAN
A44-A53/A65) were baked from /proc, /sys, nvidia-smi, lsblk, ss and ps on the
box that runs the API. This route returns the same readings, live, and only the
fields those pages draw: no command lines, no environment, no paths beyond the
device names. Diagnostics contract like /api/status/*: never 500; a reading
that cannot be taken is null or absent, never guessed.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter(tags=["status"])

# the listeners the copy groups into software (API, tile process, sidecars,
# console, local inference)
PORTS = (8000, 8001, 8090, 8093, 5173, 11434)
_GPU_Q = (
    "name,temperature.gpu,utilization.gpu,memory.used,memory.total,"
    "power.draw,power.limit,driver_version"
)


def _read(p: Path | str) -> str | None:
    try:
        return Path(p).read_text().strip()
    except OSError:
        return None


def _run(argv: list[str]) -> str:
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return out.stdout if out.returncode == 0 else ""


def parse_meminfo(text: str) -> dict[str, int]:
    """MB totals; used = MemTotal - MemAvailable (what `free` calls available)."""
    kb: dict[str, int] = {}
    for line in text.splitlines():
        k, _, v = line.partition(":")
        if v.split():
            kb[k] = int(v.split()[0])
    total = kb.get("MemTotal", 0)
    return {"total": total // 1024, "used": (total - kb.get("MemAvailable", total)) // 1024}


def parse_netdev(text: str) -> dict[str, tuple[int, int]]:
    """iface -> (rx_bytes, tx_bytes) from /proc/net/dev."""
    out: dict[str, tuple[int, int]] = {}
    for line in text.splitlines()[2:]:
        name, _, rest = line.partition(":")
        v = rest.split()
        if len(v) >= 9:
            out[name.strip()] = (int(v[0]), int(v[8]))
    return out


def parse_gpu(line: str) -> dict[str, Any] | None:
    p = [x.strip() for x in line.strip().splitlines()[0].split(",")] if line.strip() else []
    if len(p) < 8:
        return None

    def num(s: str) -> float | None:
        try:
            return float(s)
        except ValueError:
            return None

    return {
        "name": p[0],
        "temp_c": num(p[1]),
        "util_pct": num(p[2]),
        "mem_used_mb": num(p[3]),
        "mem_total_mb": num(p[4]),
        "power_w": num(p[5]),
        "power_limit_w": num(p[6]),
        "driver": p[7],
    }


def parse_listeners(ss_out: str, ports: tuple[int, ...] = PORTS) -> dict[int, int]:
    """port -> pid from `ss -ltnpH` (only sockets this user may see carry a pid)."""
    out: dict[int, int] = {}
    for line in ss_out.splitlines():
        cols = line.split()
        if len(cols) < 4:
            continue
        m = re.search(r":(\d+)$", cols[3])
        pid = re.search(r"pid=(\d+)", line)
        if m and pid and int(m.group(1)) in ports:
            out.setdefault(int(m.group(1)), int(pid.group(1)))
    return out


def _proc(pid: int, uptime: float) -> dict[str, Any] | None:
    stat = _read(f"/proc/{pid}/stat")
    status = _read(f"/proc/{pid}/status") or ""
    if not stat:
        return None
    # field 22 (starttime, clock ticks) sits after the parenthesised comm
    start = int(stat.rsplit(")", 1)[1].split()[19]) / os.sysconf("SC_CLK_TCK")
    rss = re.search(r"VmRSS:\s+(\d+)", status)
    rss_mb = int(rss.group(1)) // 1024 if rss else None
    return {"pid": pid, "etimes": int(uptime - start), "rss_mb": rss_mb}


def _cpu_model() -> str | None:
    for line in (_read("/proc/cpuinfo") or "").splitlines():
        if line.startswith("model name"):
            return line.split(":", 1)[1].strip()
    return None


def _hwmon() -> list[dict[str, Any]]:
    out = []
    for h in sorted(Path("/sys/class/hwmon").glob("hwmon*")):
        temps: dict[str, float] = {}
        for t in sorted(h.glob("temp*_input")):
            v = _read(t)
            if v is None or not v.lstrip("-").isdigit():
                continue
            label = _read(h / t.name.replace("_input", "_label")) or t.name
            temps[label] = int(v) / 1000
        out.append({"chip": _read(h / "name"), "temps": temps})
    return out


def _disks() -> list[dict[str, Any]]:
    out = []
    for b in sorted(Path("/sys/block").iterdir()) if Path("/sys/block").exists() else []:
        if b.name.startswith(("loop", "ram", "zram", "dm-", "sr")):
            continue
        size = _read(b / "size")
        out.append(
            {
                "name": b.name,
                "bytes": int(size) * 512 if size and size.isdigit() else None,
                "model": _read(b / "device" / "model"),
            }
        )
    return out


def _net() -> dict[str, dict[str, Any]]:
    io = parse_netdev(_read("/proc/net/dev") or "")
    out = {}
    for n in sorted(os.listdir("/sys/class/net")) if Path("/sys/class/net").exists() else []:
        sp = _read(f"/sys/class/net/{n}/speed")
        rx, tx = io.get(n, (None, None))
        out[n] = {
            "oper": _read(f"/sys/class/net/{n}/operstate"),
            "speed_mbps": int(sp) if sp and sp.isdigit() and int(sp) > 0 else None,
            "rx_bytes": rx,
            "tx_bytes": tx,
        }
    return out


def host_report() -> dict[str, Any]:
    uptime = float((_read("/proc/uptime") or "0").split()[0])
    la = (_read("/proc/loadavg") or "").split()
    try:
        du = shutil.disk_usage("/")
        root = {"size": du.total, "used": du.used}
    except OSError:
        root = None
    procs = {}
    for port, pid in parse_listeners(_run(["ss", "-ltnpH"])).items():
        p = _proc(pid, uptime)
        if p:
            procs[str(port)] = p
    return {
        "taken": time.time(),
        "uptime_s": uptime,
        "cpu": {"model": _cpu_model(), "threads": os.cpu_count()},
        "loadavg": [float(x) for x in la[:3]] if len(la) >= 3 else None,
        "mem_mb": parse_meminfo(_read("/proc/meminfo") or ""),
        "root": root,
        "hwmon": _hwmon(),
        "gpu": parse_gpu(
            _run(["nvidia-smi", f"--query-gpu={_GPU_Q}", "--format=csv,noheader,nounits"])
        ),
        "disks": _disks(),
        "net": _net(),
        "listening": procs,
        "ports": list(PORTS),
    }


@router.get("/api/status/host")
async def status_host() -> dict[str, Any]:
    try:
        return await asyncio.to_thread(host_report)
    except Exception:  # noqa: BLE001 — diagnostics must never 500
        return {"taken": time.time(), "error": "unavailable"}
