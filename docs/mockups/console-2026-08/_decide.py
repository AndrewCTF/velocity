"""_decide.py — the decision surface.

Structural grammar observed in a live product demo and applied to this
product's own domain (satellite tasking over OSINT contacts). What is carried
over is *shape*: a queue of proposal cards each with a status chip, a
label-above-value micro grid, nested sub-cards, and a footer holding the one
fact that decides urgency; a bottom dock that states the proposal and offers
the verbs that resolve it; a Gantt with hour columns and a now-line; a toast at
the top of the surface the action changed.

Nothing else is carried over. The content, the symbology, the palette and the
product identity are this repo's own.

Why this page exists at all: every other page in the set shows the operator
what is true. None of them let the operator DECIDE anything, and a console
whose only verb is "look" is a viewer. This is the missing half.
"""

from __future__ import annotations

from _apps import app_shell, card
from _parts import (COLOR, bar, count, ic, kv, spark, thumb, panel_head)


def ptitle(icon: str, title: str, state: str) -> str:
    return (f'<div class="ptitle">{ic(icon, "ic-lg")}<span>'
            f'<b>{title}</b><span class="st">{state}</span></span>'
            f'<span class="sp" style="flex:1"></span>'
            f'<button class="iconbtn" aria-label="Panel settings">{ic("sliders", "ic-sm")}</button></div>')


def itabs(items: list[tuple[str, str, bool]]) -> str:
    return '<div class="itabs">' + "".join(
        f'<button aria-selected="{"true" if on else "false"}" aria-label="{lab}" title="{lab}">'
        f'{ic(k, "ic-sm")}{lab if on else ""}</button>' for k, lab, on in items
    ) + '<span class="sp" style="flex:1"></span>' \
        f'<button class="iconbtn" aria-label="List options">{ic("more", "ic-sm")}</button></div>'


def chiprow(items: list[tuple[str, str]]) -> str:
    return '<div class="chiprow">' + "".join(
        f'<button class="fchip">{ic(k, "ic-sm")}{lab}</button>' for k, lab in items
    ) + f'<button class="fchip" aria-label="More filters">{ic("more", "ic-sm")}</button></div>'


def wcard(title: str, status: str, status_cls: str, pairs: list[tuple[str, str]],
          subs: list[tuple[str, str, str, str]], foot: str) -> str:
    kvs = "".join(f"<dt>{k}</dt>" for k, _ in pairs[:2]) + \
          "".join(f'<dd class="txt">{v}</dd>' for _, v in pairs[:2]) + \
          "".join(f"<dt>{k}</dt>" for k, _ in pairs[2:]) + \
          "".join(f'<dd class="txt">{v}</dd>' for _, v in pairs[2:])
    sc = "".join(
        f'<div class="subcard"><div class="k">{ic(i, "ic-sm")}{k}</div>'
        f'<div class="v">{ic(vi, "ic-sm")}{v}</div></div>'
        for i, k, vi, v in subs)
    return (f'<div class="wcard"><div class="wcard-h">{ic("satellite", "ic-sm")}'
            f'<span class="t">{title}</span>'
            f'<span class="status {status_cls}">{status}</span></div>'
            f'<dl class="mkv">{kvs}</dl>'
            f'<div class="subcards">{sc}</div>'
            f'<div class="wcard-f">{ic("clock", "ic-sm")}{foot}'
            f'<span class="sp"></span><span class="cls">UNCLAS</span></div></div>')


HOURS = ["06:00Z", "07:00Z", "08:00Z", "09:00Z", "10:00Z"]


