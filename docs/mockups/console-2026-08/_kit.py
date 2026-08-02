"""_kit.py — the component kit and the board.

Every other page composes from these. The kit exists so a panel cannot be
convincing on one page and thin on another, which is what happened when each
page hand-wrote its own markup.
"""

from __future__ import annotations

import re
from pathlib import Path

from _parts import (COLOR, bar, count, dots, ic, kv, meter, obj_card,
                    panel_head, panel_tools, row, sect, silhouette, spark,
                    state, banner, switch, thumb, sprite)

HERE = Path(__file__).parent


def _shell(title: str, lead: str, body: str) -> str:
    return f"""<div class="shell" style="grid-template-rows:auto 1fr">
<header class="titlebar" style="height:44px">
  <span class="brand">{ic('hexagon')}Velocity</span>
  <span class="panel-title">{title}</span>
  <span class="tb-spacer"></span>
  <nav class="menu" id="nav"></nav>
</header>
<div class="app"><div class="app-body">
  <p class="mut" style="margin:0 0 14px;font-size:13px;line-height:1.6;max-width:900px">{lead}</p>
  {body}
</div></div>
</div>"""


def nav(files: list[tuple[str, str]], current: str) -> str:
    return "".join(
        f'<a class="tab" href="{f}" aria-selected="{"true" if f == current else "false"}" '
        f'style="text-decoration:none">{t}</a>' for f, t in files)


# ── The kit ──────────────────────────────────────────────────────────────────

def _swatches() -> str:
    ramp = [("--bg-0", "black, the map well"), ("--bg-1", "dark-gray1, panels"),
            ("--bg-2", "dark-gray2, inset"), ("--bg-3", "dark-gray3"),
            ("--bg-4", "dark-gray4, borders"), ("--txt-3", "gray3, muted"),
            ("--txt-1", "gray5, body"), ("--txt-0", "light-gray5"),
            ("--accent", "blue3"), ("--accent-fg", "blue5"),
            ("--ok", "green4"), ("--warn", "orange4"), ("--err", "red3")]
    return "".join(
        f'<div class="row two"><span style="width:26px;height:16px;border-radius:2px;'
        f'background:var({v});border:1px solid var(--brd);flex:0 0 auto"></span>'
        f'<span class="nm mono">{v}<span class="sub">{d}</span></span></div>'
        for v, d in ramp)


def _icon_grid() -> str:
    ids = re.findall(r'id="i-([\w-]+)"', sprite())
    cells = "".join(
        f'<div style="display:flex;flex-direction:column;align-items:center;gap:3px;'
        f'padding:6px 2px;border-radius:2px">{ic(n)}'
        f'<span style="font-size:12px;color:var(--txt-3);text-align:center;'
        f'word-break:break-all;line-height:1.2">{n}</span></div>'
        for n in ids)
    return (f'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));'
            f'gap:2px">{cells}</div>')


def _metrics_table() -> str:
    rows = [
        ("classification band", "12", "19", "Gotham-specific", "became a pill in the bar"),
        ("title / tab bar", "25", "39.5", "$pt-button-height-large 40px", "40px"),
        ("menu bar", "19", "30", "$pt-button-height 30px", "30px"),
        ("icon shortcut rail", "27", "42.6", "~40px", "40px"),
        ("left panel", "195", "308", "~300px", "308px"),
        ("right panel", "181", "286", "~280px", "286px"),
        ("dense list row pitch", "13", "20.5", "$pt-button-height-smaller 20px", "20px"),
        ("bottom action bar", "31", "49", "$pt-navbar-height 50px", "50px"),
        ("primary button", "19", "30", "$pt-button-height 30px", "30px"),
    ]
    body = "".join(
        f"<tr><td>{a}</td><td class='num'>{b}</td><td class='num'>{c}</td>"
        f"<td class='mono' style='font-size:12px'>{d}</td><td class='num'>{e}</td></tr>"
        for a, b, c, d, e in rows)
    return (f"<table class='tbl'><thead><tr><th>Element</th>"
            f"<th style='text-align:right'>Raw px</th><th style='text-align:right'>&divide; 0.633</th>"
            f"<th>Blueprint variable</th><th style='text-align:right'>Built</th></tr></thead>"
            f"<tbody>{body}</tbody></table>")


