#!/usr/bin/env python3
"""Generate gotham-console.html: the Velocity console rebuilt with Gotham's
actual structural grammar.

Why a generator and not hand-written HTML: the four states (loading, empty,
error, degraded) are the SAME console with one region swapped. Authoring them by
hand guarantees they drift apart, which is exactly how "four states per surface"
turns into one state and three sketches.

Every metric used here is measured; see gotham.css for the derivation table and
_calibrate.py for the method.
"""
import pathlib

HERE = pathlib.Path(__file__).parent
OUT = HERE / "gotham-console.html"

# ── Icon sprite ─────────────────────────────────────────────────────────────
# Each symbol carries its own viewBox AND every <svg> emits one. The earlier
# mockups referenced 24-unit symbols from <svg> elements with no viewBox, so
# every icon in the set rendered only its top-left 15x15 corner.
ICONS = {
    "diamond": "M12 2l10 10-10 10L2 12z",
    "layers": "M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5",
    "search": "M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4",
    "chart": "M4 20V10M10 20V4M16 20v-7M22 20H2",
    "info": "M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5v.5",
    "check": "M4 12l5 5L20 6",
    "star": "M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.1-5.6-3-5.6 3 1.2-6.1L3 9.6l6.3-.8z",
    "chev": "M8 5l7 7-7 7",
    "chevd": "M5 8l7 7 7-7",
    "shield": "M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z",
    "share": "M4 12v7h16v-7M12 3v12M8 7l4-4 4 4",
    "screen": "M3 4h18v12H3zM8 20h8",
    "plus": "M12 5v14M5 12h14",
    "globe": "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
    "graph": "M6 6a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM18 4a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM17 15a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 8.5l8-2M8 11l8 5",
    "grid": "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    "doc": "M6 2h8l4 4v16H6zM14 2v4h4",
    "clock": "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3.5 2",
    "target": "M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8zM12 11v2",
    "video": "M3 6h12v12H3zM15 10l6-3v10l-6-3",
    "inbox": "M3 13h5l2 3h4l2-3h5M3 13l3-9h12l3 9v7H3z",
    "chat": "M4 4h16v11H9l-5 4z",
    "flask": "M9 3v6L4 20h16L15 9V3M8 3h8",
    "hand": "M9 11V5.5a1.5 1.5 0 013 0V11M12 11V4.5a1.5 1.5 0 013 0V11M15 11V6.5a1.5 1.5 0 013 0V13c0 4-2.5 7-6.5 7S6 17.5 6 14l-1-3.5a1.4 1.4 0 012.4-1.4L9 11",
    "marquee": "M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4",
    "around": "M12 3a9 9 0 100 18M12 8a4 4 0 100 8M19 5l3-3M22 2v4h-4",
    "draw": "M4 20l4-1 11-11-3-3L5 16z",
    "camera": "M4 7h4l1.5-2h5L16 7h4v12H4zM12 16a3.5 3.5 0 100-7 3.5 3.5 0 000 7z",
    "ruler": "M3 15L15 3l6 6L9 21zM8 10l2 2M11 7l2 2M5 13l2 2",
    "pin": "M12 21s7-6.5 7-12a7 7 0 10-14 0c0 5.5 7 12 7 12zM12 7a2.5 2.5 0 100 5 2.5 2.5 0 000-5z",
    "trash": "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14",
    "pause": "M8 5v14M16 5v14",
    "filter": "M3 5h18l-7 8v6l-4 2v-8z",
    "warn": "M12 3l9 17H3zM12 9v5M12 17v.5",
    "alert": "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v6M12 16v.5",
    "cross": "M5 5l14 14M19 5L5 19",
    "refresh": "M20 5v5h-5M4 19v-5h5M5 10a7.5 7.5 0 0113-3M19 14a7.5 7.5 0 01-13 3",
    "eye": "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 9a3 3 0 100 6 3 3 0 000-6z",
    "empty": "M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10",
    "slider": "M4 8h10M18 8h2M4 16h4M12 16h8M16 5v6M8 13v6",
    "plane": "M12 2c1 0 1.6 1.6 1.8 4.4l.2 3.6 7 2.7v2l-7-1.3.1 5 2 1v1.5l-4.1-.9-4.1.9V19l2-1 .1-5-7 1.3v-2l7-2.7.2-3.6C10.4 3.6 11 2 12 2z",
}


