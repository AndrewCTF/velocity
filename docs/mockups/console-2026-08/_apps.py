"""_apps.py — the twelve analytical apps, one page each.

The app list is `AppId` from apps/web/src/state/appView.ts:14-28, so the set
covers every app exactly once and none is invented. What each panel contains is
predicted from docs/palantir-reference-2026-07.md §11, which walks 23 Palantir
panels; this file is the drawing of that prediction, not a second guess at it.

One dark surface throughout. The earlier plan put Foundry, Workflows and
Explorer on light; operator decision 2026-08-01 revoked that.

Every app obeys the same two rules the map console does: no emoji, and no bare
count without a mark beside it.
"""

from __future__ import annotations

from _parts import (COLOR, bar, count, dots, ic, kv, meter, obj_card,
                    panel_head, panel_tools, row, sect, silhouette, spark,
                    state, banner, switch, tabstrip, thumb, titlebar)


def app_shell(title: str, *, tabs: list[str], active: str, body: str,
              head_right: str = "", rail: str = "", doc: str = "") -> str:
    sub = '<div class="subtabs">' + "".join(
        f'<button class="tab" aria-selected="{"true" if t == active else "false"}">{t}</button>'
        for t in tabs) + "</div>"
    return f"""<div class="shell">
{titlebar(doc=doc or title)}
{tabstrip('Layers')}
<div class="body no-right" style="grid-template-columns:{'var(--g-rail) ' if rail else ''}1fr">
{rail}
<div class="app">
  <div class="app-head">{ic('hexagon', 'ic-sm')}<b>{title}</b><span class="sp"></span>{head_right}</div>
  {sub}
  <div class="app-body">{body}</div>
</div>
</div>
</div>"""


def card(title: str, body: str, *, right: str = "", flush: bool = False) -> str:
    return (f'<div class="card"><div class="card-h">{title}<span class="sp"></span>{right}</div>'
            f'<div class="card-b{" flush" if flush else ""}">{body}</div></div>')


def stat(k: str, v: str, mark_html: str) -> str:
    """A stat tile ALWAYS carries its trend. A bare 24px number was the
    complaint; MetricsPanel.tsx:120-128 already fetches the series it needs."""
    return (f'<div class="stat"><span class="k">{k}</span><div class="v">{v}</div>'
            f'<div class="r"><span class="mark">{mark_html}</span></div></div>')


def bars_chart(rows: list[tuple[str, float, str]], *, w: int = 300, h: int = 0) -> str:
    """Horizontal labelled bars. The form MetricsPanel.tsx:98 already uses, kept
    so this is a restyle later and not a rewrite."""
    out = []
    for label, frac, cls in rows:
        out.append(
            f'<div class="row"><span class="nm">{label}</span>'
            f'<span class="mark">{count(f"{frac * 100:.0f} %")}{bar(0, frac, cls)}</span></div>')
    return "".join(out)


# ════════════════════════════════════════════════════════════════════════════
# Graph — Gotham's flagship, and the app the operator asked for by name
# ════════════════════════════════════════════════════════════════════════════

GNODES = [
    (50, 46, "LN-FNL", "airliner", None, True),
    (28, 26, "Norse Atlantic", None, "building", False),
    (72, 24, "JFK", None, "plane", False),
    (79, 52, "FCO", None, "plane", False),
    (24, 62, "NORDIC STAR", "cargo", None, False),
    (46, 76, "Port of Gdansk", None, "anchor", False),
    (68, 74, "MMSI 273441000", None, "radio", False),
    (13, 42, "Sentinel-1 pass", None, "satellite", False),
    (58, 12, "Squawk 1000", None, "signal", False),
]
GLINKS = [
    (0, 1, "operated by", True), (0, 2, "departed", True), (0, 3, "arriving", True),
    (0, 8, "transponder", False), (4, 5, "berth booked", False),
    (4, 6, "identity", False), (4, 7, "detected in", False),
    (0, 4, "co-located 14:22 Z", True),
]


def graph_canvas() -> str:
    """Links are drawn in a percentage viewBox with non-scaling-stroke, and the
    link labels are HTML rather than SVG <text>.

    Both are deliberate. A `viewBox="0 0 100 100"` scaled to a 1450px canvas
    multiplies every user unit by ~14, so an SVG label asking for font-size 10
    renders at ~90px and a 1.2 stroke renders 17px wide. The first render of
    this page did exactly that. Stroke width is pinned in device pixels;
    text lives outside the scaled coordinate system entirely."""
    lines, labels = [], []
    for a, b, text, hot in GLINKS:
        x1, y1 = GNODES[a][0], GNODES[a][1]
        x2, y2 = GNODES[b][0], GNODES[b][1]
        cls = "glink hot" if hot else "glink"
        lines.append(f'<line class="{cls}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
                     f'vector-effect="non-scaling-stroke"/>')
        labels.append(
            f'<span class="gl-label" style="left:{(x1 + x2) / 2:.1f}%;top:{(y1 + y2) / 2:.1f}%">'
            f'{text}</span>')
    svg = (f'<svg viewBox="0 0 100 100" preserveAspectRatio="none" '
           f'style="position:absolute;inset:0;width:100%;height:100%" aria-hidden="true">'
           f'{"".join(lines)}</svg>')
    nodes = []
    for x, y, name, kind, icon, sel in GNODES:
        art = thumb(kind or "airliner", COLOR.get(kind or ""), None, icon)
        nodes.append(f'<div class="gnode{" sel" if sel else ""}" style="left:{x}%;top:{y}%">'
                     f'{art}<b>{name}</b></div>')
    return f'<div class="graph">{svg}{"".join(labels)}{"".join(nodes)}</div>'