def gantt() -> str:
    lanes = [("SENTINEL-1B", "SAR &middot; 6 day revisit", 12, 26, "Pass 41"),
             ("SENTINEL-2A", "optical &middot; cloud 22 %", 44, 18, "Pass 09"),
             ("PLANET SKYSAT", "tasked &middot; 50 cm", 66, 14, "Collect")]
    cols = "".join(f'<span class="tl">{h}</span>' for h in HOURS)
    lane_col = "".join(
        f'<div class="lane">{ic("satellite", "ic-sm")}<span>{n}<span class="sub">{s}</span></span></div>'
        for n, s, *_ in lanes)
    ticks = "".join(f'<i style="left:{i * 20}%"></i>' for i in range(1, 5))
    tracks = "".join(
        f'<div class="track">{ticks}'
        f'<span class="blk" style="left:{x}%;width:{w}%">{lab}</span></div>'
        for _, _, x, w, lab in lanes)
    return (f'<div class="gantt"><div class="lanes">'
            f'<div style="height:20px;border-bottom:1px solid var(--brd-soft)"></div>{lane_col}</div>'
            f'<div class="grid-h"><div class="hours">{cols}</div>{tracks}'
            f'<span class="now" style="left:38%"></span></div></div>')


def match_card() -> str:
    """Asset judged against target, attribute row aligned to attribute row.
    Read across, not held in the head."""
    rows = [("Sensor", "C-band SAR", "n/a &middot; radar cross-section"),
            ("Resolution", "5 m", "hull 180 m &middot; resolvable"),
            ("Time to target", "26 min", "drift box 11.4 km"),
            ("Cloud", "not affected", "22 % forecast &middot; irrelevant"),
            ("Cost", "1 tasking credit", "&mdash;")]
    body = "".join(
        f'<div class="match-row lab"><span>{k}</span><span>&nbsp;</span></div>'
        f'<div class="match-row"><span>{a}</span><span>{b}</span></div>'
        for k, a, b in rows)
    return f"""<div class="match">
  <div class="match-h">{ic('check', 'ic-sm')}Best available match
    <span class="sp"></span>
    <button class="btn xs gho">{ic('pencil', 'ic-sm')}Change asset</button></div>
  <div class="match-b">
    <div><div class="match-t">{ic('satellite', 'ic-sm')}SENTINEL-1B</div>
      <div class="match-s">SAR &middot; pass 41</div></div>
    <div><div class="match-t">{ic('ship', 'ic-sm')}MMSI 273441000</div>
      <div class="match-s">Cargo &middot; AIS silent 41 min</div></div>
  </div>
  {body}
  <div class="match-f">{ic('radio', 'ic-sm')}Live &middot; ephemeris updated 8 s ago
    <span class="sp"></span><span class="chip mut">modelled</span></div>
</div>"""