def sprite():
    syms = "".join(
        f'<symbol id="i-{k}" viewBox="0 0 24 24">'
        f'<path d="{v}" fill="none" stroke="currentColor" stroke-width="1.6" '
        f'stroke-linecap="round" stroke-linejoin="round"/></symbol>'
        for k, v in ICONS.items()
    )
    return f'<svg width="0" height="0" style="position:absolute" aria-hidden="true">{syms}</svg>'


def ico(name, cls=""):
    c = f' class="{cls}"' if cls else ""
    return f'<svg{c} viewBox="0 0 24 24" aria-hidden="true"><use href="#i-{name}"/></svg>'


# ── Data, taken from the shipped registry rather than invented ──────────────
LAYERS = [
    ("AIR", "3 of 6", [
        ("Aircraft", "Multi-source ADS-B · 1 s", "12,418", True, "ok", 100, "6/6"),
        ("Military", "airplanes.live", "284", True, "ok", 72, "4/4"),
        ("Emergency", "Squawk 7500, 7600, 7700", "3", True, "warn", 4, "1/3"),
        ("TFR and airspace", "", "—", False, "", 0, "0/2"),
        ("SIGMET and AIRMET", "", "—", False, "", 0, "0/2"),
        ("Ground stops", "Unavailable (HTTP 503)", "—", False, "alert", 0, "0/1"),
    ]),
    ("MARITIME", "3 of 11", [
        ("Vessels", "All AIS sources", "31,204", True, "ok", 100, "2/2"),
        ("Baltic AIS", "", "1,842", False, "ok", 12, "0/1"),
        ("Dark-vessel SAR", "Sentinel-1 · 6 areas", "6", True, "ok", 2, "6/6"),
        ("Parking mode", "", "—", False, "", 0, "0/1"),
        ("Naval warnings", "", "311", True, "ok", 18, "3/3"),
        ("Marine buoys", "", "1,204", False, "ok", 9, "0/1"),
        ("Chokepoint congestion", "", "9", False, "ok", 3, "0/1"),
    ]),
    ("GROUND AND HAZARDS", "4 of 13", [
        ("Earthquakes", "USGS", "118", True, "ok", 8, "1/1"),
        ("Fires", "NASA FIRMS", "14,818", True, "warn", 88, "1/1"),
        ("Wildfire perimeters", "", "204", False, "ok", 6, "0/1"),
        ("Tropical cyclones", "", "3", False, "ok", 1, "0/1"),
    ]),
]

# Selection content, matched to the SHIPPED app (_ref/inspector-selection.jpeg,
# Velocity v1.0.0) rather than invented. That screenshot is the bar: grouped
# disclosure sections, dual units on every physical quantity, and a Flight block
# that answers "where is it going and when does it get there", not just "what is
# its altitude". An earlier pass of this mockup had a flat key/value list, which
# was a REGRESSION against the product it was meant to redesign.
SELECTION = [
    ("IDENTITY", [
        ("ICAO24", "47AE38", "mono"),
        ("Callsign", "NBT40S", "mono"),
        ("Squawk", "1000", "mono"),
        ("ADS-B cat", "A5", ""),
        ("Source", "adsb", ""),
    ]),
    ("KINEMATICS", [
        ("Speed", "256 m/s · 497 kn", ""),
        ("Track", "103°", ""),
        ("Lat", "46.44228°", "mono"),
        ("Lon", "-4.56529°", "mono"),
        ("Alt", "11,880 m · 38,975 ft", ""),
    ]),
    ("FRESHNESS", [
        ("Last refresh", "1 s", ""),
        ("Last seen", "4 s ago", ""),
        ("Seen by", "3 sources", ""),
    ]),
]

FLIGHT = [
    ("Departed", "JFK · New York"),
    ("Arriving", "FCO · Rome"),
    ("Airline", "Norse Atlantic Airways"),
    ("Dist to go", "1,435 km"),
    ("ETA", "12:17Z"),
    ("Time to run", "1 h 34m"),
    ("Registration", "—"),
]

RAIL = [
    ("globe", "Map", True), ("graph", "Link analysis", False),
    ("grid", "Explorer", False), ("doc", "Reports", False),
    ("clock", "Replay", False), ("target", "Targeting", False),
    ("video", "Full motion video", False), ("inbox", "Inbox", False),
    ("chat", "Analyst console", False), ("flask", "Foundry", False),
]

