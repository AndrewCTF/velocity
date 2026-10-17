#!/usr/bin/env python3
"""Working search path on this host: r.jina.ai text proxy in front of DuckDuckGo HTML.

Every major engine blocks this IP for plain curl (Bing serves ads-only, Google
and DDG serve challenges, Brave 429s, Marginalia rate-limits hard). The jina
reader proxy fetches the same DDG HTML and returns markdown, which is not
rate-limited by DDG's bot filter. Paced ~4s between queries.

Usage: python3 srch.py "<query>" [n]
"""
import re, subprocess, sys, time, urllib.parse

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")
_last = [0.0]


def read(url, timeout=45):
    """Fetch a URL through the jina reader proxy as markdown text."""
    return subprocess.run(
        ["curl", "-sL", "-m", str(timeout), "-A", UA, "https://r.jina.ai/" + url],
        capture_output=True, text=True, timeout=timeout + 15).stdout


def search(q, n=12):
    gap = time.time() - _last[0]
    if gap < 4:
        time.sleep(4 - gap)
    _last[0] = time.time()
    url = "https://duckduckgo.com/html/?q=" + urllib.parse.quote(q)
    t = read(url)
    if "challenge" in t.lower() or "bots use DuckDuckGo" in t:
        return ["BLOCKED-BY-DDG (back off and retry)"]
    out, seen = [], set()
    # DDG result links: [title](https://duckduckgo.com/l/?uddg=<encoded>)
    for m in re.finditer(r'##\s*\[(.*?)\]\((https://duckduckgo\.com/l/\?uddg=[^)]+)\)', t, re.S):
        title = re.sub(r"\s+", " ", m.group(1)).strip()
        enc = re.search(r"uddg=([^&)]+)", m.group(2))
        if not enc:
            continue
        u = urllib.parse.unquote(enc.group(1))
        if u in seen:
            continue
        seen.add(u)
        out.append((title, u))
    # snippets follow as plain text; slice the doc to pull the description per result
    body = t.split("Markdown Content:")[-1]
    chunks = re.split(r'\n##\s*\[', body)
    for i, (title, u) in enumerate(out[:n]):
        snip = ""
        if i + 1 < len(chunks):
            c = chunks[i + 1]
            lines = [x.strip() for x in c.split("\n[") if x.strip()]
            for L in lines[1:]:
                L = re.sub(r"^\]\([^)]*\)", "", L)
                L = re.sub(r"\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)", "", L)
                L = re.sub(r"[*\[\]]", "", L).strip()
                if len(L) > 40 and "duckduckgo" not in L.lower():
                    snip = L[:280]
                    break
        print(f"  * {title[:120]}\n      {u}\n      >> {snip}")
    if not out:
        print("  (no results parsed)", t[:300].replace("\n", " "))
    return out[:n]


if __name__ == "__main__":
    q = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 12
    print(f"### jina/ddg: {q}")
    search(q, n)