GRAPH_HISTO = [
    ("Summary", "2", [("Entity", "1 of 12", 0.08, 1.0, "circle-dot"),
                      ("Event", "0 of 4", 0.0, 0.33, "calendar")]),
    ("Entity", "7", [("Aircraft", "1 of 5", 0.20, 0.62, "plane"),
                     ("Vessel", "0 of 2", 0.0, 0.25, "ship"),
                     ("Organisation", "0 of 1", 0.0, 0.12, "building"),
                     ("Facility", "0 of 1", 0.0, 0.12, "anchor"),
                     ("Emitter", "0 of 1", 0.0, 0.12, "radio")]),
    ("Event", "2", [("Co-location", "1 of 1", 1.0, 1.0, "around"),
                    ("SAR detection", "0 of 1", 0.0, 0.5, "radar")]),
]


def graph_page() -> str:
    histo = []
    for title, n, rows in GRAPH_HISTO:
        histo.append(sect(title, n))
        for name, frac, part, tot, icon in rows:
            sel = part > 0
            tail = f'<span class="mark">{count(frac, "frac")}{bar(part, tot)}</span>'
            histo.append(row(name, icon=icon, tail=tail, sel=sel))
    rail = ('<div class="rail">'
            + "".join(f'<button aria-pressed="{"true" if i == 0 else "false"}" aria-label="{lab}" title="{lab}">{ic(k)}</button>'
                      for i, (k, lab) in enumerate([
                          ("chart", "Histogram"), ("info", "Info"), ("clock", "History"),
                          ("layers", "Layers"), ("map", "Map"), ("table", "Table")]))
            + "</div>")
    toolbar = """<div class="toolbar" style="position:static;background:none;border:0;padding:0">
      <div class="tgroup"><b>Organize</b><div>
        <button class="tool" aria-label="Layout" title="Layout">{a}</button>
        <button class="tool" aria-label="Layers" title="Layers">{b}</button></div></div>
      <div class="tgroup"><b>Annotations</b><div>
        <button class="tool" aria-label="Add note" title="Add note">{c}</button>
        <button class="tool" aria-label="Group" title="Group">{d}</button></div></div>
      <div class="tgroup"><b>Node styling</b><div>
        <button class="tool" aria-label="Node colour" title="Node colour">{e}</button>
        <button class="tool" aria-label="Node size" title="Node size">{f}</button></div></div>
      <div class="tgroup"><b>Link styling</b><div>
        <button class="tool" aria-label="Link colour" title="Link colour">{g}</button>
        <button class="tool" aria-label="Link width" title="Link width">{h}</button></div></div>
    </div>""".format(a=ic("network"), b=ic("layers"), c=ic("annotate"), d=ic("box"),
                     e=ic("circle"), f=ic("maximize"), g=ic("link"), h=ic("more"))

    body = f"""<div style="display:grid;grid-template-columns:1fr 300px;gap:12px;height:100%;min-height:0">
  <div style="display:flex;flex-direction:column;min-height:0">
    <div class="card" style="flex:1;display:flex;flex-direction:column;min-height:0">
      <div class="card-h" style="height:auto;padding:5px 8px;text-transform:none;letter-spacing:0">
        {toolbar}
        <span class="sp"></span>
        <span class="search" style="width:240px;margin:0">{ic('search', 'ic-sm')}Find artifacts, objects and links</span>
      </div>
      <div class="card-b flush" style="flex:1;position:relative;min-height:0">{graph_canvas()}</div>
    </div>
  </div>
  <aside class="panel" style="border:1px solid var(--brd);border-radius:2px">
    {panel_head('Histogram')}
    {panel_tools()}
    <div class="panel-body">{"".join(histo)}
      {sect('Property values', '5')}
      {row('Co-located within 2 km', icon='route', tail=f'<span class="mark">{count("1 of 1")}{bar(1.0, 1.0)}</span>')}
      {row('Seen 14:22 to 14:31 Z', icon='clock', tail=f'<span class="mark">{count("1 of 1")}{bar(1.0, 1.0)}</span>')}
      {row('Registration LN-FNL', icon='file', tail=f'<span class="mark">{count("1 of 5")}{bar(0.2, 0.62)}</span>')}
    </div>
  </aside>
</div>"""
    return app_shell("Graph", tabs=["Canvas", "Timeline", "Table", "Map"], active="Canvas",
                     body=body, rail=rail,
                     head_right=(f'<button class="btn sm gho">{ic("around", "ic-sm")}Search around</button>'
                                 f'<button class="btn sm pri">{ic("save", "ic-sm")}Save to case</button>'))


# ════════════════════════════════════════════════════════════════════════════