TOOLS = [
    ("hand", "Pan", False), ("marquee", "Select", True), ("around", "Search around", False),
    ("draw", "Draw", False), ("camera", "Capture", False), ("ruler", "Measure", False),
    ("pin", "Annotate", False), ("trash", "Delete", False),
]


# ── Fragments ───────────────────────────────────────────────────────────────
def band(kind="ok", text="UNCLASSIFIED"):
    cls = {"ok": "", "warn": " warn", "alert": " alert"}[kind]
    return f'<div class="gk-band{cls}" role="note">{text}</div>'


def sysline(state="ready"):
    """System state, moved out of the deleted status strip into the title bar,
    which is where Gotham keeps it."""
    if state == "degraded":
        mid = '<span style="color:var(--warn-fg)">Vessels degraded · 1 of 2 AIS</span>'
    elif state == "error":
        mid = '<span style="color:var(--alert-fg)">Sources unavailable (HTTP 503)</span>'
    else:
        mid = "<span>13,204 contacts · 1 s</span>"
    return f'{mid}<span class="sep" aria-hidden="true">·</span><span>58 fps</span>'


def titlebar(state="ready"):
    menu = "".join(
        f"<button type=\"button\">{m}</button>"
        for m in ("File", "Edit", "View", "Collect", "Exploration", "Window", "Help")
    )
    return f"""<div class="gk-title">
  <div class="gk-brand">{ico('diamond')}<span>Velocity</span></div>
  <nav class="gk-menu" aria-label="Application menu">{menu}</nav>
  <div class="gk-saved">{ico('check')}<span>Saved</span></div>
  <div class="gk-doc">
    <span class="chip-ico" aria-hidden="true"></span>
    <span class="gk-doc-name">Baltic approaches watch</span>
    <button type="button" aria-label="Star this workspace">{ico('star')}</button>
    <button type="button" aria-label="Workspace menu">{ico('chevd')}</button>
  </div>
  <div></div>
  <div class="gk-tools">
    <button type="button" class="ico-btn" aria-label="Add collaborator">{ico('plus')}</button>
    <button type="button" class="ico-btn" aria-label="Presentation mode">{ico('screen')}</button>
    <button type="button" class="lnk">Share</button>
    <span class="gk-sys">{sysline(state)}</span>
    <span class="gk-mark">{ico('shield')}<span>UNCLAS</span></span>
    <div class="gk-envsearch">
      {ico('search')}
      <input type="search" placeholder="Baltic staging" aria-label="Search this environment">
    </div>
  </div>
</div>"""


def rail():
    out = []
    for i, (name, label, on) in enumerate(RAIL):
        cur = ' aria-current="true"' if on else ""
        out.append(f'<button type="button" aria-label="{label}"{cur}>{ico(name)}</button>')
        if i in (0, 5):
            out.append("<hr>")
    return f'<nav class="gk-rail" aria-label="Applications">{"".join(out)}</nav>'


def tabs(active="Layers", counts=None):
    counts = counts or {"Layers": "18 of 64", "Find": None, "Histogram": "6", "Info": "2", "Series": "5"}
    items = [("Layers", "layers"), ("Find", "search"), ("Histogram", "chart"),
             ("Info", "info"), ("Series", "graph")]
    out = []
    for label, icon in items:
        sel = "true" if label == active else "false"
        n = counts.get(label)
        badge = ""
        if n:
            badge = f'<span class="gk-count">{n}</span>'
        elif n is None:
            badge = ""
        out.append(
            f'<button type="button" class="gk-tab" role="tab" aria-selected="{sel}">'
            f"{ico(icon)}<span>{label}</span>{badge}</button>"
        )
    return f"""<div class="gk-tabs" role="tablist" aria-label="Panels">
  {''.join(out)}
  <span class="grow"></span>
  <button type="button" class="pin" aria-label="Pin a panel to this row">{ico('plus')}</button>
</div>"""