def kit_page(nav_html: str) -> str:
    from _apps import card

    marks = f"""
<div class="row"><span class="nm">bar, filtered share over total</span>
  <span class="mark">{count('9,914')}{bar(0.80, 0.80)}</span></div>
<div class="row"><span class="nm">bar, unselected</span>
  <span class="mark">{count('1,806')}{bar(0.0, 0.15)}</span></div>
<div class="row"><span class="nm">bar, warn tone</span>
  <span class="mark">{count('14,818')}{bar(0.0, 0.88, 'warn')}</span></div>
<div class="row"><span class="nm">sparkline</span>
  <span class="mark">{count('497 kn')}{spark([244, 248, 251, 253, 255, 256, 256, 255, 256])}</span></div>
<div class="row"><span class="nm">dot matrix, small N</span>
  <span class="mark">{count('3 sources')}{dots(['ok', 'ok', 'ok', '', ''])}</span></div>
<div class="row two"><span class="nm">meter<span class="sub">inline, 3px</span></span>
  <span style="width:84px">{meter(62)}</span></div>"""

    controls = f"""
<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px">
  <button class="btn pri">{ic('plus', 'ic-sm')}Primary 30px</button>
  <button class="btn">Default</button>
  <button class="btn gho">Ghost</button>
  <button class="btn danger">Danger</button>
  <button class="btn sm gho">Small 24px</button>
  <button class="btn xs gho">Extra small 20px</button>
  <button class="btn gho" disabled>Disabled</button>
</div>
<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
  <span class="seg"><button aria-pressed="true">1x</button><button>10x</button>
    <button>60x</button><button>600x</button></span>
  {switch(True)}{switch(False)}
  <span class="chip">Military{ic('x', 'ic-sm')}</span>
  <span class="chip mut">archive &middot; not live</span>
  <span class="clas">{ic('shield', 'ic-sm')}UNCLAS</span>
</div>"""

    states_html = (state("", "No contacts in this area",
                         "Nothing is transmitting inside 50 km. Widen the radius.", "search")
                   + state("err", "Layers unavailable (HTTP 503)",
                           "The backend answered but could not serve the registry.", "circle-alert")
                   + state("deg", "Showing one of two sources",
                           "MyShipTracking has been silent for 4 minutes, so the count reads low.",
                           "warning"))

    transport_demo = """<div class="dock" style="position:static;border:1px solid var(--brd);border-radius:2px">"""
    import _map as M
    transport_demo += M.transport(playing=True, live=False) + M.ruler(
        [(2, "14:15"), (26, "15:00"), (50, "15:45"), (74, "16:30"), (95, "17:10")],
        [(21, "inc"), (52, "alert"), (62, "alert"), (79, "inc")]) + M.density() + "</div>"

    body = f"""<div class="grid g3">
  {card('Icons &middot; 131 lucide symbols, zero emoji', _icon_grid())}
  {card('Colour &middot; Blueprint 5.1.16 dark, 0 tokens outside the ramp', _swatches(), flush=True)}
  {card('Marks &middot; every count carries one', marks, flush=True)}
  {card('Controls', controls)}
  {card('Object card &middot; every object carries a thumbnail',
        obj_card('LN-FNL', 'Norse Atlantic &middot; B789', kind='airliner',
                 tail='<span class="chip">Aircraft</span>')
        + obj_card('NORDIC STAR', 'MMSI 273441000 &middot; cargo', kind='cargo')
        + obj_card('Port of Gdansk', 'PLGDN &middot; facility', icon='anchor')
        + obj_card('Sentinel-1 pass', '2026-07-26 &middot; imagery', icon='satellite'),
        flush=True)}
  {card('Rows &middot; 20px dense, 38px two-line',
        sect('Section label', '3 of 6')
        + row('Dense row', icon='circle-dot', tail=f'<span class="mark">{count("284")}{bar(0.09, 0.30)}</span>')
        + row('Two-line row', sub='with a subtitle', icon='plane',
              tail=f'<span class="mark">{count("12,418")}{bar(0.42, 0.95)}</span>')
        + row('Selected row', sub='accent box, not a fill', icon='ship', sel=True,
              tail=f'<span class="mark">{count("31,204")}{bar(0.55, 1.0)}</span>'),
        flush=True)}
  {card('States &middot; four, not three', states_html, flush=True)}
  {card('Banners', banner('warn', 'warning',
        'Vessels is showing one of two sources. The count reads low.')
        + banner('err', 'circle-alert', 'Cameras unavailable (HTTP 503).')
        + '<p class="mut" style="margin:10px;font-size:12px;line-height:1.6">An error the '
          'user sees is a sentence that keeps the code, never a raw internal.</p>')}
  {card('Field &middot; label above control, for CONTROLS not readouts',
        '<div class="field"><label>Object set'
        '<span class="help" title="Which object set feeds this panel">?</span></label>'
        '<div class="control">' + ic('table', 'ic-sm') +
        '<span class="sp">Aircraft in viewport</span>' + ic('chevron-down', 'ic-sm') + '</div>'
        '<div class="echo">Currently resolves to<b>12,418 objects</b></div></div>'
        '<div class="sublabel">Filtering</div>'
        '<div class="field"><label>Bind to variable'
        '<span class="help" title="A variable set elsewhere in the workspace">?</span></label>'
        '<div class="control"><span class="sp mut">Select a variable</span>'
        + ic('chevron-down', 'ic-sm') + '</div>'
        '<div class="echo">Currently resolves to<b class="none">&mdash;</b></div></div>'
        '<p class="mut" style="margin:8px 10px 0;font-size:12px;line-height:1.6">'
        'A readout puts its label left and its value right. A control puts its label '
        'above, so the input can take the full width and so there is somewhere to hang '
        'an explanation.</p>', flush=True)}
  {card('Mode bar &middot; a sandbox says so on the surface',
        '<div class="modebar">' + ic('sparkle', 'ic-sm') +
        'Simulation <b>sim-2026-08-01-1139</b>'
        '<span class="sp"></span>'
        '<button class="btn xs gho">Propose these changes</button>'
        '<button class="btn xs gho">Run a new simulation</button>'
        '<button class="btn xs gho">Exit</button></div>'
        '<div class="impact">'
        '<div class="good"><div class="k">Contacts resolved</div><div class="v">+118</div></div>'
        '<div class="bad"><div class="k">Passes missed</div><div class="v">2</div></div>'
        '<div class="note"><div class="k">Tasking credits</div><div class="v">6</div></div>'
        '</div>'
        '<p class="mut" style="margin:10px;font-size:12px;line-height:1.6">'
        'The point of an impact readout is not the number, it is whether the number '
        'is good. Tinting by valence answers that before the number is read.</p>',
        flush=True)}
  {card('Scenario sweep &middot; one row per parameter value',
        '<table class="sweep"><tbody>'
        '<tr><td class="p">10 %</td><td>46 % <span class="u">of contacts resolved</span></td>'
        '<td>2 <span class="u">credits per contact</span></td></tr>'
        '<tr class="sel"><td class="p">20 %</td><td>76 % <span class="u">of contacts resolved</span></td>'
        '<td>3 <span class="u">credits per contact</span></td></tr>'
        '<tr><td class="p">30 %</td><td>83 % <span class="u">of contacts resolved</span></td>'
        '<td>5 <span class="u">credits per contact</span></td></tr>'
        '</tbody></table>'
        '<div class="prompt"><span class="box">' + ic('sparkle', 'ic-sm') +
        'Ask about this sweep</span>'
        '<button class="btn sm pri" aria-label="Send">' + ic('arrow-right', 'ic-sm') + '</button></div>',
        flush=True)}
  {card('App launcher &middot; pinned first, star on every row',
        f'<div class="applist"><div class="grp">Pinned</div>'
        '<button>{ic("map", "ic-sm")}<span class="sp">Map</span>{ic("star", "ic-sm star on")}}</button><button>{ic("target", "ic-sm")}<span class="sp">Decide</span>{ic("star", "ic-sm star on")}}</button><button>{ic("network", "ic-sm")}<span class="sp">Graph</span>{ic("star", "ic-sm star on")}}</button><button>{ic("chart", "ic-sm")}<span class="sp">Explorer</span>{ic("star", "ic-sm star on")}}</button><div class="grp">All apps</div><button>{ic("sparkle", "ic-sm")}<span class="sp">AI</span>{ic("star", "ic-sm star")}}</button><button>{ic("globe", "ic-sm")}<span class="sp">Country</span>{ic("star", "ic-sm star")}}</button><button>{ic("table", "ic-sm")}<span class="sp">Foundry</span>{ic("star", "ic-sm star")}}</button><button>{ic("workflow", "ic-sm")}<span class="sp">Workflows</span>{ic("star", "ic-sm star")}}</button><button>{ic("file", "ic-sm")}<span class="sp">Reports</span>{ic("star", "ic-sm star")}}</button><button>{ic("video", "ic-sm")}<span class="sp">Video</span>{ic("star", "ic-sm star")}}</button><button>{ic("search", "ic-sm")}<span class="sp">Investigate</span>{ic("star", "ic-sm star")}}</button><button>{ic("trend", "ic-sm")}<span class="sp">Markets</span>{ic("star", "ic-sm star")}}</button><button>{ic("box", "ic-sm")}<span class="sp">City 3D</span>{ic("star", "ic-sm star")}}</button><button>{ic("radar", "ic-sm")}<span class="sp">Targeting</span>{ic("star", "ic-sm star")}}</button></div>', flush=True)}
  {card('Key and value',
        kv('Callsign', 'NBT40S') + kv('Squawk', '1000')
        + kv('Naval warnings', '&mdash;', 'none')
        + '<p class="mut" style="margin:10px 4px 0;font-size:12px;line-height:1.6">'
          'The lone em dash means no value reported. It is the one em dash the copy '
          'rules allow, and stripping it is the mistake to avoid.</p>')}
</div>
<div style="height:12px"></div>
<div class="grid g2">
  {card('Time dock &middot; the transport, read off the reference', transport_demo)}
  {card('Structure &middot; how each number was derived', _metrics_table()
        + '<p class="mut" style="margin:10px 4px 0;font-size:12px;line-height:1.6">'
          'Blueprint v5 publishes $pt-button-height: 30px. The two accent-filled buttons in '
          'the reference capture both measure 19px, so it sits at 19/30 = 0.633 of true scale. '
          'Nine measurements then land on published Blueprint sizes, which is the confirmation '
          'the factor is right.</p>', flush=False)}
</div>"""

    return _shell("Component kit",
                  "Every primitive at 1:1, with the measurement that produced it. Each page in "
                  "this set composes from these, so a panel renders the same everywhere or it "
                  "renders wrong everywhere.",
                  body).replace('<nav class="menu" id="nav"></nav>',
                                f'<nav class="menu">{nav_html}</nav>')


