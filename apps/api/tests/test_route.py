"""Off-road A* core — pure, no network. Proves the slope cost-surface bends the
path around an impassable barrier instead of bulldozing straight through."""

from __future__ import annotations

import numpy as np

from app.intel import offroad


def _flat(n: int = 40) -> np.ndarray:
    return np.zeros((n, n), dtype=np.float32)


def test_straight_path_on_flat_ground() -> None:
    elev = _flat()
    path, stats = offroad.astar_grid(elev, (20, 2), (20, 37), meters_per_cell=30.0)
    assert stats["reachable"] is True
    assert path[0] == (20, 2)
    assert path[-1] == (20, 37)
    # On perfectly flat ground the path should be short (near the straight line).
    assert stats["cells"] <= 45


def test_path_avoids_impassable_ridge() -> None:
    # A tall vertical ridge across the middle, with a gap at the bottom rows.
    elev = _flat(40)
    elev[0:35, 20] = 5000.0  # a wall too steep to climb (gap rows 35-39)
    start, goal = (5, 5), (5, 34)
    path, stats = offroad.astar_grid(elev, start, goal, meters_per_cell=30.0)
    assert stats["reachable"] is True
    # The path must NOT cross any wall cell.
    assert all(not (c == 20 and r < 35) for (r, c) in path)
    # It had to detour downward to the gap, so it is longer than the direct span.
    assert stats["cells"] > (goal[1] - start[1])


def test_water_blocks_when_disallowed() -> None:
    elev = _flat(20)
    elev[:, 10] = -50.0  # a full-height water column splits the grid
    path, stats = offroad.astar_grid(elev, (10, 2), (10, 17), meters_per_cell=30.0)
    assert stats["reachable"] is False
    assert path == []


def test_decode_terrarium_roundtrips_elevation() -> None:
    # Encode a known elevation (1234 m) into one terrarium RGB pixel and back.
    from PIL import Image

    v = 1234.0 + 32768.0
    r = int(v // 256)
    g = int(v % 256)
    b = int(round((v - int(v)) * 256)) % 256
    img = Image.new("RGB", (2, 2), (r, g, b))
    import io

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    elev = offroad.decode_terrarium(buf.getvalue())
    assert abs(float(elev[0, 0]) - 1234.0) < 1.0