def explorer_page() -> str:
    rows = []
    data = [
        ("LN-FNL", "Norse Atlantic &middot; B789", "airliner", "38,975 ft", "497 kn", 0.86),
        ("RCH471", "US Air Force &middot; C-17A", "airliner", "31,000 ft", "451 kn", 0.71),
        ("SAS1871", "SAS &middot; A320neo", "airliner", "36,000 ft", "462 kn", 0.79),
        ("D-EABC", "Private &middot; C172", "private", "4,500 ft", "108 kn", 0.11),
        ("OY-HJK", "Rescue &middot; EC135", "helicopter", "1,200 ft", "132 kn", 0.19),
    ]
    for cs, sub, kind, alt, spd, frac in data:
        rows.append(
            f'<tr><td>{thumb(kind, COLOR[kind])}</td><td><b style="color:var(--txt-0)">{cs}</b><br>'
            f'<span class="mut" style="font-size:12px">{sub}</span></td>'
            f'<td class="num">{alt}</td><td class="num">{spd}</td>'
            f'<td><span class="mark">{count(f"{frac * 100:.0f} %")}{bar(0, frac)}</span></td></tr>')
    facets = "".join(
        sect(t, n) + "".join(
            row(nm, icon="circle-dot",
                tail=f'<span class="mark">{count(c)}{bar(p, tt)}</span>', sel=p > 0)
            for nm, c, p, tt in rr)
        for t, n, rr in [
            ("Object type", "3", [("Aircraft", "12,418", 0.62, 0.95), ("Vessel", "31,204", 0.0, 1.0),
                                  ("Facility", "1,204", 0.0, 0.12)]),
            ("Operator", "4", [("Ryanair", "882", 0.0, 0.28), ("Lufthansa", "651", 0.0, 0.21),
                               ("SAS", "410", 0.0, 0.13), ("Norse Atlantic", "38", 0.02, 0.02)]),
        ])
    body = f"""<div style="display:grid;grid-template-columns:300px 1fr;gap:12px;height:100%;min-height:0">
  <aside class="panel" style="border:1px solid var(--brd);border-radius:2px">
    {panel_head('Filter path')}
    <div class="panel-body">
      <div class="pad sentence" style="line-height:1.7">
        Keeping <b>Aircraft</b> with <u>Operator</u> matching any of <u>Norse Atlantic</u>
        and <u>Altitude</u> <u>above</u> <u>FL300</u>
      </div>
      {facets}
    </div>
  </aside>
  <div class="card" style="min-height:0;display:flex;flex-direction:column">
    <div class="card-h">Results<span class="sp"></span>
      <span class="mark">{count('38 of 12,418')}{bar(0.003, 0.003)}</span></div>
    <div class="card-b flush" style="overflow:auto">
      <table class="tbl"><thead><tr><th style="width:56px"></th><th>Object</th>
      <th style="text-align:right">Altitude</th><th style="text-align:right">Speed</th>
      <th>Share of filter</th></tr></thead><tbody>{"".join(rows)}</tbody></table>
    </div>
  </div>
</div>"""
    return app_shell("Explorer", tabs=["Objects", "Properties", "Saved searches"],
                     active="Objects", body=body,
                     head_right=f'<button class="btn sm pri">{ic("plus", "ic-sm")}Add to filter path</button>')


def investigate_page() -> str:
    hits = "".join(obj_card(t, s, kind=k, icon=i, color=COLOR.get(k or ""),
                            tail=f'<span class="mark">{count(c)}{bar(0, f)}</span>')
                   for t, s, k, i, c, f in [
                       ("Norse Atlantic Airways", "Organisation &middot; 42 linked objects", None, "building", "42", 0.84),
                       ("LN-FNL", "Aircraft &middot; 9 linked objects", "airliner", None, "9", 0.18),
                       ("Gdansk Lech Walesa", "Facility &middot; 31 linked objects", None, "plane", "31", 0.62),
                       ("MMSI 273441000", "Emitter &middot; 4 linked objects", None, "radio", "4", 0.08),
                   ])
    body = f"""<div class="grid g3">
  {card('Resolved entities', hits, flush=True)}
  {card('Link strength', bars_chart([
      ('Shared facility', 0.88, ''), ('Co-location in time', 0.71, ''),
      ('Registration match', 0.44, ''), ('Operator record', 0.31, ''),
      ('Weak name match', 0.12, 'warn')]))}
  {card('Provenance',
        kv('Sources', '4') + kv('Assertions', '182') + kv('Conflicts', '2', 'txt') +
        kv('Last write', '14:31:02 Z') +
        banner('warn', 'warning',
               'Two sources disagree on the operator of MMSI 273441000. Both are kept; '
               'neither is silently preferred.'))}
</div>"""
    return app_shell("Investigate", tabs=["Search", "Entities", "Provenance"],
                     active="Entities", body=body)


def targeting_page() -> str:
    stages = [
        ("Find", 3, [("Unknown emitter 33UXP", "radio", 0.15), ("Dark vessel candidate", "ship", 0.22)]),
        ("Fix", 2, [("MMSI 273441000", "ship", 0.48)]),
        ("Track", 2, [("LN-FNL", "plane", 0.66)]),
        ("Target", 1, [("Gdynia berth 4", "anchor", 0.81)]),
        ("Engage", 0, []),
        ("Assess", 1, [("Sentinel-1 revisit", "satellite", 0.94)]),
    ]
    cols = []
    for name, n, cards in stages:
        inner = "".join(
            f'<div class="obj-card" style="border:1px solid var(--brd);border-radius:2px;margin-bottom:6px">'
            f'{thumb("airliner", None, None, icon)}'
            f'<div class="obj-main"><div class="obj-t">{t}</div>'
            f'<div class="obj-s">step {int(p * 6)} of 6</div>{meter(p * 100)}</div></div>'
            for t, icon, p in cards)
        empty = "" if cards else state("", "Nothing at this stage",
                                       "Cards arrive here when the previous stage is signed off.",
                                       "circle-check")
        cols.append(card(f'{name} <span class="badge">{n}</span>', inner + empty))
    body = f'<div class="grid" style="grid-template-columns:repeat(6,minmax(0,1fr))">{"".join(cols)}</div>'
    return app_shell("Targeting", tabs=["Board", "Detail", "Audit"], active="Board", body=body)