def layers_panel(state="ready"):
    if state == "loading":
        body = "".join(f'<div class="sk" style="width:{w}%"></div>' for w in (72, 54, 81, 46, 63, 77, 50))
        inner = f'<div class="gk-scroll" aria-busy="true">{body}</div>'
    elif state == "empty":
        inner = f"""<div class="gk-scroll"><div class="gk-state">{ico('empty')}
          <b>No sources match this filter</b>
          <span>Clear the filter to see all 64 registered sources.</span>
          <button type="button" class="btn sm" style="margin-top:8px">Clear filter</button>
        </div></div>"""
    elif state == "error":
        inner = f"""<div class="gk-scroll"><div class="gk-state err">{ico('alert')}
          <b>Sources unavailable (HTTP 503)</b>
          <span>The registry did not answer. Last good read was 4 min ago.</span>
          <button type="button" class="btn sm" style="margin-top:8px">{ico('refresh')}Retry</button>
        </div></div>"""
    else:
        rows = []
        if state == "degraded":
            rows.append(f"""<div class="gk-degraded">{ico('warn')}<span>Vessels is showing
              1 of 2 AIS sources. MyShipTracking has been silent for 4 min, so the count
              reads low. ShipXplorer is current.</span></div>""")
        for group, count, items in LAYERS:
            rows.append(
                f'<div class="gk-sect">{ico("chevd", "tri")}<span>{group}</span>'
                f'<span class="n">{count}</span></div>'
            )
            for name, sub, n, on, health, bar, frac in items:
                dot = f'<span class="dot {health}" aria-hidden="true"></span>' if health else '<span class="dot" aria-hidden="true"></span>'
                subline = f"<s>{sub}</s>" if sub else ""
                checked = "true" if on else "false"
                barhtml = ""
                if bar:
                    tone = " warn" if health == "warn" else ""
                    barhtml = f'<span class="gk-bar{tone}" aria-hidden="true"><i style="width:{bar}%"></i></span>'
                cls = "gk-grow two" if sub else "gk-grow"
                rows.append(f"""<div class="{cls}" role="group" aria-label="{name}">
                  {dot}
                  <span class="lbl" tabindex="0"><b>{name}</b>{subline}</span>
                  <span class="gk-frac">{n}</span>
                  {barhtml}
                  <button type="button" class="sw" role="switch" aria-checked="{checked}"
                          aria-label="Show {name}"><i></i></button>
                </div>""")
        inner = f'<div class="gk-scroll">{"".join(rows)}</div>'

    return f"""<section class="gk-panel l" aria-label="Layers">
  <div class="gk-phead">
    <h2 class="gk-ptitle">Layers</h2>
    <button type="button" class="ico-btn" aria-label="Mission presets">{ico('grid')}</button>
    <span class="rule" aria-hidden="true"></span>
    <button type="button" class="ico-btn" aria-label="Filter sources">{ico('search')}</button>
  </div>
  {inner}
</section>"""


# Contacts drawn on the basemap. _globe.svg documents its own projection:
#   x = (lon - 14.0) * 200      lon 14.0 E .. 22.0 E
#   y = (55.9 - lat) * 333.33   lat 53.2 N .. 55.9 N
# viewBox is 0 0 1600 900, so contacts are placed at real coordinates rather
# than scattered. Category colours are the guarded map DATA palette from
# globe/adapters/styles.ts, which is a deliberately separate colour system from
# the chrome: the only saturated colour on screen belongs to data.
def project(lon, lat):
    return (lon - 14.0) * 200.0, (55.9 - lat) * 333.33


