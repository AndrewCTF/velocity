"""_map.py — the map well, the time dock, and the panels that surround them.

The basemap is real Carto dark-matter raster (_tiles/), the same source
apps/api/app/routes/tiles.py:138 proxies. The previous mockup drew coastlines by
hand, which is most of why it read as a cheap imitation: a drawn map cannot be
wrong in the ways a real one is right.

Contacts use the app's own top-down silhouettes and the eight guarded palette
hexes from globe/adapters/styles.ts. Aircraft rotate by track_deg, vessels by
cog, which is the invariant globe/invariants.test.ts pins.
"""

from __future__ import annotations

from _parts import (RNG, COLOR, actionbar, bar, count, ic, kv, mark, meter,
                    obj_card, panel_head, panel_tools, row, sect, silhouette,
                    spark, state, banner, switch, thumb, dots)

# A 9x6 grid of @2x tiles displayed at 256 CSS px covers 2304x1536. After the
# framing offset that still reaches past the map well at 2560x1440 (about
# 1966x1318) on both axes, with margin. The first grid was
# 6x4 = 1536x1024 and ran out two-thirds of the way across a 2560 screen: the
# basemap simply stopped and contacts floated over bare background. That is the
# "works on my computer" failure in its most literal form, and _gate.mjs now
# measures tile coverage against the map well at every viewport.
TILE_Z = 7
TILE_X = [67, 68, 69, 70, 71, 72, 73, 74, 75]
TILE_Y = [37, 38, 39, 40, 41, 42]


def tiles() -> str:
    imgs = "".join(
        f'<img src="_tiles/{TILE_Z}-{x}-{y}.png" alt="" width="256" height="256">'
        for y in TILE_Y for x in TILE_X
    )
    return f'<div class="tiles">{imgs}</div>'


# ── Contacts ─────────────────────────────────────────────────────────────────
# Deterministic layout: same seed, same pixels, so a screenshot diff means a
# real change rather than a reshuffle.

AIR_MIX = [("airliner", 0.56), ("private", 0.18), ("military", 0.11),
           ("helicopter", 0.08), ("glider", 0.05), ("emergency", 0.02)]
SEA_MIX = [("cargo", 0.55), ("tanker", 0.45)]


def _pick(mix):
    r = RNG.random()
    acc = 0.0
    for kind, w in mix:
        acc += w
        if r <= acc:
            return kind
    return mix[-1][0]


# Traffic has STRUCTURE, and uniform random placement destroys it. The first
# version of this scattered ~100 glyphs at RNG.uniform positions with
# RNG.randint rotations, which produced vessels over Belarus and aircraft on an
# airway all pointing different directions. Nothing about that reads as data,
# because none of it is how traffic behaves.
#
# Three structures, all of them things an operator would actually recognise:
#   - AIRWAYS, aircraft strung between real airport pairs, every one of them
#     aligned to the corridor bearing, with jitter across the track rather than
#     along it
#   - APPROACH FANS, density rising toward a field with headings converging
#   - SEA LANES, vessels only on water, following the Danish straits into the
#     Baltic and funnelling to Gdansk, Klaipeda and Kaliningrad
#
# Positions are percentages of the map well, read off the basemap this set
# ships, so the corridors land on the right water and the right cities.

AIRWAYS = [
    ((20.0, 68.0), (78.0, 28.0), 13, ("airliner", "airliner", "private")),   # Copenhagen to Riga
    ((37.0, 14.0), (60.0, 92.0), 11, ("airliner", "airliner", "military")),  # Stockholm to Warsaw
    ((59.0, 74.0), (85.0, 60.0), 7,  ("airliner", "private", "airliner")),   # Gdansk to Vilnius
    ((26.0, 92.0), (66.0, 8.0),  12, ("airliner", "airliner", "airliner")),  # Berlin to Helsinki
    ((72.0, 20.0), (44.0, 80.0), 8,  ("airliner", "military", "airliner")),  # Tallinn to Poznan
]

# Fields that traffic converges on: x, y, inbound bearing, how many.
APPROACHES = [((60.5, 72.5), 118, 6), ((22.5, 66.0), 62, 5),
              ((77.0, 29.0), 214, 4), ((38.0, 19.0), 156, 4)]

