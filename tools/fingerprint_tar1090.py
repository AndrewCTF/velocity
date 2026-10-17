#!/usr/bin/env python3
"""Precisely fingerprint public tar1090/readsb instances -- RESEARCH ONLY.

HARD CONSTRAINT (held throughout): a DATA path is never requested.
  NEVER: /data/aircraft.json, /v2/point, /api/0/*, any /data/*.json
  ONLY :  DNS; the front door (/, /tar1090/, /globe/); and the STATIC assets
          the tar1090 shell itself references via <script src>.

Why that is sufficient evidence for the ask:
  Upstream wiedehopf/tar1090's html/early.js contains exactly one data-path
  literal: `data/aircraft.json` (verified against source).  Modern builds ship
  it CONTENT-HASHED (`early_<md5>.js`), so the shell's own <script src> list
  names the file -- we then read that file's TEXT.  A host serving that hashed
  early.js is, by construction, serving /data/aircraft.json.  We never request
  the data path itself.
  readsb's native equivalent is the same path (/data/aircraft.json).

Auth verdict comes from FRONT-DOOR behaviour only: an auth-walled deployment
redirects / to a login/consent/challenge page; a keyless one serves the globe.
"""
import concurrent.futures as cf
import json
import re
import subprocess
import sys

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
NEEDLE = "data/aircraft.json"
MOUNTS = ["/tar1090/", "/", "/globe/", "/tar1090", "/readsb/"]

AUTH_RE = re.compile(r"login|signin|sign-in|passwort|password|consent|denied|"
                     r"forbidden|unauthor|\bsso\b|oauth|auth/|/auth\b", re.I)
CHAL_RE = re.compile(r"just a moment|checking your browser|attention required|"
                     r"cf-browser-verification|enable javascript and cookies|"
                     r"verify you are human", re.I)
# a real tar1090 shell has these markers; a 404 page does not
SHELL_RE = re.compile(r"dbloader|tar1090|ol-8\.2|aircraft\.json|zstddec", re.I)


def sh(cmd, t=30):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True,
                              timeout=t).stdout
    except Exception:
        return ""


def fetch(url, head=False):
    return sh(f"curl {'-I' if head else '-sSL'} -m 18 -A '{UA}' "
              f"--max-redirs 4 '{url}' 2>/dev/null", 25)


def code_of(h):
    m = re.findall(r"^HTTP/[\d.]+\s+(\d{3})", h, re.M)
    return int(m[-1]) if m else None


def probe(host):
    r = {"host": host}
    seen, ips = set(), []
    for rec in (f"getent ahostsv4 {host}", f"getent ahostsv6 {host}"):
        for l in sh(rec + " 2>/dev/null", 10).splitlines():
            p = l.split()
            if p and p[0] not in seen:
                seen.add(p[0]); ips.append(p[0])
    r["ips"] = ips
    if not ips:
        r["verdict"] = "NXDOMAIN"; return r

    for scheme in ("https", "http"):
        hdr = fetch(f"{scheme}://{host}/", head=True)
        if code_of(hdr) is not None:
            r["scheme"], r["http"] = scheme, code_of(hdr)
            break
    else:
        r["verdict"] = "NO_HTTP"; return r

    srv = re.findall(r"^server:\s*(.+)$", hdr, re.I | re.M)
    r["server"] = srv[-1].strip()[:30] if srv else ""
    r["cloudflare"] = "cloudflare" in hdr.lower()
    loc = " ".join(re.findall(r"^location:\s*(.+)$", hdr, re.I | re.M))
    r["location"] = loc.strip()[:80]
    r["challenge"] = bool(CHAL_RE.search(loc))
    r["authwall"] = bool(AUTH_RE.search(loc))

    # --- locate a REAL tar1090 shell (not a 404 page) ---------------------
    mount = shell = ""
    for path in MOUNTS:
        b = fetch(f"{r['scheme']}://{host}{path}")
        if len(b) > 300 and SHELL_RE.search(b):
            mount, shell = path, b
            break
    if not shell:
        r["verdict"] = "NO_TAR1090_SHELL"; return r
    r["mount"] = mount
    r["title"] = (re.findall(r"<title[^>]*>(.*?)</title>", shell, re.I | re.S)
                  or [""])[0].strip()[:60]
    r["shell_has_needle"] = NEEDLE in shell

    # --- follow the shell's own <script src> list (handles hashed names) ---
    srcs = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', shell, re.I)
    r["n_scripts"] = len(srcs)
    early = [s for s in srcs if re.search(r"(^|/)early[_.]", s)]
    r["early_asset"] = early[0] if early else ""
    needle_src = "shell-html" if r["shell_has_needle"] else None
    if not needle_src:
        for s in srcs:
            if not s.lower().endswith(".js"):
                continue
            u = s if s.startswith("http") else (
                f"{r['scheme']}://{host}{mount}{s}" if s.startswith("/")
                else f"{r['scheme']}://{host}{mount}{s}")
            ab = fetch(u)
            if NEEDLE in ab:
                needle_src = s
                break
    r["needle_asset"] = needle_src or ""
    r["json_ref"] = bool(needle_src)
    r["family"] = "tar1090" if (r["shell_has_needle"] or early
                                or "tar1090" in shell.lower()) else "readsb"
    r["mounted"] = mount != "/"

    if r["challenge"]:
        v = "CLOUDFLARE_CHALLENGED"
    elif r["authwall"]:
        v = "AUTH_WALL"
    elif r["json_ref"]:
        v = "KEYLESS_AIRCRAFT_JSON"
    else:
        v = "TAR1090_NO_MARKER"
    r["verdict"] = v
    return r


hosts = [h.strip() for h in open(sys.argv[1]) if h.strip() and not h.startswith("#")]
with cf.ThreadPoolExecutor(max_workers=10) as ex:
    res = list(ex.map(probe, hosts))
json.dump(res, open("/tmp/tar1090_fp3.json", "w"), indent=1)

order = {"KEYLESS_AIRCRAFT_JSON": 0, "TAR1090_NO_MARKER": 1,
         "CLOUDFLARE_CHALLENGED": 2, "AUTH_WALL": 3}
for r in sorted(res, key=lambda x: (order.get(x.get("verdict"), 9), x["host"])):
    print(f"{r.get('verdict','?'):24s} {r['host']:32s} {str(r.get('http')):4s} "
          f"m={r.get('mount','-'):10s} early={'Y' if r.get('early_asset') else '-'} "
          f"needle={r.get('needle_asset','-')[:34]:34s} {r.get('title','')[:26]}")
good = [r for r in res if r.get("verdict") == "KEYLESS_AIRCRAFT_JSON"]
print(f"\n=== KEYLESS_AIRCRAFT_JSON: {len(good)} ===")
for r in good:
    print(f"  https://{r['host']}/data/aircraft.json")