"""Executable guards for operator-decided invariants (see CLAUDE.md, docs/decisions.md).

Prose invariants decay; these fail loud instead. A failure means a sacred
behavior regressed — fix the code, or revoke the decision deliberately by
changing BOTH the test and CLAUDE.md.
"""

from __future__ import annotations

import os
import pathlib
import re

import pytest

APP = pathlib.Path(__file__).resolve().parents[1] / "app"


def test_upstream_burst_semaphore_is_8() -> None:
    # Decision (airplanes.live post-mortem): >8 concurrent /v2/point calls get
    # rate-limited with HTTP 200 + text/plain bodies. Do not raise this.
    src = (APP / "routes" / "adsb.py").read_text()
    assert re.search(r"_UPSTREAM_SEMAPHORE\s*=\s*asyncio\.Semaphore\(8\)", src), (
        "_UPSTREAM_SEMAPHORE must stay asyncio.Semaphore(8)"
    )


def test_internal_consumers_use_global_snapshot_not_route_handler() -> None:
    # Decision (jamming-layer 500 post-mortem): calling the adsb_global()
    # route handler in-process passes Query defaults into viewport_filter and
    # 500s. Internal consumers must call global_snapshot().
    offenders: list[str] = []
    for path in APP.rglob("*.py"):
        if path.parent.name == "routes" and path.name == "adsb.py":
            continue
        text = path.read_text()
        for match in re.finditer(r"adsb_global\s*\(", text):
            if match.start() > 0 and text[match.start() - 1] == "`":
                continue  # docstring mention (``adsb_global()``), not a call
            line = text[: match.start()].count("\n") + 1
            offenders.append(f"{path.relative_to(APP)}:{line}")
    assert not offenders, f"call global_snapshot(), not adsb_global(): {offenders}"


def test_celestrak_requests_tle_format() -> None:
    # Decision: CelesTrak OMM JSON omits TLE_LINE1/2, which the client SGP4
    # parser requires — FORMAT=json renders ZERO satellites.
    src = (APP / "routes" / "space.py").read_text()
    assert '"FORMAT": "tle"' in src


def test_sidecar_children_scrub_jemalloc_env() -> None:
    # Decision (2026-07-04 post-mortem): run-api.sh's LD_PRELOAD inherited into
    # headless Chrome kills the zygote -> sidecar serves 0 aircraft.
    for name in ("adsb_sidecar.py", "ais_sidecar.py"):
        src = (APP / name).read_text()
        assert "LD_PRELOAD" in src, f"{name} must scrub LD_PRELOAD from child env"


@pytest.mark.skipif(
    not os.environ.get("OSINT_LIVE_PROBE"),
    reason="live probe: set OSINT_LIVE_PROBE=1 with the backend on :8000",
)
def test_global_snapshot_floor_live() -> None:
    # Decision: the global snapshot must carry >=8000 aircraft in steady state
    # (~13k normal). A drop to hundreds is a feed regression, not noise.
    import httpx

    headers = {}
    if os.environ.get("OSINT_PROBE_KEY"):
        headers["X-API-Key"] = os.environ["OSINT_PROBE_KEY"]
    resp = httpx.get(
        "http://127.0.0.1:8000/api/adsb/global",
        params={"limit": 20000},
        headers=headers,
        timeout=30,
    )
    resp.raise_for_status()
    count = len(resp.json().get("features", []))
    assert count >= 8000, f"snapshot regression: {count} aircraft (< 8000 floor)"
