"""Who flew near a point: python near.py <day_dir> <lat> <lon> <radius_km> [max_alt_ft]  -> aircraft/positions by type."""
import gzip, json, math, sys
from collections import Counter
from multiprocessing import Pool
from pathlib import Path
day = Path(sys.argv[1]); lat0, lon0, rkm = map(float, sys.argv[2:5]); maxalt = float(sys.argv[5]) if len(sys.argv) > 5 else 1e9
dlat = rkm / 111.0; dlon = rkm / (111.0 * math.cos(math.radians(lat0)))
def one(p):
    raw = p.read_bytes(); raw = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    try: d = json.loads(raw)
    except ValueError: return None
    n = 0
    for r in d.get("trace") or []:
        if r[1] is None or abs(r[1] - lat0) > dlat or abs(r[2] - lon0) > dlon: continue
        alt = 0 if r[3] == "ground" else (r[3] or 0)
        if alt > maxalt: continue
        if math.hypot((r[1] - lat0) * 111, (r[2] - lon0) * 111 * math.cos(math.radians(lat0))) <= rkm: n += 1
    return (d.get("desc") or d.get("t") or "unknown", d.get("r") or d["icao"], n) if n else None
if __name__ == "__main__":
    with Pool() as pool: hits = [h for h in pool.imap_unordered(one, (p for p in (day / "traces").rglob("*") if p.is_file()), chunksize=64) if h]
    by = Counter(); ac = Counter()
    for desc, reg, n in hits: by[desc] += n; ac[desc] += 1
    print(f"{len(hits)} aircraft, {sum(by.values()):,} positions within {rkm} km below {maxalt:.0f} ft")
    for desc, n in by.most_common(8): print(f"  {n:>7,} pos  {ac[desc]:>3} ac  {desc}")
    for desc, reg, n in sorted(hits, key=lambda h: -h[2])[:6]: print(f"  top: {reg} {desc} {n:,}")