# Sea lanes as polylines. Every vertex sits on water on this basemap.
SEALANES = [
    [(21.0, 60.0), (30.0, 60.5), (40.0, 59.0), (50.0, 60.5), (58.0, 65.0), (63.5, 70.0)],
    [(43.0, 47.0), (52.0, 43.0), (61.0, 39.0), (69.0, 35.0), (74.0, 31.5)],
    [(36.0, 33.0), (43.0, 41.0), (50.0, 50.0), (56.0, 59.0), (61.0, 67.0)],
    [(46.0, 55.0), (54.0, 56.5), (62.0, 60.0), (68.5, 63.0)],
]


def _bearing(ax, ay, bx, by):
    """Screen bearing for an icon drawn nose-up, y growing downward."""
    import math
    return (math.degrees(math.atan2(bx - ax, -(by - ay)))) % 360


def _along(a, b, t):
    return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t


def _ct(x, y, rot, art):
    return (f'<span class="ct" style="left:{x:.2f}%;top:{y:.2f}%;'
            f'transform:translate(-50%,-50%) rotate({rot:.0f}deg)">{art}</span>')


def contacts() -> str:
    import math
    out = []

    for (a, b, n, kinds) in AIRWAYS:
        brg = _bearing(a[0], a[1], b[0], b[1])
        # Perpendicular to the corridor, so jitter widens the airway rather
        # than smearing aircraft along it out of sequence.
        px, py = math.cos(math.radians(brg)), math.sin(math.radians(brg))
        for i in range(n):
            t = (i + RNG.uniform(0.15, 0.85)) / n
            x, y = _along(a, b, t)
            off = RNG.uniform(-1.6, 1.6)
            kind = kinds[i % len(kinds)]
            # Opposing traffic on the reciprocal, which every real airway has.
            rev = i % 4 == 3
            out.append(_ct(x + px * off, y + py * off,
                           (brg + 180) % 360 if rev else brg + RNG.uniform(-4, 4),
                           silhouette("airliner" if kind == "military" else kind,
                                      COLOR[kind])))

    for (fx, fy), inbound, n in APPROACHES:
        for i in range(n):
            d = 2.0 + i * 2.1                      # strung out down the approach
            ang = math.radians(inbound + 180)
            x = fx + math.sin(ang) * d
            y = fy - math.cos(ang) * d
            out.append(_ct(x + RNG.uniform(-0.7, 0.7), y + RNG.uniform(-0.7, 0.7),
                           inbound + RNG.uniform(-6, 6),
                           silhouette("airliner" if i % 3 else "private",
                                      COLOR["airliner" if i % 3 else "private"])))

    for lane in SEALANES:
        for i in range(len(lane) - 1):
            a, b = lane[i], lane[i + 1]
            brg = _bearing(a[0], a[1], b[0], b[1])
            px, py = math.cos(math.radians(brg)), math.sin(math.radians(brg))
            for k in range(2):
                t = (k + RNG.uniform(0.2, 0.8)) / 2
                x, y = _along(a, b, t)
                off = RNG.uniform(-0.9, 0.9)
                kind = "tanker" if (i + k) % 3 == 0 else "cargo"
                out.append(_ct(x + px * off, y + py * off,
                               (brg + 180) % 360 if k % 2 else brg,
                               silhouette("cargo", COLOR[kind])))

    # Vessels waiting off the two big ports. Anchorages are the densest thing
    # on a real AIS picture and the most obviously missing thing without them.
    for (ax, ay) in ((62.5, 69.0), (69.0, 63.5)):
        for i in range(7):
            r = RNG.uniform(0.6, 2.4)
            th = RNG.uniform(0, 2 * math.pi)
            out.append(_ct(ax + math.cos(th) * r, ay + math.sin(th) * r * 0.7,
                           RNG.uniform(0, 359),
                           silhouette("cargo", COLOR["cargo" if i % 3 else "tanker"])))

    return "".join(out)


LABELS = [
    ("RYR4213", 57.0, 44.0), ("SAS1871", 30.5, 26.0), ("NORDIC STAR", 41.0, 62.0),
    ("LOT282", 71.5, 55.5), ("BALTIC TRADER", 22.0, 71.0), ("FIN9042", 80.0, 22.0),
]


def labels() -> str:
    return "".join(
        f'<span class="lbl" style="left:{x:.1f}%;top:{y:.1f}%">{t}</span>'
        for t, x, y in LABELS
    )


