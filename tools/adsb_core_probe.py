
#!/usr/bin/env python3
"""Measure ocean reach of a keyless BULK parquet ADS-B archive over HTTP ranges.

Self-contained: inlines the VALIDATED land-mask semantics from
tools/adsb_ocean_probe.py (Natural Earth 110m, even-odd ray cast, half-open
[y1,y2) edges, LAND_HALO_DEG=2.5) but does not import that module, because it
pulls in httpx which is absent from this research venv.

Mask semantics are validated against the same 12 control points used in
docs/adsb-keyless-ocean-coverage.md before any number below is trusted.
"""
from __future__ import annotations
import io, json, subprocess, sys, urllib.request
from collections import Counter
import pyarrow.parquet as pq

LAND_HALO_DEG = 2.5
_LAND_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
             "master/geojson/ne_110m_land.geojson")
_LAND_CACHE = "/tmp/ne_110m_land.geojson"

BASINS = {
 "N Atlantic (mid)": (40.0, 55.0, -50.0, -20.0),
 "S Atlantic": (-30.0, -5.0, -25.0, 5.0),
 "N Pacific (mid)": (30.0, 45.0, -170.0, -140.0),
 "Mid Pacific (equat)": (-10.0, 10.0, -160.0, -120.0),
 "S Pacific (empty)": (-40.0, -20.0, -130.0, -100.0),
 "Indian Ocean (S)": (-35.0, -10.0, 60.0, 90.0),
 "Southern Ocean": (-60.0, -45.0, 20.0, 80.0),
 "Arctic Ocean": (82.0, 89.0, -60.0, 60.0),
}

def load_land_rings():
    try:
        raw = open(_LAND_CACHE, "rb").read()
    except FileNotFoundError:
        req = urllib.request.Request(_LAND_URL, headers={"User-Agent": "research"})
        raw = urllib.request.urlopen(req, timeout=40).read()
        open(_LAND_CACHE, "wb").write(raw)
    gj = json.loads(raw)
    rings = []
    def walk(g):
        if g.get("type") == "Polygon":
            for r in g["coordinates"]:
                rings.append([[float(x), float(y)] for x, y in r])
        elif g.get("type") == "MultiPolygon":
            for p in g["coordinates"]:
                for r in p:
                    rings.append([[float(x), float(y)] for x, y in r])
    for f in gj.get("features", []):
        walk(f["geometry"])
    return rings