def video_page() -> str:
    boxes = "".join(
        f'<div style="position:absolute;left:{x}%;top:{y}%;width:{w}%;height:{h}%;'
        f'border:1px solid var(--warn);box-shadow:0 0 0 1px rgba(0,0,0,.6)">'
        f'<span class="det-label" style="position:absolute;top:-15px;left:-1px;background:var(--warn);'
        f'color:#111418;font-size:10px;padding:0 3px;white-space:nowrap">{lab}</span></div>'
        for x, y, w, h, lab in [(34, 41, 9, 13, "vehicle 0.91"), (52, 36, 7, 10, "person 0.78"),
                                (63, 55, 11, 14, "vehicle 0.84"), (21, 62, 8, 11, "person 0.66")])
    tags = "".join(
        f'<div class="obj-card">{thumb("airliner", None, None, "video")}'
        f'<div class="obj-main"><div class="obj-t">{t}</div><div class="obj-s">{s}</div></div>'
        f'<span class="chip mut">{c}</span></div>'
        for t, s, c in [("Vehicle at building roof", "Observation &middot; 13:51:01 Z", "13:51:02"),
                        ("Person entering compound", "Observation &middot; 13:53:44 Z", "13:53:44"),
                        ("Safe house", "Location &middot; linked", "linked")])
    body = f"""<div style="display:grid;grid-template-columns:300px 1fr;gap:12px;height:100%;min-height:0">
  <aside class="panel" style="border:1px solid var(--brd);border-radius:2px">
    {panel_head('Tagging')}
    <div class="panel-body">
      {sect('Linked to', '1')}
      {obj_card('Safe house', 'Location &middot; MGRS 33UXP 0421', icon='pin', sel=True)}
      {sect('Observations', '3')}
      {tags}
      {sect('Detection quality')}
      <div class="pad">
        <div class="row"><span class="nm">Confirmed</span>
          <span class="mark">{count('31')}{bar(0, 0.62, 'ok')}</span></div>
        <div class="row"><span class="nm">Pending review</span>
          <span class="mark">{count('14')}{bar(0, 0.28, 'warn')}</span></div>
        <div class="row"><span class="nm">Dismissed</span>
          <span class="mark">{count('5')}{bar(0, 0.10)}</span></div>
      </div>
    </div>
  </aside>
  <div class="card" style="min-height:0;display:flex;flex-direction:column">
    <div class="card-h">Eagle M29 &middot; 10FEB2026 12:00 Z<span class="sp"></span>
      <span class="chip mut">{ic('radio', 'ic-sm')}archive &middot; not live</span></div>
    <div class="card-b flush" style="flex:1;position:relative;background:#0b0d0f;min-height:0">
      <div style="position:absolute;inset:0;background:
        linear-gradient(160deg,#2a2f26 0%,#3a3f33 34%,#23262a 66%,#15181b 100%)"></div>
      <div style="position:absolute;inset:0;background:
        repeating-linear-gradient(112deg, rgba(255,255,255,.028) 0 3px, transparent 3px 9px)"></div>
      {boxes}
      <div class="hud" style="position:absolute;top:8px;left:10px;font-family:var(--font-mono);font-size:11px;
        color:var(--ok-fg);text-shadow:0 0 3px #000">POINT UNZ DTM<br>IC LIN<br>1113 19C</div>
      <div class="hud" style="position:absolute;top:8px;right:10px;font-family:var(--font-mono);font-size:11px;
        color:var(--ok-fg);text-shadow:0 0 3px #000;text-align:right">
        ALT 165 DEG<br>RNG 7702 M<br>ELV 531 FT</div>
    </div>
  </div>
</div>"""
    return app_shell("Video", tabs=["FMV", "Ground recon", "Exports"], active="FMV", body=body)


