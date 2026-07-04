"""Guards the GPS-jamming hex lattice tessellates (no gaps/overlaps).

The old layer drew regular hexagons on a 1°×1° SQUARE lattice — they met only
at points and left diamond gaps ("hexagons not aligning"). The fix bins to a
real pointy-top hex lattice. These checks fail if anyone reverts to a grid the
hexagons can't tile.
"""

from app.routes.jamming import _hex_cell, _hex_center, _hex_polygon


def test_cell_centre_round_trips() -> None:
    # Every cell's own centre must classify back into that same cell — the
    # property that makes the lattice a partition (each point in exactly 1 hex).
    for q in range(-30, 30):
        for r in range(-30, 30):
            lon, lat = _hex_center(q, r)
            if abs(lon) > 180 or abs(lat) > 85:
                continue
            assert _hex_cell(lon, lat) == (q, r)


def test_polygon_is_closed_hexagon() -> None:
    ring = _hex_polygon(*_hex_center(0, 0))
    assert len(ring) == 7
    assert ring[0] == ring[-1]  # closed exactly, no float drift


def test_neighbours_share_an_edge_not_a_point() -> None:
    # Two adjacent cells must share TWO vertices (an edge). On the old square
    # lattice they shared at most one (a point) — the visible misalignment.
    def verts(q: int, r: int) -> set[tuple[float, float]]:
        return {
            (round(x, 6), round(y, 6))
            for x, y in _hex_polygon(*_hex_center(q, r))[:6]
        }

    a = verts(0, 0)
    for nq, nr in [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)]:
        shared = a & verts(nq, nr)
        assert len(shared) == 2, f"cell ({nq},{nr}) shares {len(shared)} verts"