def selection_track() -> str:
    """The selected contact's history. Magenta #d946ef width 4 over a black
    outline width 6, which globe/invariants.test.ts pins literally."""
    d = ("M 22.5 88.5 L 26.8 84.1 L 31.0 79.4 L 35.4 74.2 L 39.6 68.7 "
         "L 43.5 63.4 L 47.2 58.0 L 50.6 52.7 L 53.4 48.2 L 55.6 44.6")
    return (f'<svg class="track" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">'
            f'<path d="{d}" fill="none" stroke="#000" stroke-width="1.1" vector-effect="non-scaling-stroke"/>'
            f'<path d="{d}" fill="none" stroke="#d946ef" stroke-width="0.7" vector-effect="non-scaling-stroke"/>'
            f'</svg>')


# ── Map chrome ───────────────────────────────────────────────────────────────

TOOLS = [
    ("Navigate", [("hand", "Pan", True), ("move", "Orbit", False)]),
    ("Select", [("select", "Select", False), ("scan", "Box select", False),
                ("around", "Search around", False)]),
    ("Draw", [("draw", "Draw", False), ("annotate", "Annotate", False),
              ("capture", "Capture", False)]),
    ("Measure", [("measure", "Measure", False), ("pin", "Drop pin", False),
                 ("trash", "Delete", False)]),
]


def toolbar(active: str = "hand") -> str:
    groups = []
    for label, items in TOOLS:
        btns = "".join(
            f'<button class="tool" aria-pressed="{"true" if key == active else "false"}" '
            f'aria-label="{name}" title="{name}">{ic(key)}</button>'
            for key, name, _ in items
        )
        groups.append(f'<div class="tgroup"><b>{label}</b><div>{btns}</div></div>')
    return f'<div class="toolbar">{"".join(groups)}</div>'


def map_strip(link="ok", feeds="6 of 8 live", clock="live") -> str:
    return (f'<div class="map-strip">'
            f'<span><i class="dot {"ok" if link == "ok" else "err"}"></i>Link {"up" if link == "ok" else "down"}</span>'
            f'<span><i class="dot ok"></i>Feeds {feeds}</span>'
            f'<span><i class="dot ok"></i>Clock {clock}</span></div>')


def radius_aoi(x: float, y: float, size: int, label: str) -> str:
    """The search radius, drawn. A page whose action is "search 50 km" and
    whose map shows no circle is asking the operator to imagine the query."""
    return (f'<div class="aoi-circle" style="left:{x}%;top:{y}%;'
            f'width:{size}px;height:{size}px">'
            f'<span class="dia"><b>{label}</b></span></div>')


def range_rings(x: float, y: float, steps: list[tuple[int, str]]) -> str:
    """Concentric distance rings. "How far" is a question a point symbol cannot
    answer and an operator asks constantly."""
    m = max(r for r, _ in steps)
    circles = "".join(f'<circle cx="{m}" cy="{m}" r="{r}"/>' for r, _ in steps)
    labels = "".join(f'<text x="{m + 3}" y="{m - r + 10}">{lab}</text>' for r, lab in steps)
    return (f'<svg class="rings" style="left:{x}%;top:{y}%;width:{m * 2}px;height:{m * 2}px" '
            f'viewBox="0 0 {m * 2} {m * 2}" aria-hidden="true">{circles}{labels}</svg>')


def compass(deg: int = 0) -> str:
    """A bearing readout. North-up is an assumption and an instrument states
    its assumptions."""
    return (f'<div class="compass"><span class="deg">{deg:03d}&deg;</span>'
            f'<svg class="rose" viewBox="0 0 24 24" aria-label="Heading {deg} degrees">'
            f'<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1"/>'
            f'<path d="M12 3 L15 12 L12 10.5 L9 12 Z" fill="var(--err)" stroke="none"/>'
            f'<path d="M12 21 L9 12 L12 13.5 L15 12 Z" fill="currentColor" stroke="none"/>'
            f'</svg></div>')