def country_page() -> str:
    leaders = "".join(
        f'<div class="obj-card"><div class="thumb" style="border-radius:50%">'
        f'<svg class="thumb-art" viewBox="0 0 40 40" aria-hidden="true">'
        f'<circle cx="20" cy="20" r="19" fill="var(--bg-2)" stroke="var(--brd)"/>'
        f'<text x="20" y="25" text-anchor="middle" fill="var(--txt-2)" '
        f'font-size="14" font-family="monospace" stroke="none">{init}</text></svg></div>'
        f'<div class="obj-main"><div class="obj-t">{n}</div><div class="obj-s">{r}</div></div></div>'
        for n, r, init in [("Head of state", "in office since 2015", "AD"),
                           ("Head of government", "in office since 2023", "DT"),
                           ("Defence minister", "in office since 2023", "WK")])
    ind = "".join(
        f'<div class="row two"><span class="nm">{n}<span class="sub">{u}</span></span>'
        f'<span class="mark">{count(v)}{spark(s, cl, 72, 16)}</span></div>'
        for n, u, v, s, cl in [
            ("GDP per capita", "World Bank &middot; current USD", "22,113",
             [14, 15, 16, 16, 18, 19, 20, 21, 22], ""),
            ("Military expenditure", "SIPRI &middot; share of GDP", "3.9 %",
             [2.2, 2.2, 2.4, 2.4, 3.0, 3.3, 3.9, 3.9, 3.9], "warn"),
            ("Population", "UN WPP &middot; millions", "36.7",
             [38, 38, 37.9, 37.8, 37.6, 37.2, 36.9, 36.8, 36.7], ""),
            ("Refugee arrivals", "UNHCR &middot; thousands", "982",
             [12, 14, 18, 640, 920, 1010, 995, 988, 982], "warn"),
        ])
    body = f"""<div class="grid g3">
  {card('Leadership', leaders, flush=True, right='<span class="chip mut">Wikidata</span>')}
  {card('Indicators', ind, flush=True)}
  {card('Instability score',
        stat('Composite, 0 to 100', '38',
             spark([22, 24, 23, 27, 31, 29, 34, 36, 38], 'warn', 150, 30)) +
        bars_chart([('Conflict events', 0.42, 'warn'), ('Displacement', 0.71, 'warn'),
                    ('Economic stress', 0.28, ''), ('Governance', 0.19, '')]))}
  {card('Security posture',
        kv('Conflict events, 30 d', '118') + kv('UCDP fatalities', '1,204') +
        kv('Installations tracked', '87') + kv('Airspace restrictions', '14') +
        kv('Naval warnings', '&mdash;', 'none'))}
  {card('Air and sea activity',
        bars_chart([('Military flights', 0.64, 'warn'), ('Civil flights', 0.88, ''),
                    ('Cargo calls', 0.51, ''), ('Tanker calls', 0.33, '')]))}
  {card('Brief',
        '<p style="margin:0;font-size:13px;line-height:1.65;color:var(--txt-1)">'
        'Military expenditure has held near 3.9 % of GDP for three years, the highest '
        'in the set. Refugee arrivals plateaued in 2024 after the 2022 step change and '
        'have not returned to the pre-2022 baseline.</p>'
        '<p class="mut" style="margin:8px 0 0;font-size:12px">Generated from the indicator '
        'series above. Every number in this paragraph appears in a card on this page.</p>')}
</div>"""
    return app_shell("Country", tabs=["Overview", "Security", "Economy", "Sources"],
                     active="Overview", body=body)


def markets_page() -> str:
    body = f"""<div class="grid g3">
  {card('Stress index',
        stat('Composite, 0 to 100', '61',
             spark([38, 41, 44, 42, 49, 53, 51, 58, 61], 'warn', 150, 30)) +
        bars_chart([('Energy', 0.78, 'warn'), ('Shipping rates', 0.66, 'warn'),
                    ('FX volatility', 0.44, ''), ('Sovereign spreads', 0.31, ''),
                    ('Equities', 0.19, '')]))}
  {card('Instruments', "".join(
      f'<div class="row two"><span class="nm">{s}<span class="sub">{n}</span></span>'
      f'<span class="mark">{count(v)}{spark(sr, cl, 72, 16)}</span></div>'
      for s, n, v, sr, cl in [
          ('BRENT', 'crude, USD/bbl', '88.40', [72, 74, 79, 77, 82, 85, 84, 87, 88], 'warn'),
          ('TTF', 'gas, EUR/MWh', '41.20', [30, 33, 31, 36, 38, 37, 40, 41, 41], 'warn'),
          ('BDI', 'dry bulk index', '1,904', [1600, 1650, 1710, 1680, 1750, 1820, 1790, 1880, 1904], ''),
          ('EURUSD', 'spot', '1.0812', [1.09, 1.088, 1.086, 1.087, 1.084, 1.083, 1.082, 1.081, 1.0812], ''),
      ]), flush=True)}
  {card('Prediction markets', "".join(
      f'<div class="row"><span class="nm">{q}</span>'
      f'<span class="mark">{count(f"{p:.0f} %")}{bar(0, p / 100, cl)}</span></div>'
      for q, p, cl in [('Chokepoint closure before Q4', 18, ''),
                       ('Sanctions expanded before Q4', 44, ''),
                       ('Ceasefire holds through Q3', 63, 'ok'),
                       ('Energy cap revised', 27, '')]),
        right='<span class="chip mut">Polymarket</span>')}
</div>"""
    return app_shell("Markets", tabs=["Overview", "Instruments", "Predictions"],
                     active="Overview", body=body)


