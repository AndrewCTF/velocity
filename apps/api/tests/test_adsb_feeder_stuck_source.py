"""One wedged or bloated tar1090 source must not freeze the ADS-B union.

`tools/adsb-globe-feeder/index.js` used to `await allSettled(pumps)` before every
union rebuild, so an evaluate timeout plus a reinit on ONE source froze every
aircraft worldwide (measured 2026-09-13: 12-20 s windows with zero position
changes, one per ~90 s). Each source now reads on its own loop.

The stub Playwright below serves a healthy source and a source whose store stops
answering after its first read and whose reinit never returns. The union must
keep rebuilding from the healthy one.

Every tar1090 tab's heap also climbs for as long as it is open, and at the
renderer's cap the read hangs (adsb.lol, every ~80 s, 2026-09-13). A page past
RECYCLE_FRAC of HEAP_MB is replaced by one opened beside it, so the source keeps
answering through the swap.
"""

from __future__ import annotations

import contextlib
import shutil
import socket
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from app import childenv

_REPO = Path(__file__).resolve().parents[3]

_STUB = r"""
const fs = require('fs');
const never = () => new Promise(() => {});
const opened = new Set();
const context = {
  close: async () => {},
  newPage: async () => {
    let stuck = false;
    let reads = 0;
    return {
      goto: async (url) => {
        stuck = url.includes('stuck');
        if (stuck && opened.has(url)) return never(); // the reinit never returns
        opened.add(url);
        fs.appendFileSync('opens.log', url + '\n');
      },
      waitForFunction: async () => true,
      waitForTimeout: () => new Promise((f) => setTimeout(f, 10)),
      evaluate: async (fn) => {
        if (fn.name === 'heapFn') return Number(process.env.STUB_HEAP_MB || 0);
        if (fn.name !== 'readFn') return true;
        if (stuck && reads++ > 0) return never(); // store stops answering
        return [{ hex: stuck ? 'b' : 'a', lat: 1, lon: 1, seen_pos: 0 }];
      },
      context: () => context,
    };
  },
};
const browser = {
  isConnected: () => true, on: () => {}, close: async () => {},
  newContext: async () => context,
};
module.exports = { chromium: { launch: async () => browser } };
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def _feeder(tmp_path: Path, extra: dict[str, str]) -> Iterator[str]:
    stub = tmp_path / "node_modules" / "playwright"
    stub.mkdir(parents=True)
    (stub / "index.js").write_text(_STUB)
    # Copied beside the stub: from its own directory `require('playwright')`
    # resolves the feeder's real node_modules before NODE_PATH is consulted.
    feeder = tmp_path / "feeder.js"
    shutil.copy(_REPO / "tools" / "adsb-globe-feeder" / "index.js", feeder)
    port = _free_port()
    env = childenv.child_env(
        {"PORT": str(port), "MIN_PLANES": "1", "READ_MS": "200", "NUDGE_MS": "600000", **extra}
    )
    proc = subprocess.Popen(
        ["node", str(feeder)],
        cwd=str(tmp_path), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                if httpx.get(f"{base}/health", timeout=1).json()["rev"] > 0:
                    break
            except httpx.TransportError:
                if proc.poll() is not None:
                    raise
            if time.monotonic() > deadline:
                raise AssertionError("union never built")
            time.sleep(0.1)
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_a_wedged_source_does_not_freeze_the_union(tmp_path: Path) -> None:
    extra = {"GLOBE_URLS": "https://ok.test/,https://stuck.test/", "READ_TIMEOUT_MS": "500"}
    with _feeder(tmp_path, extra) as base:
        # Let the stuck source time out and wedge inside its reinit.
        time.sleep(2)
        before = httpx.get(f"{base}/health").json()
        time.sleep(2)
        after = httpx.get(f"{base}/health").json()
        assert after["rev"] - before["rev"] >= 3, (before, after)
        assert after["sources"]["https://ok.test/"]["age_s"] <= 1, after


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_a_bloated_page_is_replaced_without_a_gap(tmp_path: Path) -> None:
    extra = {"GLOBE_URLS": "https://ok.test/", "HEAP_MB": "1000", "STUB_HEAP_MB": "700"}
    with _feeder(tmp_path, extra) as base:
        ages = []
        for _ in range(8):
            time.sleep(0.5)
            ages.append(httpx.get(f"{base}/health").json()["sources"]["https://ok.test/"]["age_s"])
        opens = (tmp_path / "opens.log").read_text().split()
        assert len(opens) >= 2, opens  # 700 MB is past 0.6 x 1000: it recycled
        assert max(ages) <= 1, ages  # and the source never went dark doing it


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_a_page_under_the_threshold_is_left_alone(tmp_path: Path) -> None:
    extra = {"GLOBE_URLS": "https://ok.test/", "HEAP_MB": "1000", "STUB_HEAP_MB": "500"}
    with _feeder(tmp_path, extra):
        time.sleep(4)
        assert (tmp_path / "opens.log").read_text().split() == ["https://ok.test/"]
