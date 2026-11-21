#!/usr/bin/env python3
"""Build apps/api/app/data/osm_military.json.gz from a Military Features Atlas
snapshot (OpenStreetMap ``military=*`` / ``landuse=military`` features, ODbL).

The atlas ships two columnar files, ``points.json`` (lat/lon/category/status/
country per feature) and ``meta.json`` (name/region/place/operator/start year/
OSM type+id). Save both into a cache dir by hand; this script never fetches
(the site refuses non-browser clients and is marked noindex).

    python3 scripts/build_osm_military.py --cache-dir ~/.cache/osint-places/atlas

The output stays columnar (gzip) so the repo carries ~5 MB, not ~60 MB of
row JSON; ``app.places.osm_military()`` expands it to rows on first use.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "apps/api/app/data/osm_military.json.gz"


def slug(label: str) -> str:
    """'Military (unspecified)' -> 'unspecified', 'Danger area' -> 'danger_area'."""
    s = re.sub(r"^military\s*\((.*)\)$", r"\1", label.strip(), flags=re.I)
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def build(points: dict, meta: dict) -> dict:
    n = len(points["lat"])
    cols = ("lon", "cat", "st", "cty")
    mcols = ("reg", "np", "nm", "op", "yr", "ot", "oid")
    for k in cols:
        assert len(points[k]) == n, k
    for k in mcols:
        assert len(meta[k]) == n, k
    return {
        "source": "OpenStreetMap contributors (ODbL), via Military Features Atlas snapshot",
        "categories": [slug(c) for c in points["cats"]],
        "category_labels": points["cats"],
        "statuses": points["statuses"],
        "countries": points["countries"],
        "regions": meta["regions"],
        "places": meta["places"],
        "operators": meta["operators"],
        # 5 decimals = ~1 m; the atlas centroids carry no more real precision.
        "lat": [round(v, 5) for v in points["lat"]],
        "lon": [round(v, 5) for v in points["lon"]],
        **{k: points[k] for k in ("cat", "st", "cty")},
        **{k: meta[k] for k in mcols},
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", type=Path, required=True, help="holds points.json + meta.json")
    args = ap.parse_args()
    points = json.loads((args.cache_dir / "points.json").read_text(encoding="utf-8"))
    meta = json.loads((args.cache_dir / "meta.json").read_text(encoding="utf-8"))
    out = build(points, meta)
    raw = json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    OUT.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    print(f"wrote {OUT} rows={len(out['lat'])} bytes={OUT.stat().st_size}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    assert slug("Military (unspecified)") == "unspecified"
    assert slug("Danger area") == "danger_area"
    sys.exit(main())