def foundry_page() -> str:
    dag_nodes = [(6, 40, "adsb_raw", "ok"), (28, 22, "clean_positions", "ok"),
                 (28, 58, "ais_raw", "ok"), (50, 40, "join_contacts", "ok"),
                 (72, 24, "contact_hours", "warn"), (72, 58, "chokepoint_load", "ok")]
    edges = [(0, 1), (1, 3), (2, 3), (3, 4), (3, 5)]
    lines = "".join(
        f'<path class="glink" d="M {dag_nodes[a][0] + 9} {dag_nodes[a][1] + 4} '
        f'C {(dag_nodes[a][0] + dag_nodes[b][0]) / 2 + 11.5} {dag_nodes[a][1] + 4}, '
        f'{(dag_nodes[a][0] + dag_nodes[b][0]) / 2} {dag_nodes[b][1] + 4}, '
        f'{dag_nodes[b][0]} {dag_nodes[b][1] + 4}"/>'
        for a, b in edges)
    rects = "".join(
        f'<g><rect x="{x}" y="{y}" width="23" height="9" rx="1" fill="var(--bg-2)" '
        f'stroke="{"var(--warn)" if s == "warn" else "var(--brd)"}"/>'
        f'<text x="{x + 11.5}" y="{y + 5.8}" text-anchor="middle" fill="var(--txt-1)" '
        f'font-size="3.0">{n}</text></g>'
        for x, y, n, s in dag_nodes)
    builds = "".join(
        f'<tr><td>{n}</td><td class="num">{r}</td><td><span class="chip mut">{d}</span></td>'
        f'<td><span class="mark">{count(f"{p * 100:.0f} %")}{bar(0, p, c)}</span></td></tr>'
        for n, r, d, p, c in [
            ("contact_hours", "1,204,881", "2 min ago", 1.0, "ok"),
            ("chokepoint_load", "9,204", "14 min ago", 1.0, "ok"),
            ("join_contacts", "44,109,022", "1 h ago", 1.0, "ok"),
            ("clean_positions", "44,882,104", "1 h ago", 0.62, "warn"),
        ])
    body = f"""<div class="grid g2">
  {card('Pipeline',
        f'<svg class="chart dag" viewBox="0 0 96 76" aria-label="Transform dependency graph">'
        f'{lines}{rects}</svg>'
        + banner('warn', 'warning',
                 'contact_hours is stale. Its input clean_positions rebuilt 1 h ago and '
                 'the schedule has not fired since.'))}
  {card('Datasets', "".join(
      f'<div class="row two">{ic("table", "ic-sm")}<span class="nm">{n}'
      f'<span class="sub">{s}</span></span>'
      f'<span class="mark">{count(r)}{bar(0, p)}</span></div>'
      for n, s, r, p in [
          ('adsb_positions', 'parquet &middot; 12 columns', '44.8 M', 1.0),
          ('ais_positions', 'parquet &middot; 14 columns', '31.2 M', 0.70),
          ('port_calls', 'csv &middot; 9 columns', '182 k', 0.01),
          ('facility_registry', 'csv &middot; 21 columns', '125 k', 0.01),
      ]), flush=True)}
  {card('Recent builds',
        f'<table class="tbl"><thead><tr><th>Transform</th><th style="text-align:right">Rows out</th>'
        f'<th>When</th><th>Completion</th></tr></thead><tbody>{builds}</tbody></table>', flush=True)}
  {card('Storage',
        stat('Managed bytes', '182 GB',
             spark([120, 128, 134, 141, 152, 160, 171, 178, 182], '', 150, 30)) +
        bars_chart([('adsb_positions', 0.61, ''), ('ais_positions', 0.28, ''),
                    ('everything else', 0.11, '')]))}
</div>"""
    return app_shell("Foundry", tabs=["Overview", "Datasets", "Pipeline", "Builds", "Ontology"],
                     active="Overview", body=body)


def workflows_page() -> str:
    nodes = [(6, 30, "on schedule", "ok"), (28, 30, "query snapshot", "ok"),
             (50, 14, "detect anomaly", "ok"), (50, 46, "enrich vessel", "warn"),
             (72, 30, "notify webhook", "")]
    edges = [(0, 1), (1, 2), (1, 3), (2, 4), (3, 4)]
    lines = "".join(
        f'<path class="glink" d="M {nodes[a][0] + 18} {nodes[a][1] + 4.5} '
        f'C {(nodes[a][0] + nodes[b][0]) / 2 + 11.5} {nodes[a][1] + 4.5}, '
        f'{(nodes[a][0] + nodes[b][0]) / 2} {nodes[b][1] + 4.5}, '
        f'{nodes[b][0]} {nodes[b][1] + 4.5}"/>' for a, b in edges)
    rects = "".join(
        f'<g><rect x="{x}" y="{y}" width="23" height="9" rx="1" fill="var(--bg-2)" '
        f'stroke="{"var(--warn)" if s == "warn" else "var(--brd)"}"/>'
        f'<rect x="{x}" y="{y}" width="1.4" height="9" '
        f'fill="{"var(--warn)" if s == "warn" else "var(--ok)" if s == "ok" else "var(--bg-4)"}"/>'
        f'<text x="{x + 11.5}" y="{y + 5.8}" text-anchor="middle" fill="var(--txt-1)" '
        f'font-size="3.0">{n}</text></g>' for x, y, n, s in nodes)
    runs = "".join(
        f'<tr><td>{t}</td><td><span class="chip mut">{d}</span></td>'
        f'<td class="num">{ms}</td>'
        f'<td><span class="mark">{count(st)}{bar(0, p, c)}</span></td></tr>'
        for t, d, ms, st, p, c in [
            ("Baltic anomaly sweep", "3 min ago", "1,204 ms", "ok", 1.0, "ok"),
            ("Baltic anomaly sweep", "18 min ago", "1,180 ms", "ok", 1.0, "ok"),
            ("Baltic anomaly sweep", "33 min ago", "8,402 ms", "slow", 0.42, "warn"),
            ("Chokepoint digest", "1 h ago", "980 ms", "ok", 1.0, "ok"),
        ])
    body = f"""<div class="grid g2">
  {card('Editor', f'<svg class="chart dag" viewBox="0 0 96 60" aria-label="Workflow graph">{lines}{rects}</svg>')}
  {card('Run history',
        f'<table class="tbl"><thead><tr><th>Workflow</th><th>When</th>'
        f'<th style="text-align:right">Duration</th><th>Result</th></tr></thead>'
        f'<tbody>{runs}</tbody></table>', flush=True)}
  {card('Run duration', f'''<svg class="chart" viewBox="0 0 300 96" aria-label="Run duration over the last 24 runs">
    <line class="grid-line" x1="0" y1="20" x2="300" y2="20"/>
    <line class="grid-line" x1="0" y1="50" x2="300" y2="50"/>
    <line class="grid-line" x1="0" y1="80" x2="300" y2="80"/>
    <text class="ax" x="0" y="17">9 s</text><text class="ax" x="0" y="47">5 s</text>
    <text class="ax" x="0" y="90">1 s</text>
    {"".join(f'<rect class="{"b-mil" if h > 46 else "b-acc"}" x="{28 + i * 11}" y="{80 - h}" width="7" height="{h}"/>' for i, h in enumerate([9, 11, 10, 12, 9, 10, 58, 11, 10, 9, 12, 10, 11, 9, 10, 11, 10, 9, 12, 10, 9, 11, 10, 9]))}
  </svg>
  <div class="legend"><span><i style="background:var(--d-mil)"></i>over the 5 s budget</span>
  <span><i style="background:var(--accent)"></i>within budget</span></div>''')}
  {card('Blocks', bars_chart([('Python', 0.44, ''), ('SQL', 0.28, ''), ('LLM', 0.16, ''),
                              ('HTTP out', 0.08, ''), ('Webhook', 0.04, '')]))}
</div>"""
    return app_shell("Workflows", tabs=["Workflows", "Runs", "Blocks"], active="Workflows", body=body)


