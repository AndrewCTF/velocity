"""_parts.py — the shared grammar every page composes from.

The point of putting this in one module: the previous set had panels that were
convincing on one page and thin on another, because each page hand-wrote its
own markup. Here a panel is a function, so it renders the same everywhere or it
renders wrong everywhere.

Nothing in this file emits an emoji. Icons go through `ic()`, which references
_sprite.svg, which _icons.mjs builds from lucide-react's own path data.
"""

from __future__ import annotations

import random
from pathlib import Path

HERE = Path(__file__).parent

# Fixed seed: a rebuild must produce byte-identical pages, or screenshot diffs
# are noise and the gate cannot tell a regression from a reshuffle.
RNG = random.Random(20260801)


def sprite() -> str:
    return (HERE / "_sprite.svg").read_text().strip()


def ic(name: str, cls: str = "") -> str:
    """One icon. viewBox is repeated on the <svg> because the gate checks the
    referencing element, not just the <symbol>."""
    c = f"ic {cls}".strip()
    return f'<svg class="{c}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-{name}"/></svg>'


def page(title: str, body: str, cls: str = "") -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="console.css">
</head>
<body class="{cls}">
{sprite()}
{body}
</body>
</html>
"""


# ── Marks ────────────────────────────────────────────────────────────────────
# Every count gets one. `part` is the slice matching the current filter, `total`
# the whole; the bar shows both, which is the thing a bare number cannot do.

def bar(part: float, total: float, cls: str = "", width: str = "") -> str:
    tot_pct = max(1.0, min(100.0, total * 100))
    part_pct = max(0.0, min(100.0, part * 100))
    w = f" {width}" if width else ""
    inner = f'<i style="width:{tot_pct:.1f}%" class="{cls}"></i>'
    if part_pct > 0:
        inner += f'<i class="part" style="width:{part_pct:.1f}%"></i>'
    return f'<span class="bar{w}">{inner}</span>'


def count(text: str, cls: str = "") -> str:
    c = f"count {cls}".strip()
    return f'<span class="{c}">{text}</span>'


def mark(text: str, part: float, total: float, cls: str = "", width: str = "") -> str:
    """A count and its bar, together. The gate rejects one without the other."""
    return f'<span class="mark">{count(text)}{bar(part, total, cls, width)}</span>'


def spark(values: list[float], cls: str = "", w: int = 84, h: int = 16) -> str:
    lo, hi = min(values), max(values)
    rng = (hi - lo) or 1.0
    n = len(values)
    pts = " ".join(
        f"{i / (n - 1) * w:.1f},{h - 1 - (v - lo) / rng * (h - 2):.1f}"
        for i, v in enumerate(values)
    )
    area = f"{pts} {w},{h} 0,{h}"
    c = f"spark {cls}".strip()
    return (
        f'<svg class="{c}" viewBox="0 0 {w} {h}" preserveAspectRatio="none" aria-hidden="true">'
        f'<polyline class="area" points="{area}"/><polyline points="{pts}"/></svg>'
    )


def dots(states: list[str]) -> str:
    return '<span class="dots">' + "".join(f'<span class="{s}"></span>' for s in states) + "</span>"


def meter(pct: float) -> str:
    return f'<span class="meter"><i style="width:{pct:.0f}%"></i></span>'


# ── Rows ─────────────────────────────────────────────────────────────────────

def sect(label: str, right: str = "", icon: str | None = None) -> str:
    left = ic(icon, "ic-sm") if icon else ic("chevron-down", "ic-sm")
    r = f'<span class="n">{right}</span>' if right else ""
    return f'<div class="sect">{left}<span>{label}</span><span class="sp"></span>{r}</div>'


def row(name: str, *, sub: str = "", icon: str = "circle", tail: str = "",
        sel: bool = False, on: bool = False) -> str:
    cls = "row" + (" two" if sub else "") + (" sel" if sel else "") + (" on" if on else "")
    body = f'<span class="nm">{name}{f"<span class=sub>{sub}</span>" if sub else ""}</span>'
    return f'<div class="{cls}">{ic(icon, "ic-sm")}{body}{tail}</div>'


def kv(k: str, v: str, cls: str = "") -> str:
    return f'<div class="kv"><dt>{k}</dt><dd class="{cls}">{v}</dd></div>'


def switch(on: bool = True) -> str:
    return f'<span class="sw{" on" if on else ""}"><i></i></span>'


# ── Object card, with its thumbnail ──────────────────────────────────────────
# The silhouettes are the app's own, from apps/web/src/globe/icons.ts. Reusing
# them means "put a picture on every object" is a wiring job later, not new art.

SIL = {
    "airliner": "M12 1.5 L13.6 11.3 L22.5 14 L22.5 16 L13.6 14.2 L13.6 19.5 L16 21 L16 22.5 L12 21.5 L8 22.5 L8 21 L10.4 19.5 L10.4 14.2 L1.5 16 L1.5 14 L10.4 11.3 Z",
    "private": "M12 3 L13.1 11.6 L19.5 13.5 L19.5 15 L13.1 13.9 L13.1 18.5 L15 19.7 L15 20.8 L12 20 L9 20.8 L9 19.7 L10.9 18.5 L10.9 13.9 L4.5 15 L4.5 13.5 L10.9 11.6 Z",
    "glider": "M11.6 2 L12.4 2 L12.7 11 L23 12 L23 13 L12.7 13.4 L12.7 19.2 L14.6 20.4 L14.6 21.5 L12 21 L9.4 21.5 L9.4 20.4 L11.3 19.2 L11.3 13.4 L1 13 L1 12 L11.3 11 Z",
    "vessel": "M12 2 L17 8 L17 19 L15 22 L9 22 L7 19 L7 8 Z",
    "cargo": "M12 1.5 L17 6 L17 21 L15.5 22.5 L8.5 22.5 L7 21 L7 6 Z",
}
COLOR = {
    "airliner": "var(--d-airliner)", "private": "var(--d-private)",
    "helicopter": "var(--d-heli)", "glider": "var(--d-glider)",
    "military": "var(--d-mil)", "emergency": "var(--d-emerg)",
    "cargo": "var(--d-cargo)", "tanker": "var(--d-tanker)",
}


def silhouette(kind: str, color: str | None = None, rotate: int | None = None) -> str:
    """Top-down category silhouette, the same geometry globe/icons.ts bakes into
    the map billboards."""
    if kind == "helicopter":
        d = ('<line x1="2" y1="12" x2="22" y2="12" stroke="{c}" stroke-width="1"/>'
             '<ellipse cx="12" cy="12" rx="3" ry="5" fill="{c}" stroke="#000" stroke-width=".75"/>'
             '<line x1="12" y1="17" x2="12" y2="21" stroke="{c}" stroke-width="1.2"/>')
        inner = d.format(c=color or COLOR["helicopter"])
    else:
        path = SIL.get(kind, SIL["airliner"])
        c = color or COLOR.get(kind, "var(--txt-2)")
        inner = f'<path d="{path}" fill="{c}" stroke="#000" stroke-width=".75" stroke-linejoin="round"/>'
    rot = f' style="transform:rotate({rotate}deg)"' if rotate is not None else ""
    return f'<svg class="thumb-art" viewBox="0 0 24 24" aria-hidden="true"{rot}>{inner}</svg>'


def thumb(kind: str = "airliner", color: str | None = None, img: str | None = None,
          icon: str | None = None) -> str:
    if img:
        inner = f'<img src="{img}" alt="">'
    elif icon:
        inner = ic(icon, "ic-lg")
    else:
        inner = silhouette(kind, color)
    return f'<div class="thumb">{inner}</div>'


def obj_card(title: str, sub: str, *, kind: str = "airliner", color: str | None = None,
             img: str | None = None, icon: str | None = None, tail: str = "",
             sel: bool = False) -> str:
    cls = "obj-card" + (" sel" if sel else "")
    return (
        f'<div class="{cls}">{thumb(kind, color, img, icon)}'
        f'<div class="obj-main"><div class="obj-t">{title}</div>'
        f'<div class="obj-s">{sub}</div></div>{tail}</div>'
    )


# ── Chrome ───────────────────────────────────────────────────────────────────

MENUS = ["File", "Edit", "View", "Collect", "Exploration", "Window", "Help"]


def titlebar(doc: str = "Baltic approaches watch", contacts: str = "13,204",
             fps: str = "58") -> str:
    menu = "".join(f"<button>{m}</button>" for m in MENUS)
    trend = spark([31, 33, 30, 36, 31, 37, 42, 34, 44, 39, 45, 49], w=40, h=12)
    return f"""<header class="titlebar">
  <span class="brand">{ic('hexagon')}Velocity</span>
  <nav class="menu" aria-label="Application">{menu}</nav>
  <span class="saved">{ic('check', 'ic-sm')}Saved</span>
  <span class="doctitle"><i class="swatch"></i>{doc}{ic('star', 'ic-sm')}{ic('chevron-down', 'ic-sm')}</span>
  <span class="tb-spacer"></span>
  <span class="tb-item">{ic('plus', 'ic-sm')}</span>
  <span class="tb-item">{ic('share', 'ic-sm')}Share</span>
  <span class="tb-item" title="Contacts held, last 12 minutes">
    <span class="tb-num">{contacts}</span>{trend}</span>
  <span class="tb-item" title="Render frequency, last 60 samples">
    <span class="tb-num">{fps} fps</span>{spark([52, 55, 58, 57, 59, 56, 58, 60, 58, 57, 59, 58], 'ok', 40, 12)}</span>
  <span class="clas">{ic('shield', 'ic-sm')}UNCLAS</span>
  <span class="search" title="Find objects and locations">{ic('search', 'ic-sm')}<span class="lbl-text">Find objects and locations</span></span>