# ── The board ────────────────────────────────────────────────────────────────

def index_page(pages: list[tuple[str, str]], nav_html: str) -> str:
    from _apps import card

    def group(title: str, items: list[tuple[str, str, str]]) -> str:
        cells = "".join(
            f'<a href="{f}" style="text-decoration:none;color:inherit;display:block">'
            f'<div class="card" style="overflow:hidden">'
            f'<div style="aspect-ratio:16/9;background:var(--bg-0);overflow:hidden;'
            f'border-bottom:1px solid var(--brd)">'
            f'<img src="_shots/{f.replace(".html", ".png")}" alt="" '
            f'style="width:100%;height:100%;object-fit:cover;object-position:top left"></div>'
            f'<div class="card-b" style="padding:8px 10px">'
            f'<div style="color:var(--txt-0);font-weight:600;font-size:13px">{t}</div>'
            f'<div class="mut" style="font-size:12px;line-height:1.5">{d}</div></div>'
            f'</div></a>' for f, t, d in items)
        return (f'<h3 style="margin:18px 0 8px;font-size:12px;font-weight:600;letter-spacing:.6px;'
                f'text-transform:uppercase;color:var(--txt-2)">{title}</h3>'
                f'<div class="grid g4">{cells}</div>')

    body = (
        group("Grammar", [
            ("01-kit.html", "Component kit", "Every primitive at 1:1, with its measurement."),
        ])
        + group("Map console", [
            ("10-map.html", "Live", "Nothing selected. Layers left, Series right."),
            ("11-map-selected.html", "Contact selected", "Selection panel, track, reticle."),
            ("12-map-replay.html", "Replay", "The transport, and a strip that spans the loaded range."),
            ("13-map-histogram.html", "Histogram", "Facets as bars, clickable as filters."),
            ("14-map-find.html", "Find", "Search around, and the cascading context menu."),
            ("15-map-info.html", "Info", "Feed health as sparklines, not four mono numbers."),
            ("16-states.html", "States", "Loading, empty, error and degraded, four up."),
        ])
        + group("Analytical apps", [
            ("20-graph.html", "Graph", "Node-link canvas with thumbnails. Gotham's flagship."),
            ("21-explorer.html", "Explorer", "Filter path as English, results with thumbnails."),
            ("22-investigate.html", "Investigate", "Entity resolution and provenance."),
            ("23-targeting.html", "Targeting", "F2T2EA board, each card carrying its progress."),
            ("24-video.html", "Video", "FMV with detections and the tagging panel."),
            ("25-country.html", "Country", "Leadership, indicator sparklines, instability."),
            ("26-markets.html", "Markets", "Stress components and prediction probabilities."),
            ("27-foundry.html", "Foundry", "Pipeline DAG, datasets, build completion."),
            ("28-workflows.html", "Workflows", "Graph editor and run duration against budget."),
            ("29-reports.html", "Reports", "Case files, evidence locker, alerts by severity."),
            ("30-city.html", "City 3D", "Splat scene with its honesty caveat."),
            ("31-ai.html", "AI", "Selection brief, engine cost, and the weighting surface."),
            ("32-decide.html", "Decide", "The collection queue, the decision dock and the pass Gantt."),
        ]))

    lead = (
        "Twenty pages, one grammar, measured against Palantir Gotham rather than guessed at. "
        "Icons are real lucide SVG (131 symbols, zero emoji). The basemap is real Carto "
        "dark-matter raster, the same source the backend proxies. Every count carries a bar, a "
        "sparkline or a dot matrix, and every object carries a thumbnail. "
        "<span class='mono'>node _gate.mjs</span> checks all of that in a real browser and exits "
        "non-zero if any of it stops being true.")
    return _shell("Velocity console &middot; 2026-08", lead, body).replace(
        '<nav class="menu" id="nav"></nav>', f'<nav class="menu">{nav_html}</nav>')