def map_furniture() -> str:
    legend = "".join(
        f'<span><i class="dot" style="background:{COLOR[k]}"></i>{n}</span>'
        for k, n in [("airliner", "airliner"), ("private", "private"),
                     ("helicopter", "helicopter"), ("military", "military"),
                     ("cargo", "cargo"), ("tanker", "tanker"),
                     ("emergency", "emergency")]
    )
    return f"""<div class="map-foot">
  <div class="scalebar"><div class="ln" style="width:118px"></div>
    <span class="mono">0&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;100 km</span></div>
  <div class="maplegend">{legend}</div>
  <span class="sp"></span>
  <span class="attrib">(c) OpenStreetMap, (c) CARTO</span>
  <div class="coords">54.3181 N&nbsp; 018.7122 E &middot; 33UXP 0421 5518</div>
</div>"""


# ── The time dock ────────────────────────────────────────────────────────────

def transport(playing: bool = False, live: bool = False, clock: str = "12:27:06 Z") -> str:
    """Read off tmp/palantir/parts/video-transport.png, control for control.

    Every button here already has a handler in timeline/Timeline.tsx. The
    keyboard bindings exist and work (space, arrows, comma/period, L at
    :460-521); what was missing is any way to SEE them, which is most of why
    replay felt uncontrollable.
    """
    pri = ("pause", "Pause") if playing else ("play", "Play")
    return f"""<div class="transport">
  <span class="clock">{clock}</span>
  <span class="sp"></span>
  <button class="tbtn" title="Jump to start of window" aria-label="Jump to start">{ic('step-b', 'ic-sm')}</button>
  <button class="tbtn" title="Rewind 2x">{ic('rewind', 'ic-sm')}2x</button>
  <button class="tbtn" title="Back 15 seconds">{ic('back-15', 'ic-sm')}15s</button>
  <button class="tbtn" title="Step back one bin" aria-label="Step back">{ic('frame-b', 'ic-sm')}</button>
  <button class="tbtn pri" title="Space">{ic(pri[0], 'ic-sm')}{pri[1]}</button>
  <button class="tbtn" title="Step forward one bin" aria-label="Step forward">{ic('frame-f', 'ic-sm')}</button>
  <button class="tbtn" title="Forward 15 seconds">15s{ic('fwd-15', 'ic-sm')}</button>
  <button class="tbtn" title="Fast forward 2x">2x{ic('fast-forward', 'ic-sm')}</button>
  <button class="tbtn live" aria-pressed="{'true' if live else 'false'}" title="Return to live (L)">Live</button>
  <span class="sp"></span>
  <button class="tbtn" title="Playback settings" aria-label="Playback settings">{ic('sliders', 'ic-sm')}</button>
  <button class="tbtn" title="Collapse dock (t)" aria-label="Collapse dock">{ic('chevron-down', 'ic-sm')}</button>
</div>"""


def ruler(ticks: list[tuple[float, str]], events: list[tuple[float, str]]) -> str:
    t = "".join(
        f'<i class="tick" style="left:{p:.2f}%"></i>'
        f'<span class="tl" style="left:{p:.2f}%">{lab}</span>'
        for p, lab in ticks
    )
    e = "".join(
        f'<i class="ev{" alert" if k == "alert" else ""}" style="left:{p:.2f}%" '
        f'title="{"Alert" if k == "alert" else "Incident"} at this time"></i>'
        for p, k in events
    )
    return f'<div class="ruler">{t}<div class="evlane">{e}</div></div>'


def density(playhead: float = 62.0, stamp: str = "16:13:05", n: int = 150) -> str:
    bars = []
    for i in range(n):
        t = i / n
        x = t * 100
        # A shaped series, not noise. Quiet start, a morning build, a sharp
        # spike at the incident and a decay after it. Flat noise would hide
        # exactly the structure the strip exists to show, which is what makes
        # a density track worth its 40px.
        base = 26 + 34 * (1 - abs(t - 0.66) / 0.66) ** 1.6
        spike = 46 * max(0.0, 1 - abs(t - 0.62) / 0.045) ** 2
        v = max(6.0, base + spike + RNG.uniform(-7, 7))
        h = min(100.0, v)
        cls = "d-alert" if 0.612 < t < 0.628 else "d-bar"
        bars.append(f'<rect class="{cls}" x="{x:.3f}" y="{100 - h:.2f}" '
                    f'width="{100 / n * 0.74:.3f}" height="{h:.2f}"/>')
    return (
        f'<div class="density" role="slider" aria-label="Scrub replay position" tabindex="0" '
        f'aria-valuemin="0" aria-valuemax="100" aria-valuenow="{playhead:.0f}">'
        f'<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{"".join(bars)}</svg>'
        f'<span class="playhead" style="left:{playhead:.2f}%">'
        f'<span class="ph-stamp">{stamp}</span></span></div>'
    )


