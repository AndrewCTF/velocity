# Country label candidates: Natural Earth 1:50m admin-0 (public domain). For each
# country, one interior point per 1-degree cell (the 0.25-degree sample nearest the
# cell's inside mean), plus NE's own LABEL_X/LABEL_Y.
# Output rows: [name, rank, [lon*8, lat*8, ...] (eighth degrees, integers), ADM0_A3].
# Run: python3 -I countryLabels.gen.py <ne_50m_admin_0.geojson> countryLabels.json
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
def rings(g):
    if g['type'] == 'Polygon': return [g['coordinates']]
    return g['coordinates']
def inside(poly, x, y):
    c = False
    for ring in poly:
        n = len(ring); j = n - 1
        for i in range(n):
            xi, yi = ring[i]; xj, yj = ring[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: c = not c
            j = i
    return c
out = []
for f in d['features']:
    p = f['properties']; name = p.get('NAME') or p['ADMIN']
    lab = name if len(name) <= 12 else (p.get('ABBREV') or name)
    polys = rings(f['geometry'])
    pts = []
    for poly in polys:
        xs = [c[0] for c in poly[0]]; ys = [c[1] for c in poly[0]]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        x = (int(x0 * 4) + 0.5) / 4
        while x <= x1:
            y = (int(y0 * 4) + 0.5) / 4
            while y <= y1:
                if inside(poly, x, y): pts.append((x, y))
                y += 0.25
            x += 0.25
    cells = {}
    for x, y in pts: cells.setdefault((int((x + 180) // 1), int((y + 90) // 1)), []).append((x, y))
    cand = [(p['LABEL_X'], p['LABEL_Y'])]
    for cp in cells.values():
        mx = sum(a for a, _ in cp) / len(cp); my = sum(b for _, b in cp) / len(cp)
        cand.append(min(cp, key=lambda q: (q[0] - mx) ** 2 + (q[1] - my) ** 2))
    flat = [round(v * 8) for c in cand for v in c]
    out.append([lab.upper(), p.get('LABELRANK') or 9, flat, p.get('ADM0_A3') or p.get('ISO_A3') or ''])
out.sort(key=lambda r: r[1])
open(dst, 'w').write(json.dumps(out, separators=(',', ':'), ensure_ascii=False))
print(len(out), sum(len(r[2]) // 2 for r in out))
