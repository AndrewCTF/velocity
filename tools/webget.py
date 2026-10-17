#!/usr/bin/env python3
"""Fetch documentation pages (NOT data endpoints) and print readable text.

Used for OSINT source-selection research: we read provider *documentation*
pages to determine keylessness, licensing and archival availability. We
deliberately do not call ADS-B live/historical *data* endpoints here.

Usage:
    python tools/webget.py URL [URL ...] [--chars N]
"""
import hashlib
import html
import re
import sys
import urllib.error
import urllib.request

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)
RAW = "research/raw/bulk-adsb-2026-10"

DROP = re.compile(
    r"<(script|style|noscript|svg|head)[^>]*>.*?</\1>", re.S | re.I
)


def to_text(raw: str) -> str:
    s = DROP.sub(" ", raw)
    s = re.sub(r"<(br|/p|/div|/li|/tr|/h[1-6])[^>]*>", "\n", s, flags=re.I)
    s = re.sub(r"<a [^>]*href=\"([^\"]+)\"[^>]*>", r" [\1] ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\xa0]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


def fetch(url: str, timeout: int = 45) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001
        return -1, f"ERR {type(e).__name__}: {e}"


def main() -> int:
    argv = sys.argv[1:]
    chars = 6000
    if "--chars" in argv:
        i = argv.index("--chars")
        chars = int(argv[i + 1])
        del argv[i : i + 2]
    argv = [a for a in argv if not a.startswith("--")]

    import os

    os.makedirs(RAW, exist_ok=True)
    rc = 0
    for url in argv:
        status, raw = fetch(url)
        name = hashlib.md5(url.encode()).hexdigest()[:8] + ".txt"
        text = f"### URL: {url}\n### HTTP: {status}\n\n" + to_text(raw)
        with open(os.path.join(RAW, name), "w") as fh:
            fh.write(text)
        print("=" * 100)
        print(f"HTTP {status}  {url}  -> {name}  ({len(text)} chars)")
        print(text[:chars])
        if status != 200:
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