def dock(*, playing: bool = False, live: bool = True, clock: str = "12:27:06 Z",
         window_label: str = "Live &middot; last 20 h", foot_right: str = "") -> str:
    ticks = [(2, "14:15"), (18, "14:45"), (34, "15:15"), (50, "15:45"),
             (66, "16:15"), (82, "16:45"), (95, "17:10")]
    events = [(21, "inc"), (37, "inc"), (52, "alert"), (62, "alert"),
              (68, "inc"), (79, "inc"), (88, "inc")]
    foot = foot_right or (
        f'{ic("database", "ic-sm")}<span>Recording since 2026-07-11 &middot; 2.1 GB &middot; 11,067,232 fixes</span>'
    )
    return f"""<div class="dock">
{transport(playing=playing, live=live, clock=clock)}
{ruler(ticks, events)}
{density()}
<div class="dock-foot">
  <span>{window_label}</span>
  <span class="sp"></span>
  {foot}
</div>
</div>"""


# ── Left panel: Layers ───────────────────────────────────────────────────────
# The Layers panel in the current app reads `ON` / `OFF` and `3/4` with no mark
# anywhere. This is the single most direct answer to "numbers do nothing":
# Gotham's Histogram puts a bar on every row, and the bar carries the filtered
# share as well as the magnitude.

LAYERS = [
    ("AIR", "3 of 6", [
        ("Aircraft", "Multi-source ADS-B &middot; 1 s", "plane", "12,418", 0.42, 0.95, True, ""),
        ("Military", "airplanes.live", "shield", "284", 0.09, 0.30, True, ""),
        ("Emergency", "Squawk 7500, 7600, 7700", "warning", "3", 0.03, 0.05, True, "err"),
        ("TFR and airspace", "FAA &middot; 14 areas", "hexagon", "14", 0.0, 0.12, False, ""),
        ("SIGMET and AIRMET", "NOAA aviation weather", "cloud", "31", 0.0, 0.24, False, ""),
        ("Ground stops", "Unavailable (HTTP 503)", "circle-alert", "&mdash;", 0.0, 0.0, False, "err"),
    ]),
    ("MARITIME", "3 of 11", [
        ("Vessels", "All AIS sources", "ship", "31,204", 0.55, 1.0, True, ""),
        ("Baltic AIS", "Regional feed", "waves", "1,842", 0.11, 0.22, False, ""),
        ("Dark-vessel SAR", "Sentinel-1 &middot; 6 areas", "radar", "6", 0.06, 0.08, True, "warn"),
        ("Naval warnings", "NGA broadcast", "flag", "311", 0.0, 0.34, True, ""),
        ("Marine buoys", "NDBC", "droplet", "1,204", 0.0, 0.19, True, ""),
        ("Chokepoint congestion", "9 straits", "route", "9", 0.0, 0.11, True, ""),
    ]),
    ("GROUND AND HAZARDS", "4 of 13", [
        ("Earthquakes", "USGS", "quake", "118", 0.0, 0.21, True, ""),
        ("Fires", "NASA FIRMS", "fire", "14,818", 0.0, 0.88, True, "warn"),
        ("Wildfire perimeters", "NIFC", "flame" if False else "fire", "204", 0.0, 0.16, True, ""),
        ("Tropical cyclones", "GDACS", "wind", "3", 0.0, 0.05, True, ""),
    ]),
]


def layers_panel(degraded: bool = False) -> str:
    out = []
    for title, right, rows in LAYERS:
        out.append(sect(title, right))
        for name, sub, icon, n, part, total, on, tone in rows:
            tail = (f'<span class="mark">{count(n)}{bar(part, total, tone)}</span>'
                    f'{switch(on)}')
            out.append(row(name, sub=sub, icon=icon, tail=tail, on=on))
    body = "".join(out)
    if degraded:
        body = banner("warn", "warning",
                      "Vessels is showing one of two sources. MyShipTracking has been "
                      "silent for 4 minutes, so the count reads low.") + body
    tools = panel_tools(
        f'<button class="btn xs gho">{ic("grid", "ic-sm")}Presets</button>')
    return (f'<aside class="panel">{panel_head("Layers", "")}{tools}'
            f'<div class="panel-body">{body}</div></aside>')