def reports_page() -> str:
    ev = "".join(
        f'<div class="obj-card">{thumb("airliner", None, None, i)}'
        f'<div class="obj-main"><div class="obj-t">{t}</div><div class="obj-s">{s}</div></div>'
        f'<span class="chip mut">{c}</span></div>'
        for t, s, i, c in [
            ("Sentinel-1 chip, 33UXP", "captured 2026-07-26 &middot; sha 4f2a…", "image", "sealed"),
            ("Track export, LN-FNL", "captured 2026-07-28 &middot; sha 91cc…", "chart-line", "sealed"),
            ("Screenshot, berth 4", "captured 2026-07-28 &middot; sha 0ab7…", "capture", "sealed"),
        ])
    body = f"""<div class="grid g3">
  {card('Case files', "".join(
      f'<div class="row two">{ic("folder", "ic-sm")}<span class="nm">{n}'
      f'<span class="sub">{s}</span></span>'
      f'<span class="mark">{count(c)}{bar(0, p)}</span></div>'
      for n, s, c, p in [('Baltic approaches', 'open &middot; 4 analysts', '182', 0.9),
                         ('Chokepoint watch', 'open &middot; 1 analyst', '44', 0.22),
                         ('Dark vessel sweep', 'closed 2026-07-19', '311', 0.62)]), flush=True)}
  {card('Evidence locker', ev, flush=True,
        right='<span class="chip mut">chain of custody</span>')}
  {card('Alerts by severity', f'''<svg class="chart" viewBox="0 0 300 110" aria-label="Alerts by severity">
    <line class="grid-line" x1="0" y1="20" x2="300" y2="20"/>
    <line class="grid-line" x1="0" y1="55" x2="300" y2="55"/>
    <line class="grid-line" x1="0" y1="90" x2="300" y2="90"/>
    <rect class="b-mut" x="18"  y="66" width="34" height="24"/>
    <rect class="b-acc" x="72"  y="42" width="34" height="48"/>
    <rect class="b-air" x="126" y="28" width="34" height="62"/>
    <rect class="b-mil" x="180" y="58" width="34" height="32"/>
    <rect fill="var(--err)" x="234" y="78" width="34" height="12"/>
    <text class="ax" x="22"  y="104">info</text><text class="ax" x="76"  y="104">low</text>
    <text class="ax" x="128" y="104">medium</text><text class="ax" x="184" y="104">high</text>
    <text class="ax" x="236" y="104">critical</text>
  </svg>
  <p class="mut" style="margin:6px 0 0;font-size:12px">The same five counts used to render as
  the string <span class="mono">info 12 &middot; low 24 &middot; medium 31 &middot; high 16 &middot; critical 6</span>.</p>''')}
</div>"""
    return app_shell("Reports", tabs=["Case files", "Evidence", "Brief", "Metrics"],
                     active="Case files", body=body)


def city_page() -> str:
    body = f"""<div style="display:grid;grid-template-columns:1fr 300px;gap:12px;height:100%;min-height:0">
  <div class="card" style="min-height:0;display:flex;flex-direction:column">
    <div class="card-h">Gdansk &middot; 268,412 gaussians<span class="sp"></span>
      <span class="chip mut">{ic('cpu', 'ic-sm')}GPU splat</span></div>
    <div class="card-b flush" style="flex:1;position:relative;min-height:0;background:#0d1013">
      <div style="position:absolute;inset:0;background:
        linear-gradient(#141a20 0%, #1b2229 42%, #10151a 100%)"></div>
      <div style="position:absolute;left:0;right:0;bottom:0;height:62%;background:
        repeating-linear-gradient(90deg, rgba(140,170,200,.10) 0 2px, transparent 2px 26px),
        repeating-linear-gradient(0deg, rgba(140,170,200,.07) 0 2px, transparent 2px 18px)"></div>
      <div style="position:absolute;left:12%;bottom:8%;width:9%;height:44%;background:
        linear-gradient(#2b333c,#1a2027);box-shadow:0 0 24px rgba(0,0,0,.5)"></div>
      <div style="position:absolute;left:26%;bottom:8%;width:12%;height:31%;background:
        linear-gradient(#252c34,#161b21)"></div>
      <div style="position:absolute;left:44%;bottom:8%;width:7%;height:56%;background:
        linear-gradient(#303841,#1c222a)"></div>
      <div style="position:absolute;left:57%;bottom:8%;width:14%;height:26%;background:
        linear-gradient(#222930,#141920)"></div>
      <div style="position:absolute;left:76%;bottom:8%;width:10%;height:38%;background:
        linear-gradient(#2a323a,#181d24)"></div>
    </div>
  </div>
  <aside class="panel" style="border:1px solid var(--brd);border-radius:2px">
    {panel_head('Scene')}
    <div class="panel-body">
      {sect('Source')}
      {kv('Imagery', 'Sentinel-2', 'txt')}
      {kv('Acquired', '2026-07-24')}
      {kv('Method', 'feed-forward', 'txt')}
      {kv('Gaussians', '268,412')}
      {sect('Budget')}
      <div class="pad">
        <div class="row"><span class="nm">VRAM</span>
          <span class="mark">{count('3.1 GB')}{bar(0, 0.39)}</span></div>
        <div class="row"><span class="nm">Render cost</span>
          <span class="mark">{count('11 ms')}{bar(0, 0.66, 'ok')}</span></div>
        <div class="row"><span class="nm">Splat count</span>
          <span class="mark">{count('268 k')}{bar(0, 0.54)}</span></div>
      </div>
      {banner('warn', 'warning',
              'This scene is reconstructed from one satellite pass. It is a shape, not a survey, '
              'and should not be measured against.')}
    </div>
  </aside>
</div>"""
    return app_shell("City 3D", tabs=["Scene", "Build", "Export"], active="Scene", body=body)


