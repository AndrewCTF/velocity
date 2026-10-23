"""/api/status/host: this box's readings for the AIP ground-station copy."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routes import host


def test_parsers() -> None:
    assert host.parse_meminfo(
        "MemTotal: 2048000 kB\nMemFree: 1 kB\nMemAvailable: 1024000 kB\n"
    ) == {
        "total": 2000,
        "used": 1000,
    }
    dev = (
        "Inter-|   Receive\n face |bytes\n"
        "  eth0: 100 2 0 0 0 0 0 0 300 4 0 0 0 0 0 0\n"
        "    lo: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n"
    )
    assert host.parse_netdev(dev) == {"eth0": (100, 300), "lo": (5, 5)}
    g = host.parse_gpu("NVIDIA GeForce RTX 5090, 41, 3, 900, 32607, 61.2, 575.0, 580.1\n")
    assert g and g["name"].endswith("5090") and g["power_w"] == 61.2 and g["driver"] == "580.1"
    assert host.parse_gpu("") is None
    ss = (
        'LISTEN 0 2048 0.0.0.0:8000 0.0.0.0:* users:(("uvicorn",pid=627744,fd=7))\n'
        "LISTEN 0 4096 127.0.0.1:11434 0.0.0.0:*\n"
        'LISTEN 0 5 127.0.0.1:9222 0.0.0.0:* users:(("chrome",pid=1,fd=3))\n'
        'LISTEN 0 511 [::1]:5173 [::]:* users:(("node",pid=42,fd=20))\n'
    )
    # a socket with no visible pid is not guessed; ports outside the list are skipped
    assert host.parse_listeners(ss) == {8000: 627744, 5173: 42}


def test_route_shape() -> None:
    app = FastAPI()
    app.include_router(host.router)
    r = TestClient(app).get("/api/status/host")
    assert r.status_code == 200
    d = r.json()
    for k in ("taken", "uptime_s", "cpu", "mem_mb", "hwmon", "disks", "net", "listening"):
        assert k in d
    assert d["cpu"]["threads"] and d["mem_mb"]["total"] > 0
    # never a command line or environment
    assert "cmd" not in str(d["listening"])