# ── Right panel: Selection ───────────────────────────────────────────────────

INSPECTOR_TABS = ["Overview", "Properties", "History", "Dossier"]


def _subtabs(names: list[str], active: str) -> str:
    return '<div class="subtabs">' + "".join(
        f'<button class="tab" aria-selected="{"true" if n == active else "false"}">{n}</button>'
        for n in names) + "</div>"


def selection_panel() -> str:
    head = panel_head("Selection",
                      f'<button class="iconbtn" aria-label="Fly to">{ic("pin", "ic-sm")}</button>')
    card = obj_card(
        "LN-FNL", "Norse Atlantic Airways &middot; Boeing 787-9",
        kind="airliner",
        tail=f'<span class="chip">Aircraft</span>')
    alt_series = [11780, 11810, 11840, 11860, 11870, 11880, 11880, 11875, 11880]
    spd_series = [244, 248, 251, 253, 255, 256, 256, 255, 256]
    return f"""<aside class="panel right">
{head}
{_subtabs(INSPECTOR_TABS, "Overview")}
<div class="panel-body">
{card}
{sect('Identity')}
{kv('ICAO24', '47AE38')}
{kv('Callsign', 'NBT40S')}
{kv('Squawk', '1000')}
{kv('ADS-B category', 'A5')}
{kv('Registration', 'LN-FNL')}
{sect('Kinematics')}
<div class="kv"><dt>Altitude</dt><dd><span class="mark">{count('38,975 ft')}{spark(alt_series, '', 52, 13)}</span></dd></div>
<div class="kv"><dt>Speed</dt><dd><span class="mark">{count('497 kn')}{spark(spd_series, '', 52, 13)}</span></dd></div>
{kv('Track', '103&deg;')}
{kv('Vertical rate', '+64 ft/min')}
{kv('Latitude', '54.4223')}
{kv('Longitude', '18.5653')}
{sect('Freshness')}
<div class="kv"><dt>Last fix</dt><dd><span class="mark">{count('1 s')}{bar(0.02, 0.02, 'ok', 'w-sm')}</span></dd></div>
<div class="kv"><dt>Seen by</dt><dd><span class="mark">{count('3 sources')}{dots(['ok', 'ok', 'ok', '', ''])}</span></dd></div>
{kv('First seen', '11:04:22 Z')}
{sect('Flight')}
{kv('Route', 'JFK &rarr; FCO', 'txt')}
{kv('Departed', 'New York &middot; 09:12 Z', 'txt')}
<div class="kv"><dt>Progress</dt><dd><span class="mark">{count('1,435 km to go')}{bar(0.0, 0.62)}</span></dd></div>
{kv('ETA', '12:17 Z')}
{sect('Pattern of life')}
<div class="pad">
  <div class="stat" style="padding:0">
    <span class="k">Deviation from this airframe&rsquo;s 30-day baseline</span>
    <div class="r"><span class="mark">{count('+2.3 sigma')}{bar(0.0, 0.77, 'warn', 'w-lg')}</span></div>
  </div>
</div>
{banner('warn', 'warning', 'Altitude is 2,400 ft above this route&rsquo;s median for the hour. Two of the last nine flights did the same.')}
</div>
<div class="panel-tools" style="border-top:1px solid var(--brd);border-bottom:0">
  <button class="btn sm gho">{ic('around', 'ic-sm')}Search around</button>
  <span class="sp"></span>
  <button class="btn sm pri">Actions{ic('chevron-down', 'ic-sm')}</button>
</div>
</aside>"""


# ── Left panel variants ──────────────────────────────────────────────────────

