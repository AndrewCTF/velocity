#!/usr/bin/env python3
"""Scrape the public Palantir Gotham API docs into a plain-text corpus.

The docs are server-rendered Next.js, so a plain GET returns the prose.
We keep the main article only: everything after the 'Hide sidebar' marker,
which is the last chrome element before page content.
"""
import html
import json
import pathlib
import re
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).parent
OUT = HERE / "gotham-corpus"
OUT.mkdir(exist_ok=True)

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

urls = [
    u.strip()
    for u in (HERE / "all-urls.txt").read_text().splitlines()
    if "/docs/gotham/" in u and "/api/v1/" not in u and "/api/v2/" not in u
]
# Drop bare index pages that carry no prose.
urls = [u for u in urls if u.rstrip("/").count("/") > 5]
print(f"{len(urls)} gotham pages to fetch")


def strip(raw: str) -> str:
    raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.S)
    txt = re.sub(r"<[^>]+>", " ", raw)
    txt = html.unescape(txt)
    txt = re.sub(r"[ \t]+", " ", txt)
    return txt.strip()


index = []
for i, url in enumerate(urls, 1):
    slug = url.replace("https://palantir.com/docs/gotham/", "").strip("/").replace("/", "__") or "index"
    dest = OUT / f"{slug}.txt"
    if dest.exists():
        continue
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"  [{i}] FAIL {slug}: {e}")
        continue

    body = strip(raw)
    # 'Hide sidebar' is the final nav element; article prose follows it.
    if "Hide sidebar" in body:
        body = body.split("Hide sidebar", 1)[1].strip()
    dest.write_text(body, encoding="utf-8")
    index.append({"url": url, "slug": slug, "chars": len(body)})
    if i % 20 == 0:
        print(f"  [{i}/{len(urls)}] {slug} ({len(body)} chars)")
    time.sleep(0.35)  # be polite

(OUT / "_index.json").write_text(json.dumps(index, indent=2))
print(f"done: {len(index)} pages written to {OUT}")