def contacts():
    """Deterministic contact field. No RNG, so the page regenerates identically."""
    air = [  # lon, lat, track, category
        (16.9, 55.4, 118, "airliner"), (18.2, 55.1, 204, "airliner"),
        (19.6, 55.6, 268, "private"), (15.4, 54.8, 42, "airliner"),
        (17.3, 54.3, 331, "heli"), (20.4, 55.0, 155, "mil"),
        (16.1, 53.9, 88, "airliner"), (18.9, 54.6, 24, "glider"),
        (21.1, 54.4, 190, "airliner"), (15.0, 55.2, 305, "private"),
        (19.1, 53.7, 76, "airliner"), (17.8, 55.7, 240, "mil"),
        (20.0, 53.5, 12, "heli"), (14.6, 54.2, 133, "airliner"),
        (21.5, 55.3, 281, "airliner"), (16.5, 54.55, 60, "private"),
        (18.5, 53.4, 348, "airliner"), (19.9, 54.9, 99, "emergency"),
        (15.7, 55.55, 95, "airliner"), (16.35, 55.05, 212, "private"),
        (17.05, 55.25, 340, "airliner"), (19.35, 55.35, 58, "airliner"),
        (20.8, 55.55, 176, "private"), (14.9, 53.6, 22, "airliner"),
        (16.7, 53.55, 264, "heli"), (21.3, 53.9, 108, "airliner"),
        (17.45, 53.75, 291, "airliner"), (20.05, 54.15, 8, "mil"),
        (15.55, 54.45, 149, "airliner"), (18.05, 53.95, 316, "private"),
        (19.55, 53.35, 71, "airliner"), (14.35, 54.85, 233, "airliner"),
        (21.75, 54.75, 128, "heli"), (16.2, 54.15, 355, "airliner"),
    ]
    sea = [
        (18.75, 54.42, 31, "cargo"), (18.55, 54.55, 210, "tanker"),
        (19.3, 54.75, 145, "cargo"), (17.6, 54.9, 288, "fishing"),
        (18.1, 54.75, 66, "passenger"), (19.8, 54.5, 172, "cargo"),
        (16.8, 54.6, 250, "tanker"), (20.6, 54.75, 18, "cargo"),
        (17.15, 54.65, 300, "fishing"), (18.35, 55.0, 120, "cargo"),
        (15.9, 54.95, 205, "tanker"), (20.2, 55.2, 84, "passenger"),
        (18.9, 54.35, 254, "cargo"), (19.55, 55.05, 39, "fishing"),
        (17.9, 55.35, 161, "tanker"), (16.4, 55.35, 97, "cargo"),
        (20.9, 55.4, 222, "cargo"), (18.2, 54.2, 305, "fishing"),
        (19.05, 55.45, 74, "tanker"), (17.35, 55.1, 189, "cargo"),
        (21.2, 55.05, 15, "passenger"), (16.15, 54.4, 268, "fishing"),
    ]
    out = []
    for lon, lat, trk, cat in air:
        x, y = project(lon, lat)
        out.append(
            f'<g transform="translate({x:.1f} {y:.1f}) rotate({trk})">'
            f'<path d="M0 -9 L6 7 L0 3 L-6 7 Z" fill="var(--d-{cat})" '
            f'stroke="#0b1116" stroke-width="1"/></g>'
        )
    for lon, lat, trk, cat in sea:
        x, y = project(lon, lat)
        out.append(
            f'<g transform="translate({x:.1f} {y:.1f}) rotate({trk})">'
            f'<path d="M0 -7 L4.5 2 L4.5 7 L-4.5 7 L-4.5 2 Z" fill="var(--d-{cat})" '
            f'stroke="#0b1116" stroke-width="1"/></g>'
        )

    # The selected contact and its track. Selection polyline is #d946ef at
    # width 4 over a black outline at width 6, which globe/invariants.test.ts
    # pins as literal strings.
    # ~15 min of track, curving onto the reported 024 deg heading rather than a
    # single straight segment. tracks.ts keeps a push per 60 s or 5 deg, so a
    # real polyline has visible vertices, not two endpoints.
    trail = [
        (18.30, 54.16), (18.36, 54.26), (18.41, 54.35), (18.45, 54.43),
        (18.50, 54.50), (18.55, 54.56), (18.59, 54.61), (18.62, 54.66),
    ]
    pts = " ".join(f"{project(a, b)[0]:.1f},{project(a, b)[1]:.1f}" for a, b in trail)
    sx, sy = project(18.62, 54.66)
    out.append(f'<polyline points="{pts}" fill="none" stroke="#000" stroke-width="6"/>')
    out.append(f'<polyline points="{pts}" fill="none" stroke="#d946ef" stroke-width="4"/>')
    out.append(
        f'<g transform="translate({sx:.1f} {sy:.1f}) rotate(24)">'
        f'<path d="M0 -11 L7 8 L0 4 L-7 8 Z" fill="#d946ef" stroke="#fff" stroke-width="1.4"/></g>'
    )
    out.append(
        f'<text x="{sx + 14:.0f}" y="{sy - 6:.0f}" fill="#f6f7f9" font-size="13" '
        f'font-family="IBM Plex Mono, monospace">RYR4213</text>'
    )
    return f'<g class="contacts">{"".join(out)}</g>'