def find_panel() -> str:
    body = f"""
<div class="pad">
  <div class="search" style="width:100%;margin:0 0 8px">{ic('search', 'ic-sm')}33UXP 0421 5518</div>
  <div style="display:flex;gap:6px">
    <button class="btn sm pri">{ic('pin', 'ic-sm')}Fly here</button>
    <button class="btn sm gho">Drop a pin</button>
    <button class="btn sm gho">{ic('around', 'ic-sm')}Search 50 km</button>
  </div>
  <p class="mut" style="font-size:12px;margin:8px 0 0">Reads as MGRS &middot; 54.3181 N, 18.7122 E</p>
</div>
{sect('Contacts', '2')}
{obj_card('RCH471', 'C-17A &middot; FL310 &middot; 12 km away', kind='airliner', color=COLOR['military'], tail=f'<span class="mark">{count("12 km")}{bar(0.0, 0.24, "", "w-sm")}</span>')}
{obj_card('NORDIC STAR', 'MMSI 273441000 &middot; 4 km away', kind='cargo', tail=f'<span class="mark">{count("4 km")}{bar(0.0, 0.08, "", "w-sm")}</span>')}
{sect('Places', '3')}
{obj_card('Gdansk Lech Walesa', 'EPGD &middot; airport', icon='plane', tail=f'<span class="mark">{count("8 km")}{bar(0.0, 0.16, "", "w-sm")}</span>')}
{obj_card('Port of Gdansk', 'PLGDN &middot; port', icon='anchor', tail=f'<span class="mark">{count("3 km")}{bar(0.0, 0.06, "", "w-sm")}</span>')}
{obj_card('Gdynia naval base', 'Military installation', icon='shield', tail=f'<span class="mark">{count("21 km")}{bar(0.0, 0.42, "", "w-sm")}</span>')}
"""
    return (f'<aside class="panel">{panel_head("Find")}{panel_tools()}'
            f'<div class="panel-body">{body}</div></aside>')


HISTO = [
    ("Aircraft category", "12,418", [
        ("Airliner", "airliner", "9,914", 0.80, 0.80),
        ("Private", "private", "1,806", 0.0, 0.15),
        ("Helicopter", "helicopter", "371", 0.0, 0.03),
        ("Military", "military", "284", 0.23, 0.23),
        ("Glider", "glider", "43", 0.0, 0.004),
    ]),
    ("Altitude band", "12,418", [
        ("On ground", "", "2,104", 0.0, 0.17),
        ("0 to 1 km", "", "918", 0.0, 0.07),
        ("1 to 3 km", "", "1,402", 0.0, 0.11),
        ("3 to 8 km", "", "2,911", 0.0, 0.23),
        ("Above 8 km", "", "5,083", 0.41, 0.41),
    ]),
    ("Operator", "12,418", [
        ("Ryanair", "", "882", 0.0, 0.07),
        ("Lufthansa", "", "651", 0.0, 0.05),
        ("SAS", "", "410", 0.0, 0.03),
        ("Norse Atlantic", "", "38", 0.003, 0.003),
    ]),
]


def histogram_panel() -> str:
    out = []
    for title, total, rows in HISTO:
        out.append(sect(title, total))
        for name, cat, n, part, tot in rows:
            colour = COLOR.get(cat)
            dot = (f'<i class="dot" style="background:{colour}"></i>' if colour
                   else f'<i class="dot"></i>')
            tail = (f'<span class="mark">{count(n)}{bar(part, tot)}</span>'
                    f'<button class="iconbtn" aria-label="Exclude {name}">{ic("eye-off", "ic-sm")}</button>')
            sel = part > 0
            cls = "row sel" if sel else "row"
            out.append(f'<div class="{cls}">{dot}<span class="nm">{name}</span>{tail}</div>')
    chips = ('<div class="panel-tools"><span class="chip">Military'
             f'{ic("x", "ic-sm")}</span><span class="chip">FL300 to FL800{ic("x", "ic-sm")}</span>'
             '<span class="sp"></span><button class="btn xs gho">Clear 2</button></div>')
    return (f'<aside class="panel">{panel_head("Histogram")}{chips}'
            f'<div class="panel-body">{"".join(out)}</div></aside>')


FEEDS = [
    ("OpenSky", "Aircraft breadth", "ok", "1 pull/day", [8, 9, 9, 8, 9, 9, 9, 9]),
    ("airplanes.live", "Grid overlay", "ok", "1.0 s", [42, 44, 43, 45, 44, 46, 45, 44]),
    ("ShipXplorer", "AIS direct", "ok", "2.4 s", [30, 31, 29, 32, 31, 30, 31, 32]),
    ("MyShipTracking", "AIS sidecar :8093", "warn", "241 s", [22, 21, 20, 14, 8, 4, 1, 0]),
    ("NASA FIRMS", "Fires", "ok", "6 min", [12, 13, 14, 14, 15, 14, 15, 15]),
    ("USGS", "Earthquakes", "ok", "58 s", [4, 5, 4, 6, 5, 5, 4, 5]),
    ("CelesTrak", "Satellites", "ok", "2 h cache", [9, 9, 9, 9, 9, 9, 9, 9]),
    ("FAA ground stops", "Unavailable (HTTP 503)", "err", "&mdash;", [3, 2, 1, 0, 0, 0, 0, 0]),
]