def ai_page() -> str:
    body = f"""<div class="grid g3">
  {card('Selection brief',
        '<p style="margin:0;font-size:13px;line-height:1.65;color:var(--txt-1)">'
        'LN-FNL is a Boeing 787-9 operated by Norse Atlantic Airways, currently at FL390 '
        'on a JFK to FCO routing. Its altitude is 2,400 ft above this route&rsquo;s median '
        'for the hour, which two of the last nine flights also did.</p>'
        '<div class="hr"></div>'
        '<p class="mut" style="margin:0;font-size:12px;line-height:1.6">Every claim above '
        'is drawn from a card in the Selection panel. Nothing here is inferred beyond the '
        'series shown.</p>',
        right='<span class="chip mut">local model</span>')}
  {card('Engine',
        kv('Backend', 'llama.cpp', 'txt') + kv('Model', 'Qwen3-14B-Q5', 'txt') +
        '<div class="kv"><dt>VRAM</dt><dd><span class="mark">' + count('11.4 GB') +
        bar(0, 0.48) + '</span></dd></div>'
        '<div class="kv"><dt>Time to first byte</dt><dd><span class="mark">' + count('412 ms') +
        spark([980, 720, 610, 520, 470, 440, 420, 412], 'ok', 52, 13) + '</span></dd></div>' +
        kv('Cache hit rate', '68 %'))}
  {card('Throughput', f'''<svg class="chart" viewBox="0 0 300 96" aria-label="Tokens per second, last 24 briefs">
    <line class="grid-line" x1="0" y1="16" x2="300" y2="16"/>
    <line class="grid-line" x1="0" y1="48" x2="300" y2="48"/>
    <line class="grid-line" x1="0" y1="80" x2="300" y2="80"/>
    <text class="ax" x="0" y="13">90</text><text class="ax" x="0" y="45">55</text>
    <text class="ax" x="0" y="88">20</text>
    <polyline points="{" ".join(f"{24 + i * 11.5},{80 - v}" for i, v in enumerate([38, 42, 40, 46, 52, 49, 55, 58, 54, 60, 62, 59, 64, 61, 66, 63, 68, 65, 62, 67, 64, 66, 63, 65]))}"
      fill="none" stroke="var(--accent-fg)" stroke-width="1.6"/>
  </svg>
  <div class="legend"><span><i style="background:var(--accent-fg)"></i>tokens per second</span></div>''')}
  {__import__('_decide').ai_weight_card()}
  {card('Watch officer',
        "".join(f'<div class="row two">{ic(i, "ic-sm")}<span class="nm">{t}'
                f'<span class="sub">{s}</span></span>'
                f'<span class="mark">{count(c)}{bar(0, p, cl)}</span></div>'
                for t, s, i, c, p, cl in [
                    ('Dark vessel near Gdynia', 'AIS silent 41 min', 'ship', 'high', 0.82, 'warn'),
                    ('Military track, Kaliningrad', '3 airframes, formation', 'plane', 'high', 0.77, 'warn'),
                    ('Chokepoint load rising', 'Danish straits', 'route', 'medium', 0.44, ''),
                    ('Emergency squawk cleared', 'resolved 12 min ago', 'check', 'closed', 0.12, 'ok'),
                ]), flush=True)}
</div>"""
    return app_shell("AI", tabs=["Brief", "Watch officer", "Models"], active="Brief", body=body)


APPS = {
    "20-graph.html": ("Graph", graph_page),
    "21-explorer.html": ("Explorer", explorer_page),
    "22-investigate.html": ("Investigate", investigate_page),
    "23-targeting.html": ("Targeting", targeting_page),
    "24-video.html": ("Video", video_page),
    "25-country.html": ("Country", country_page),
    "26-markets.html": ("Markets", markets_page),
    "27-foundry.html": ("Foundry", foundry_page),
    "28-workflows.html": ("Workflows", workflows_page),
    "29-reports.html": ("Reports", reports_page),
    "30-city.html": ("City 3D", city_page),
    "31-ai.html": ("AI", ai_page),
}