def map_panel(selected=True):
    globe = (HERE / "_globe.svg").read_text() if (HERE / "_globe.svg").exists() else ""
    # Inject contacts just before the closing tag so they draw over the basemap.
    if globe.rstrip().endswith("</svg>"):
        globe = globe.rstrip()[: -len("</svg>")] + contacts() + "</svg>"
    # Gotham groups its toolbar and LABELS each group (_ref/graph-toolbar.png).
    GROUPS = [("Navigate", TOOLS[0:1]), ("Select", TOOLS[1:3]),
              ("Draw", TOOLS[3:5]), ("Measure", TOOLS[5:8])]
    tools = []
    for gi, (glabel, items) in enumerate(GROUPS):
        btns = "".join(
            f'<button type="button" aria-label="{label}" aria-pressed="{"true" if on else "false"}">{ico(name)}</button>'
            for name, label, on in items
        )
        tools.append(f'<div class="gk-tgroup" role="group" aria-label="{glabel} tools">'
                     f'<span class="lab" aria-hidden="true">{glabel}</span>'
                     f'<span class="btns">{btns}</span></div>')
        if gi < len(GROUPS) - 1:
            tools.append('<span class="vr" aria-hidden="true"></span>')
    return f"""<section class="gk-map" aria-label="Map">
  {globe}
  <div class="gk-maptools" role="toolbar" aria-label="Map tools">{''.join(tools)}</div>
  <div class="gk-legend">
    <span><i style="background:var(--d-airliner)" aria-hidden="true"></i>aircraft</span>
    <span><i style="background:var(--d-cargo)" aria-hidden="true"></i>vessels</span>
    <span><i style="background:var(--d-emergency)" aria-hidden="true"></i>dark candidate</span>
    <span><i style="background:var(--d-heli)" aria-hidden="true"></i>GPS jamming</span>
  </div>
  <div class="gk-feeds">
    <span><span class="dot alert" aria-hidden="true"></span>LINK down</span>
    <span><span class="dot ok" aria-hidden="true"></span>FEEDS 6 of 8 live</span>
    <span><span class="dot ok" aria-hidden="true"></span>CLOCK live</span>
  </div>
  <div class="gk-readout">54.3181 N &nbsp;018.7122 E<span style="color:var(--txt-3)">·</span>MGRS 33UXP 0421 5518</div>
  <div class="gk-basemap"><b>Carto dark</b><span>·</span>OSM<span>·</span>CARTO</div>
  <div class="gk-dock">
    <div class="gk-dockbar">
      <button type="button" class="ico-btn" aria-label="Pause playback"
              style="height:20px;width:20px;display:grid;place-items:center;background:none;border:0;color:var(--txt-1);cursor:pointer">{ico('pause')}</button>
      <span class="t">07:42Z</span>
      <span class="gk-track" aria-hidden="true"><i style="left:62%"></i></span>
      <span class="t">08:42Z</span>
      <button type="button" class="btn sm primary" style="height:20px">Live</button>
      <button type="button" class="btn sm" style="height:20px">6 h{ico('chevd')}</button>
      <button type="button" class="ico-btn" aria-label="Expand the time dock"
              style="height:20px;width:20px;display:grid;place-items:center;background:none;border:0;color:var(--txt-2);cursor:pointer">{ico('chev')}</button>
    </div>
  </div>
</section>"""