def info_panel() -> str:
    rows = []
    for name, sub, tone, age, series in FEEDS:
        tail = (f'<span class="mark">{count(age)}'
                f'{spark(series, "ok" if tone == "ok" else "warn", 56, 14)}</span>')
        rows.append(f'<div class="row two"><i class="dot {tone}"></i>'
                    f'<span class="nm">{name}<span class="sub">{sub}</span></span>{tail}</div>')
    health = f"""
<div class="pad">
  <div class="grid g2">
    <div class="stat" style="padding:0"><span class="k">Backend loop lag p95</span>
      <div class="v">3.1 ms</div>
      <div class="r">{spark([2.8, 3.0, 2.9, 3.4, 3.1, 3.0, 3.2, 3.1], 'ok', 96, 18)}</div></div>
    <div class="stat" style="padding:0"><span class="k">Render cost p95</span>
      <div class="v">14.2 ms</div>
      <div class="r">{spark([13, 14, 15, 14, 16, 14, 13, 14], 'ok', 96, 18)}</div></div>
  </div>
</div>"""
    return (f'<aside class="panel">{panel_head("Info")}{panel_tools()}'
            f'<div class="panel-body">{sect("System")}{health}'
            f'{sect("Feeds", "6 of 8 live")}{"".join(rows)}</div></aside>')


def series_panel() -> str:
    """Right-column Series. The time-series chart with real axes and ticks that
    the app does not have anywhere today."""
    pts = [30, 34, 33, 38, 42, 41, 47, 52, 49, 55, 61, 58, 64, 69, 66, 71, 74, 70, 76, 79]
    n = len(pts)
    lo, hi = 25, 85
    poly = " ".join(f"{i / (n - 1) * 300:.1f},{110 - (v - lo) / (hi - lo) * 100:.1f}"
                    for i, v in enumerate(pts))
    grid = "".join(f'<line class="grid-line" x1="0" y1="{y}" x2="300" y2="{y}"/>'
                   for y in (10, 35, 60, 85, 110))
    axl = "".join(f'<text class="ax" x="0" y="{y + 3}">{v}</text>'
                  for y, v in ((12, "85"), (62, "55"), (110, "25")))
    axb = "".join(f'<text class="ax" x="{x}" y="126">{t}</text>'
                  for x, t in ((0, "14:15"), (95, "15:15"), (190, "16:15"), (265, "17:10")))
    return f"""<aside class="panel right">
{panel_head("Series")}
<div class="panel-body">
{sect('Contacts in view', 'last 3 h')}
<div class="pad">
  <svg class="chart tall" viewBox="0 0 300 132" aria-label="Contacts in view over the last three hours">
    {grid}{axl}{axb}
    <polyline points="{poly}" fill="none" stroke="var(--accent-fg)" stroke-width="1.6"/>
  </svg>
  <div class="legend"><span><i style="background:var(--accent-fg)"></i>aircraft in viewport</span></div>
</div>
{sect('By category', 'now')}
<div class="pad">
  <svg class="chart" viewBox="0 0 300 90" aria-label="Contacts by category">
    <rect class="b-air" x="0"   y="20" width="46" height="60"/>
    <rect class="b-mut" x="52"  y="56" width="46" height="24"/>
    <rect class="b-mil" x="104" y="62" width="46" height="18"/>
    <rect class="b-sea" x="156" y="34" width="46" height="46"/>
    <rect class="b-mut" x="208" y="70" width="46" height="10"/>
    <text class="ax" x="6"   y="88">airlnr</text>
    <text class="ax" x="60"  y="88">priv</text>
    <text class="ax" x="112" y="88">mil</text>
    <text class="ax" x="164" y="88">cargo</text>
    <text class="ax" x="214" y="88">other</text>
  </svg>
</div>
{sect('Time selection')}
{kv('From', '14:15:00 Z')}
{kv('To', '17:10:00 Z')}
{kv('Bin', '60 s')}
<div class="pad"><button class="btn sm gho" style="width:100%">{ic('back-15', 'ic-sm')}Replay this window</button></div>
</div>
</aside>"""