def decide_page() -> str:
    queue = (
        wcard("Dark vessel &rarr; SAR confirmation", "proposed", "proposed",
              [("Time on target", "08:42:10Z"),
               ("Raised", "4 min ago by watch officer"),
               ("Confidence", "0.82 &middot; AIS silent 41 min"),
               ("Area", "Gulf of Gdansk &middot; 33UXP")],
              [("satellite", "1 SAR pass", "clock", "Sentinel-1B in 26 min"),
               ("ship", "1 contact", "warning", "MMSI 273441000")],
              "Decision closes in 18 minutes")
        + wcard("Military formation &rarr; revisit", "hold", "hold",
                [("Time on target", "09:15:00Z"),
                 ("Raised", "22 min ago by detector"),
                 ("Confidence", "0.61 &middot; 3 airframes"),
                 ("Area", "Kaliningrad &middot; 34UEE")],
                [("satellite", "1 optical pass", "cloud", "22 % cloud forecast"),
                 ("plane", "3 contacts", "check", "tracks corroborated")],
                "Held for cloud cover")
        + wcard("Chokepoint load &rarr; no action", "live", "live",
                [("Observed", "07:58:02Z"),
                 ("Raised", "1 h ago by rule"),
                 ("Confidence", "0.94 &middot; within baseline"),
                 ("Area", "Danish straits")],
                [("route", "9 straits", "trend", "load +14 % on 30 d"),
                 ("check", "no tasking", "clock", "next review 12:00Z")],
                "Closed automatically")
    )

    left = f"""<aside class="panel" style="border:1px solid var(--brd);border-radius:2px">
{itabs([('target', 'Queue', True), ('satellite', 'Passes', False),
        ('warning', 'Alerts', False), ('check', 'Closed', False)])}
{ptitle('target', 'Collection queue', 'Last refresh 4 s ago &middot; <a href="#">Refresh</a>')}
{chiprow([('user', 'Mine'), ('globe', 'Area'), ('circle-dot', 'Status')])}
<div class="panel-body">{queue}</div>
</aside>"""

    dock = f"""<div class="dock" style="position:static;margin:0;border-radius:0;border:0;border-top:1px solid var(--brd)">
  <div class="ddock-h">
    {ic('satellite', 'ic-sm')}
    <span class="t">Dark vessel &rarr; SAR confirmation</span>
    <span class="chip mut">08:42:10Z</span>
    <button class="iconbtn" aria-label="Edit proposal">{ic('pencil', 'ic-sm')}</button>
    <span class="sp"></span>
    <span class="chip mut">{ic('shield', 'ic-sm')}UNCLAS</span>
    <button class="btn sm reject">{ic('x', 'ic-sm')}Reject</button>
    <button class="btn sm gho">{ic('refresh', 'ic-sm')}Re-task</button>
    <button class="btn sm pri">Approve{ic('arrow-right', 'ic-sm')}</button>
    <button class="iconbtn" aria-label="More">{ic('more', 'ic-sm')}</button>
    <button class="iconbtn" aria-label="Comment">{ic('message', 'ic-sm')}</button>
  </div>
  {gantt()}
</div>"""

    dock_done = f"""<div class="ddock-h" style="border-top:1px solid var(--brd)">
    {ic('satellite', 'ic-sm')}
    <span class="t">Military formation &rarr; revisit</span>
    <span class="chip mut">09:15:00Z</span>
    <span class="sp"></span>
    <button class="btn sm gho">{ic('refresh', 'ic-sm')}Re-task</button>
    <button class="btn sm done">{ic('check', 'ic-sm')}Tasking sent</button>
    <button class="iconbtn" aria-label="More">{ic('more', 'ic-sm')}</button>
  </div>"""

    right = f"""<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
{match_card()}
<div class="card" style="min-height:0">
  <div class="card-h">Proposal detail<span class="sp"></span>
    <span class="status proposed">proposed</span></div>
  <div class="card-b flush" style="overflow:auto">
    <div class="obj-card">{thumb('cargo', COLOR['cargo'])}
      <div class="obj-main"><div class="obj-t">MMSI 273441000</div>
      <div class="obj-s">Cargo &middot; AIS silent 41 min</div></div></div>
    {kv('Last fix', '07:58:02Z')}
    {kv('Last position', '54.4223, 18.5653')}
    {kv('Drift box', '11.4 km radius')}
    <div class="kv"><dt>Detector score</dt><dd><span class="mark">{count('0.82')}
      {bar(0.0, 0.82, 'warn')}</span></dd></div>
    <div class="kv"><dt>Corroboration</dt><dd><span class="mark">{count('2 sources')}
      {spark([1, 1, 2, 2, 2, 1, 0, 0], 'warn', 52, 13)}</span></dd></div>
    <div class="pad" style="padding-top:10px">
      <p class="mut" style="margin:0;font-size:12px;line-height:1.6">
      A SAR pass is the only sensor that resolves this without the vessel
      cooperating. The next one closes the question 26 minutes from now; the
      one after it is six days out.</p>
    </div>
  </div>
</div>"""

    body = (f'<div style="display:grid;grid-template-columns:1fr 320px;gap:12px;'
            f'height:100%;min-height:0">'
            f'<div class="card" style="min-height:0;position:relative;padding:0">'
            f'<div class="card-b flush" style="flex:1;min-height:0;display:flex;flex-direction:column">'
            f'<div style="flex:1;min-height:0;position:relative">'
            f'<div class="toast">{ic("check", "ic-sm")}Tasking created'
            f'<button aria-label="Dismiss">{ic("x", "ic-sm")}</button></div>'
            f'<div style="position:absolute;inset:0;display:flex;align-items:center;'
            f'justify-content:center;color:var(--txt-3);font-size:12px">'
            f'collection footprint over the operating area</div></div>'
            f'{dock}{dock_done}</div></div>'
            f'{right}</div>')

    return app_shell("Decide", tabs=["Queue", "Passes", "Audit"], active="Queue",
                     body=f'<div style="display:grid;grid-template-columns:340px 1fr;'
                          f'gap:12px;height:100%;min-height:0">{left}{body}</div>',
                     head_right=f'<span class="chip mut">3 open</span>'
                                f'<button class="btn sm pri">{ic("plus", "ic-sm")}New tasking</button>')