def selection_panel(state="ready"):
    """Right panel, rebuilt against _ref/inspector-selection.jpeg (v1.0.0).

    The shipped app leads with identity, not with a property table: a type icon,
    the ICAO24 above the callsign in display size, type tags, and the operator on
    one line. Only then does it go to grouped detail. A flat key/value list loses
    the thing an analyst actually reads first.
    """
    if state == "empty":
        inner = f"""<div class="gk-scroll"><div class="gk-state">{ico('marquee')}
          <b>No entity selected</b>
          <span>Click an object on the globe, or press <kbd>v</kbd> and drag to
          select several.</span>
        </div></div>"""
        return f"""<section class="gk-panel r" aria-label="Selection">
  <div class="gk-phead"><h2 class="gk-ptitle">Selection</h2>
    <button type="button" class="ico-btn" aria-label="Close panel">{ico('cross')}</button>
  </div>{inner}</section>"""

    if state == "loading":
        inner = '<div class="gk-scroll" aria-busy="true">' + "".join(
            f'<div class="sk" style="width:{w}%"></div>' for w in (60, 88, 44, 70, 52, 80)
        ) + "</div>"
        return f"""<section class="gk-panel r" aria-label="Selection">
  <div class="gk-phead"><h2 class="gk-ptitle">Selection</h2></div>{inner}</section>"""

    blocks = []
    if state == "degraded":
        blocks.append(f"""<div class="gk-degraded">{ico('warn')}<span>Pattern of life
          is unavailable for this contact. History has 41 min of track, which is
          below the 6 h this analysis needs.</span></div>""")

    # Identity header
    blocks.append(f"""<div class="gk-ident">
      <div class="gk-ident-top">
        <span class="gk-ident-ico" aria-hidden="true">{ico('plane')}</span>
        <div>
          <div class="gk-ident-sub">47AE38</div>
          <div class="gk-ident-name">LN-FNL</div>
        </div>
      </div>
      <div class="gk-tags">
        <span class="gk-tag">AIRCRAFT</span><span class="gk-tag">AIRLINER</span>
      </div>
      <div class="gk-ident-op">Norse Atlantic Airways · 787 9</div>
      <div class="gk-ident-fresh"><span class="dot ok" aria-hidden="true"></span>updated 1 s</div>
    </div>""")

    # Profile card, the silhouette the shipped app shows
    blocks.append(f"""<div class="gk-profile">
      <div class="gk-profile-h">Profile</div>
      <div class="gk-profile-b">
        <svg viewBox="0 0 120 40" class="gk-silhouette" aria-label="Boeing 787-9 silhouette">
          <path d="M59 4c1.6 0 2.6 2.2 2.9 6.4l.3 5.2 24 9.3v3.1l-24-4.4.2 8.4 6.4 3.3v2.3l-9.8-2-9.8 2v-2.3l6.4-3.3.2-8.4-24 4.4v-3.1l24-9.3.3-5.2C56.4 6.2 57.4 4 59 4z"
                fill="currentColor"/>
        </svg>
        <span class="gk-profile-t">B789</span>
      </div>
    </div>""")

    for title, rows in SELECTION:
        blocks.append(
            f'<div class="gk-sect">{ico("chevd", "tri")}<span>{title}</span></div>'
        )
        for k, v, cls in rows:
            c = f' class="{cls}"' if cls else ""
            blocks.append(f'<dl class="gk-kv"><dt>{k}</dt><dd{c}>{v}</dd></dl>')

    blocks.append('<div class="gk-sect"><span>FLIGHT</span>'
                  '<span class="n">JFK to FCO</span></div>')
    for k, v in FLIGHT:
        c = ' class="none"' if v == "\u2014" else ""
        blocks.append(f'<dl class="gk-kv"><dt>{k}</dt><dd{c}>{v}</dd></dl>')

    inner = f'<div class="gk-scroll">{"".join(blocks)}</div>'
    tabs = "".join(
        f'<button type="button" class="gk-stab" role="tab" aria-selected="{"true" if t == "Overview" else "false"}">{t}</button>'
        for t in ("Overview", "Properties", "History", "Dossier")
    )
    return f"""<section class="gk-panel r" aria-label="Selection">
  <div class="gk-phead">
    <h2 class="gk-ptitle">Selection</h2>
    <button type="button" class="ico-btn" aria-label="Follow this contact">{ico('pin')}</button>
    <span class="rule" aria-hidden="true"></span>
    <button type="button" class="ico-btn" aria-label="Close panel">{ico('cross')}</button>
  </div>
  <div class="gk-stabs" role="tablist" aria-label="Selection views">{tabs}</div>
  {inner}
  <div class="gk-pfoot">
    <button type="button" class="btn primary wide">Actions{ico('chevd')}</button>
  </div>
</section>"""


def transport():
    """Transport, rebuilt against _ref/video-transport.png.

    Gotham's is symmetric and centred: timestamp left, one control cluster in the
    middle, two icons right. Speed is a +/- STEP (2x either side of play), not a
    segmented row of every possible rate, and exactly one button is filled: Pause.

    What this replaces was two 5-button segmented groups (SPD 1x/10x/60x/600x/
    3600x and RPL 1h/6h/24h/3d/7d), a buffer label, and two event lanes crammed
    into the same strip: 16 controls where Gotham shows 11, and the two segmented
    rows were most of the visual noise. The event lanes were Velocity's own
    addition, not Gotham's; incident density over time belongs in the Histogram
    panel, not in the transport.
    """
    return f"""<div class="gk-timeblock">
  <span class="t">08:42:17 Z</span>
  <span class="grow"></span>
  <div class="gk-tp">
    <button type="button" aria-label="Jump to start">&#9198;</button>
    <button type="button" aria-label="Rewind 2x"><span>&#9194;</span><b>2x</b></button>
    <button type="button" aria-label="Back 15 seconds"><span>&#8630;</span><b>15s</b></button>
    <button type="button" aria-label="Step back one frame">&#9198;|</button>
    <button type="button" class="on" aria-label="Pause">&#9208; Pause</button>
    <button type="button" aria-label="Step forward one frame">|&#9197;</button>
    <button type="button" aria-label="Forward 15 seconds"><b>15s</b><span>&#8631;</span></button>
    <button type="button" aria-label="Fast forward 2x"><b>2x</b><span>&#9193;</span></button>
    <button type="button" class="live" aria-label="Return to live">Live</button>
  </div>
  <span class="grow"></span>
  <button type="button" class="ico-btn" aria-label="Playback settings">{ico('slider')}</button>
  <button type="button" class="ico-btn" aria-label="Coverage">{ico('clock')}</button>
</div>"""


