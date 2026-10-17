#!/usr/bin/env python3
"""Verify public tar1090/readsb front doors WITHOUT calling data endpoints.

Research-only discipline: we never request /data/aircraft.json, /v2/point, or
any other data path.  Liveness + capability is proven from:
  1. DNS A/AAAA resolution
  2. HTTP status + headers of the front door  (/)
  3. The front-door HTML/JS *text* (a static shell), grepped for the
     `data/aircraft.json` string that tar1090/readsb globes always reference.

(3) is structural evidence the instance is wired to serve that path; we never
fetch the path itself.
"""
import concurrent.futures as cf
import json
import re
import subprocess
import sys

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

HOSTS = [h.strip() for h in open(sys.argv[1]) if h.strip() and not h.startswith("#")]


def sh(cmd, t=25):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True,
                              text=True, timeout=t).stdout
    except Exception:
        return ""


def dns_ok(h):
    a = sh(f"getent ahostsv4 {h} 2>/dev/null | awk '{{print $1}}' | sort -u", 12)
    return [x for x in a.split() if x]


def probe(h):
    ips = dns_ok(h)
    r = {"host": h, "ips": ips}
    if not ips:
        r["verdict"] = "NXDOMAIN"
        return r
    # front door only -- never a data path
    hdr = sh(f"curl -sSI -m 20 -A '{UA}' -L --max-redirs 4 https://{h}/ 2>&1", 30)
    code = None
    m = re.findall(r"^HTTP/[\d.]+\s+(\d{3})", hdr, re.M)
    if m:
        code = int(m[-1])
    r["http"] = code
    srv = re.findall(r"^server:\s*(.+)$", hdr, re.I | re.M)
    r["server"] = srv[-1].strip()[:40] if srv else ""
    cf = "cloudflare" in hdr.lower()
    r["cf"] = cf
    if code is None:
        # try plain http
        hdr2 = sh(f"curl -sSI -m 15 -A '{UA}' -L http://{h}/ 2>&1", 22)
        m2 = re.findall(r"^HTTP/[\d.]+\s+(\d{3})", hdr2, re.M)
        r["http"] = int(m2[-1]) if m2 else None
    # fetch the shell HTML only (no data path) and look for the tar1090 marker
    body = sh(f"curl -sSL -m 20 -A '{UA}' https://{h}/ 2>/dev/null | head -c 200000", 30)
    low = body.lower()
    r["bytes"] = len(body)
    r["marker_json"] = "data/aircraft.json" in low or "aircraft.json" in low
    r["marker_tar"] = "tar1090" in low
    r["marker_readsb"] = "readsb" in low or "multimon-ddv" in low
    r["marker_globe"] = "sdr-data" in low or "aircraft.json" in low
    return r


with cf.ThreadPoolExecutor(max_workers=12) as ex:
    results = list(ex.map(probe, HOSTS))

json.dump(results, open("/tmp/tar1090_verify.json", "w"), indent=1)
ok = [r for r in results if r.get("http") in (200, 301, 302, 304)]
print(f"host,http,server,aircraft_json_marker,tar1090_marker,readsb_marker,ips")
for r in sorted(results, key=lambda x: (-(x.get("http") or 0), x["host"])):
    print(f"{r['host']},{r.get('http')},{r.get('server','')},"
          f"{r.get('marker_json')},{r.get('marker_tar')},"
          f"{r.get('marker_readsb')},{','.join(r['ips'][:3])}")
print(f"\nLIVE(200): {sum(1 for r in results if r.get('http') == 200)} / {len(HOSTS)}")
print(f"WITH aircraft.json MARKER: {sum(1 for r in results if r.get('marker_json'))}")