def point_in_ring(lon, lat, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if (y1 <= lat < y2) or (y2 <= lat < y1):
            x_at = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < x_at:
                inside = not inside
    return inside

def on_land(lon, lat, rings):
    return any(point_in_ring(lon, lat, r) for r in rings)

def near_land(lon, lat, rings, halo=LAND_HALO_DEG):
    if on_land(lon, lat, rings):
        return True
    for d in (halo, -halo):
        for step in range(-6, 7):
            slat = lat + d
            if abs(slat) > 89.5:
                continue
            slon = (lon + step * halo / 6.0 + 180.0) % 360.0
            if on_land(slon, slat, rings):
                return True
    return False

def validate(rings):
    """12 control points from the repo's validated mask."""
    pts = [
      ("London",-0.13,51.51,True),("Sahara",10.0,23.0,True),("Tokyo",139.7,35.7,True),
      ("Amazon",-60.0,-3.0,True),("Mid-Pacific",-150.0,0.0,False),("Mid-Atlantic",-30.0,20.0,False),
      ("Singapore",103.8,1.3,True),("Antarctica",0.0,-80.0,True),("Sahara-deep",15.0,25.0,True),
      ("Australia",134.0,-25.0,True),("S-Atlantic",-20.0,-30.0,False),("Himalaya",86.9,27.9,True),
    ]
    ok = 0; bad = []
    for name, lon, lat, expect_land in pts:
        got = on_land(lon, lat, rings)
        if got == expect_land: ok += 1
        else: bad.append((name, got, expect_land))
    return ok, len(pts), bad

class HttpRangeFile(io.RawIOBase):
    def __init__(self, url):
        self.url = url; self.pos = 0; self._size = None; self._c = None
    def _sz(self):
        if self._size is None:
            out = subprocess.run(['bash','-c',
                f'curl -sIL "{self.url}" | grep -i "^content-length" | tail -1 | tr -dc "0-9"'],
                capture_output=True, text=True).stdout.strip()
            self._size = int(out or 0)
        return self._size
    def seekable(self): return True
    def readable(self): return True
    def seek(self, o, w=0):
        self.pos = o if w == 0 else (self.pos + o if w == 1 else self._sz() + o)
        return self.pos
    def tell(self): return self.pos
    def read(self, n=-1):
        sz = self._sz()
        if n is None or n < 0: n = sz - self.pos
        if n == 0 or self.pos >= sz: return b""
        end = min(self.pos + n, sz) - 1
        if self._c is None or self._c[0] != self.pos or self._c[1] != end:
            p = f"/tmp/rg_{self.pos}_{end}.bin"
            subprocess.run(['bash','-c', f'curl -sL -r {self.pos}-{end} -o {p} "{self.url}"'], check=True)
            self._c = (self.pos, end, open(p, "rb").read())
        d = self._c[2]; self.pos += len(d); return d
    def readinto(self, b):
        d = self.read(len(b)); b[:len(d)] = d; return len(d)

def probe(url, label, ngroups=6, offset=0):
    f = HttpRangeFile(url)
    pf = pq.ParquetFile(io.BufferedReader(f, buffer_size=1 << 20))
    total_rg = pf.metadata.num_row_groups
    rgs = [i for i in range(offset, min(offset + ngroups, total_rg))]
    cols = [c for c in ["icao","timestamp","latitude","longitude","source"] if c in pf.schema_arrow.names]
    tbl = pf.read_row_groups(rgs, columns=cols)
    rings = load_land_rings()
    lat = tbl.column("latitude").to_pylist()
    lon = tbl.column("longitude").to_pylist()
    icao = tbl.column("icao").to_pylist() if "icao" in cols else [None]*len(lat)
    ts = tbl.column("timestamp").to_pylist() if "timestamp" in cols else [None]*len(lat)
    src = tbl.column("source").to_pylist() if "source" in cols else [None]*len(lat)
    N = len(lat)
    oadj = deep = 0
    basins = {k: 0 for k in BASINS}
    uniq = set(); uniq_oadj = set(); uniq_deep = set()
    tsmin = tsmax = None
    for i in range(N):
        if lat[i] is None or lon[i] is None: continue
        la = float(lat[i]); lo = float(lon[i])
        uniq.add(icao[i])
        if ts[i] is not None:
            tsmin = ts[i] if tsmin is None or ts[i] < tsmin else tsmin
            tsmax = ts[i] if tsmax is None or ts[i] > tsmax else tsmax
        if near_land(lo, la, rings): continue
        oadj += 1; uniq_oadj.add(icao[i])
        if not near_land(lo, la, rings, halo=LAND_HALO_DEG):
            deep += 1; uniq_deep.add(icao[i])
        for k, (a, b, c, d) in BASINS.items():
            if a <= la <= b and c <= lo <= d: basins[k] += 1
    print("### " + label)
    print("  row groups sampled: %s of %d" % (rgs, total_rg))
    print("  rows sampled: %d  (%.3f%% of the day's %d)" % (N, 100*N/pf.metadata.num_rows, pf.metadata.num_rows))
    print("  time span in sample: %s .. %s" % (tsmin, tsmax))
    print("  unique ICAO in sample: %d" % len(uniq))
    print("  ocean-adjacent fixes: %d (%.3f%%)" % (oadj, 100*oadj/max(N,1)))
    print("  DEEP-OCEAN fixes:    %d (%.5f%%)" % (deep, 100*deep/max(N,1)))
    print("  unique ICAO ocean-adjacent: %d ; DEEP unique: %d" % (len(uniq_oadj), len(uniq_deep)))
    print("  basins: " + json.dumps(basins))
    print("  top sources: %s" % (Counter(src).most_common(6),))
    print()
    return dict(label=label, rg=rgs, rows_sampled=N, rows_day=pf.metadata.num_rows,
                unique=len(uniq), ocean_adj=oadj, deep=deep, uniq_deep=len(uniq_deep),
                uniq_ocean_adj=len(uniq_oadj), basins=basins)

if __name__ == "__main__":
    rings = load_land_rings()
    ok, tot, bad = validate(rings)
    print("MASK VALIDATION: %d/%d control points correct; bad=%s" % (ok, tot, bad))
    if ok != tot:
        sys.exit("MASK INVALID -- refusing to report")
    print()
    out = []
    for url, label, ng, off in [
      ("https://huggingface.co/datasets/juliangehring/adsb-core/resolve/main/data/core/year=2026/date=2026-08-29/adsb_core.parquet",
       "adsb-core 2026-08-29 rg0-5", 6, 0),
      ("https://huggingface.co/datasets/juliangehring/adsb-core/resolve/main/data/core/year=2026/date=2026-08-29/adsb_core.parquet",
       "adsb-core 2026-08-29 rg50-55", 6, 50),
      ("https://huggingface.co/datasets/juliangehring/adsb-core/resolve/main/data/core/year=2024/date=2024-06-15/adsb_core.parquet",
       "adsb-core 2024-06-15 rg0-5", 6, 0),
    ]:
        out.append(probe(url, label, ng, off))
    open("/tmp/adsb_core_probe.json","w").write(json.dumps(out, indent=1))
    print("wrote /tmp/adsb_core_probe.json")