# ── AI weighting, on its own surface ─────────────────────────────────────────

def dial(value: int, label: str) -> str:
    """Half dial plus a stepper. A weight is a quantity you nudge, so the
    control shows the quantity and the nudge in one place."""
    frac = max(0.0, min(1.0, value / 100))
    r, cx, cy = 30, 37, 38
    import math
    a = math.pi * (1 - frac)
    x, y = cx + r * math.cos(a), cy - r * math.sin(a)
    large = 0
    sweep = 1
    return (f'<div class="dial"><svg viewBox="0 0 74 44" aria-label="{label} weight {value}">'
            f'<path class="arc-bg" d="M {cx - r} {cy} A {r} {r} 0 0 1 {cx + r} {cy}"/>'
            f'<path class="arc" d="M {cx - r} {cy} A {r} {r} 0 {large} {sweep} {x:.2f} {y:.2f}"/>'
            f'</svg><div class="stepper">'
            f'<button aria-label="Decrease {label}">{ic("minus", "ic-sm")}</button>'
            f'<span class="n">{value}</span>'
            f'<button aria-label="Increase {label}">{ic("plus", "ic-sm")}</button>'
            f'</div></div>')


WEIGHTS = [("Detector confidence", 45), ("Time to next pass", 30),
           ("Cloud forecast", 20), ("Corroborating sources", 35),
           ("Area priority", 25), ("Sensor cost", 10)]


def ai_weight_card() -> str:
    cells = "".join(
        f'<div style="padding:10px;border-right:1px solid rgba(255,255,255,.07);'
        f'border-bottom:1px solid rgba(255,255,255,.07)">'
        f'<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">'
        f'<span style="flex:1;font-size:13px;color:var(--txt-0)">{n}</span>'
        f'<button class="iconbtn" aria-label="Remove {n}">{ic("x", "ic-sm")}</button></div>'
        f'{dial(v, n)}</div>' for n, v in WEIGHTS)
    return f"""<div class="card ai-surface" style="min-height:0">
  <div class="card-h" style="text-transform:none;letter-spacing:0;font-size:13px">
    {ic('sparkle', 'ic-sm')}Choose what the recommender should weigh
    <span class="sp"></span>
    <button class="iconbtn" aria-label="About these weights">{ic('info', 'ic-sm')}</button>
    <button class="iconbtn" aria-label="Recommender settings">{ic('settings', 'ic-sm')}</button>
  </div>
  <div class="card-b flush" style="overflow:auto">
    <div style="display:grid;grid-template-columns:repeat(3,1fr)">{cells}</div>
    <button class="btn gho" style="width:100%;border:0;border-bottom:1px solid rgba(255,255,255,.07);border-radius:0">
      Show all weights (7 more)</button>
    <div style="display:flex">
      <button class="btn gho" style="flex:1;border:0;border-radius:0">
        {ic('refresh', 'ic-sm')}Re-run recommender</button>
      <button class="btn" style="flex:1;border:0;border-radius:0;background:var(--accent-dim);color:var(--accent-fg)">
        {ic('zap', 'ic-sm')}Continuous optimisation on</button>
    </div>
    <p class="mut" style="margin:0;padding:10px;font-size:12px;line-height:1.6">
      This surface is a different colour from the rest of the console on purpose.
      Everything here is a model&rsquo;s opinion about what to look at next, and an
      operator should never have to work out whether a number is a reading or a
      recommendation.</p>
  </div>
</div>"""
