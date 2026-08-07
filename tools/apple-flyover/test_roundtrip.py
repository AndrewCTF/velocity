#!/usr/bin/env python3
"""Self-check: parse a cached C3M blob and verify structural integrity."""

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from apple3d.c3m import parse
from apple3d.auth import sign_url


def test_auth_signing():
    """Verify auth produces a signed URL with expected structure."""
    url = "https://example.com/tile?style=15&v=1"
    signed = sign_url(url, "12345", "tok1", "tok2")
    assert "sid=12345" in signed
    assert "accessKey=" in signed
    parts = signed.split("accessKey=")[1]
    # accessKey = timestamp_tokenP3_base64
    decoded = parts.split("&")[0]
    from urllib.parse import unquote
    decoded = unquote(decoded)
    pieces = decoded.split("_")
    assert len(pieces) >= 3, f"accessKey should have 3+ parts: {pieces}"
    ts = int(pieces[0])
    assert ts > 1000000000, f"timestamp looks wrong: {ts}"
    print("  auth signing: OK")


def test_c3m_parse():
    """Parse a cached C3M tile and verify mesh structure."""
    cache = Path("cache")
    c3m_files = list(cache.glob("c3m_*.bin"))
    if not c3m_files:
        print("  SKIP: no cached C3M files (run smoke_test.py first)")
        return

    for f in c3m_files:
        data = f.read_bytes()
        assert data[:3] == b"C3M", f"bad magic: {data[:4]}"
        c3m = parse(data)

        # header
        tx, ty, tz = c3m.header.translation
        assert not (tx == 0 and ty == 0 and tz == 0), "ECEF translation is zero"
        ecef_mag = (tx**2 + ty**2 + tz**2) ** 0.5
        assert 6e6 < ecef_mag < 7e6, f"ECEF magnitude {ecef_mag} not earth-sized"

        # materials
        assert len(c3m.materials) > 0, "no materials"
        for m in c3m.materials:
            assert len(m.jpeg) > 100, "texture too small"
            if m.is_heif:
                assert m.jpeg[4:8] == b"ftyp", "HEIF missing ftyp box"
            else:
                assert m.jpeg[:2] == b"\xff\xd8", "JPEG missing SOI"

        # meshes
        assert len(c3m.meshes) > 0, "no meshes"
        for mesh in c3m.meshes:
            assert len(mesh.vertices) > 10, "too few vertices"
            assert len(mesh.groups) > 0, "no face groups"
            for g in mesh.groups.values():
                assert len(g.faces) > 0, "empty face group"
                for face in g.faces:
                    assert 0 <= face.a < len(mesh.vertices)
                    assert 0 <= face.b < len(mesh.vertices)
                    assert 0 <= face.c < len(mesh.vertices)

        print(f"  {f.name}: {len(c3m.meshes)} meshes, "
              f"{sum(len(m.vertices) for m in c3m.meshes)} vtx — OK")


if __name__ == "__main__":
    print("Running self-checks...")
    test_auth_signing()
    test_c3m_parse()
    print("All checks passed.")