def actionbar(state="ready"):
    if state == "empty":
        sentence = '<span style="color:var(--txt-3)">Select contacts to build a filter path.</span>'
        right = '<button type="button" class="btn" disabled style="opacity:.5">Add to filter path</button>'
    else:
        sentence = ("""<span class="verb">Keeping</span> Aircraft with
          <span class="tok" role="button" tabindex="0">Category</span> matching any of
          <span class="tok" role="button" tabindex="0">Military</span>,
          <span class="tok" role="button" tabindex="0">Emergency</span>""")
        right = f"""<button type="button" class="btn ghost">Clear selection</button>
          <button type="button" class="btn primary">{ico('filter')}Add to filter path</button>"""
    return f"""<div class="gk-action">
  <button type="button" class="btn sm">Filter contact type{ico('chevd')}</button>
  <span class="gk-sentence">{sentence}</span>
  <span class="right">{right}</span>
</div>"""


def statusbar(state="ready"):
    if state == "degraded":
        mid = ('<span style="color:var(--warn-fg)">Vessels degraded · 1 of 2 AIS sources</span>')
    elif state == "error":
        mid = '<span style="color:var(--alert-fg)">Sources unavailable (HTTP 503)</span>'
    else:
        mid = "<span>18 layers · 13,204 contacts · 1 s refresh</span>"
    return f"""<div class="gk-status">
  <span class="on">Online</span>
  <button type="button" class="btn ghost sm" style="height:18px;padding:0 6px">View</button>
  <span class="sep" aria-hidden="true">·</span>
  {mid}
  <span class="grow"></span>
  <span>58 fps</span>
  <span class="sep" aria-hidden="true">·</span>
  <span style="font-family:var(--font-mono)">08:42:17Z</span>
</div>"""


def console(state="ready", label=None):
    left = layers_panel(state if state in ("loading", "empty", "error", "degraded") else "ready")
    right = selection_panel(state if state in ("loading", "empty", "degraded") else "ready")
    tag = ""
    if label:
        tag = (f'<div style="position:fixed;left:50%;transform:translateX(-50%);bottom:34px;'
               f'z-index:900;background:var(--bg-3);border:1px solid var(--line-2);'
               f'border-radius:2px;padding:4px 10px;font-size:12px;color:var(--txt-0)">{label}</div>')
    return f"""<div class="gk">
  {band()}
  {titlebar(state)}
  <div class="gk-body">
    {rail()}
    <div class="gk-work">
      {tabs()}
      <div class="gk-cols">
        {map_panel()}
        {left}
        {right}
      </div>
      {transport()}
      {actionbar('empty' if state == 'empty' else 'ready')}
    </div>
  </div>
  {tag}
</div>"""


PAGE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Velocity · Gotham-grammar console</title>
<link rel="stylesheet" href="mock.css">
<link rel="stylesheet" href="gotham.css">
</head><body style="margin:0;background:#111418">
%s
%s
</body></html>
"""


def main():
    OUT.write_text(PAGE % (sprite(), console("ready")), encoding="utf-8")
    print(f"wrote {OUT.name} ({OUT.stat().st_size:,} bytes)")

    # The four states, each a full console with one region swapped.
    for st in ("loading", "empty", "error", "degraded"):
        p = HERE / f"gotham-{st}.html"
        p.write_text(PAGE % (sprite(), console(st, f"State · {st}")), encoding="utf-8")
        print(f"wrote {p.name} ({p.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