</header>"""


def tabstrip(active: str = "Layers", tabs: list[tuple[str, str, str]] | None = None) -> str:
    tabs = tabs or [
        ("Layers", "layers", "18 of 64"),
        ("Find", "search", ""),
        ("Histogram", "chart", "6"),
        ("Info", "info", "2"),
        ("Series", "chart-line", "5"),
    ]
    out = []
    for label, icon, badge in tabs:
        sel = "true" if label == active else "false"
        b = f'<span class="badge">{badge}</span>' if badge else ""
        out.append(f'<button class="tab" aria-selected="{sel}">{ic(icon, "ic-sm")}{label}{b}</button>')
    return (f'<div class="tabs" role="tablist">{"".join(out)}<span class="sp"></span>'
            f'<button class="tab" aria-selected="false" aria-label="Add panel">{ic("plus", "ic-sm")}</button></div>')


def panel_head(title: str, tools: str = "") -> str:
    return (f'<div class="panel-head"><span class="panel-title">{title}</span>'
            f'<span class="sp"></span>{tools}'
            f'<button class="iconbtn" aria-label="Close panel">{ic("x", "ic-sm")}</button></div>')


def panel_tools(*extra: str) -> str:
    base = (f'<button class="iconbtn" aria-label="Sort">{ic("chart", "ic-sm")}</button>'
            f'<button class="iconbtn" aria-label="Collapse all">{ic("minus", "ic-sm")}</button>'
            f'<span class="sp"></span>' + "".join(extra) +
            f'<button class="iconbtn" aria-label="Search in panel">{ic("search", "ic-sm")}</button>')
    return f'<div class="panel-tools">{base}</div>'


def state(kind: str, title: str, body: str, icon: str) -> str:
    return (f'<div class="state {kind}">{ic(icon, "ic-xl")}<h4>{title}</h4>'
            f'<p>{body}</p></div>')


def banner(kind: str, icon: str, text: str) -> str:
    return f'<div class="banner {kind}">{ic(icon, "ic-sm")}<span>{text}</span></div>'


# ── The action bar: the query, rendered as English ───────────────────────────
# Palantir's query vocabulary is eq / and / or / not / keyword / lt / gt / lte /
# gte / geoPointWithin, and Object Explorer prints it as a sentence with the
# operator's choices as underlined tokens.

def actionbar(sentence: str, primary: str = "Add to filter path") -> str:
    return f"""<div class="actionbar">
  <button class="btn gho sm">{ic('filter', 'ic-sm')}Filter contact type{ic('chevron-down', 'ic-sm')}</button>
  <span class="sentence">{sentence}</span>
  <span class="sp"></span>
  <button class="btn gho sm">Clear selection</button>
  <button class="btn pri sm">{ic('plus', 'ic-sm')}{primary}</button>
</div>"""
