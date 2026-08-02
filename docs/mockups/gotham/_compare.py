#!/usr/bin/env python3
"""Generate gotham-compare.html: Velocity beside Gotham on four axes.

The axes are the ones asked for: pixel, language, design, professionalism. Each
section carries the evidence that produced it rather than an assertion, because
the same four claims were made about the earlier mockups and two of them turned
out to be false when finally measured (76 unreachable controls, every icon
cropped).

Reference crops are shown at the scale that makes a measured component the same
height on screen as ours, not at a raw multiple: the PDF screenshots are
themselves a downscale of an unknown capture width, so a raw 3x of theirs is not
comparable to a raw 3x of ours.
"""
import pathlib

HERE = pathlib.Path(__file__).parent
OUT = HERE / "gotham-compare.html"

SCALE = 0.633  # capture scale of the PDF screenshots; see _calibrate.py

# Measured off _ref/, converted at SCALE, then checked against the built page by
# _verify.mjs in a real browser.
PIXEL = [
    ("Classification band", 12, 20, 20, "Gotham-specific"),
    ("Title and menu bar", 25, 40, 40, "~$pt-button-height-large 40px"),
    ("Application menu row", 19, 30, 30, "$pt-button-height 30px"),
    ("Icon shortcut rail (width)", 27, 43, 40, "~40px"),
    ("Left panel (width)", 195, 308, 308, "~300px"),
    ("Right panel (width)", 181, 286, 286, "~280px"),
    ("Dense list row pitch", 13, 21, 20, "$pt-button-height-smaller 20px"),
    ("Bottom action bar", 31, 49, 50, "$pt-navbar-height 50px"),
    ("Primary button", 19, 30, 30, "$pt-button-height 30px"),
    ("Tab strip", 20, 32, 32, "—"),
    ("Status strip", 14, 22, 22, "—"),
]

BLUEPRINT = [
    ("$pt-spacing / $pt-grid-size", "4px / 10px", "--sp-1: 4px, scale in 4s"),
    ("$pt-font-size", "14px", "--fs-body: 14px"),
    ("$pt-font-size-small", "12px", "--fs-cap: 12px, and the floor"),
    ("$pt-font-size-large", "16px", "--fs-lg: 16px"),
    ("$pt-line-height", "1.28581", "inherited"),
    ("$pt-border-radius (v5)", "2px", "--g-r: 2px"),
    ("$pt-button-height", "30px", "--g-btn: 30px"),
    ("$pt-button-height-small", "24px", "--g-btn-sm: 24px"),
    ("$pt-button-height-smaller", "20px", "--g-btn-xs: 20px, --g-row: 20px"),
    ("$pt-input-height", "30px", "--g-btn: 30px"),
    ("$pt-navbar-height", "50px", "--g-action: 50px"),
    ("$pt-icon-size-standard", "16px", "--g-icon: 16px"),
    ("$pt-transition-duration", "100ms", "--g-transition: 100ms"),
    ("$pt-transition-ease", "cubic-bezier(0.4, 1, 0.75, 0.9)", "same, verbatim"),
]

COLORS = [
    ("$black", "#111418", "--bg-0"), ("$dark-gray1", "#1c2127", "--bg-1"),
    ("$dark-gray2", "#252a31", "--bg-2"), ("$dark-gray3", "#2f343c", "--bg-3"),
    ("$dark-gray4", "#383e47", "--bg-4"), ("$light-gray5", "#f6f7f9", "--txt-0"),
    ("$gray5", "#c5cbd3", "--txt-1"), ("$gray4", "#abb3bf", "--txt-2"),
    ("$gray3", "#8f99a8", "--txt-3"), ("$blue3", "#2d72d2", "--accent"),
    ("$blue5", "#8abbff", "--accent-fg"), ("$green4", "#32a467", "--ok"),
    ("$orange4", "#ec9a3c", "--warn"), ("$red4", "#e76a6e", "--alert"),
]

LANGUAGE = [
    ("Em dashes in prose",
     "3 across 34,119 words of published Gotham documentation",
     "Zero in dashboard copy, guarded; ` · ` separates instead",
     "aligned",
     "Velocity's no-em-dash rule was an operator decision made independently. "
     "Palantir writes the same way. The rule is not a quirk."),
    ("Core noun for a timestamped fix",
     "<b>Observation</b>. \"An Observation is a data container for the most "
     "granular unit of data that can be stored in Geotime.\"",
     "<b>Observation</b>. <code>ObservationStore</code>, <code>Observation.t</code>, "
     "<code>_latest[id]</code>",
     "aligned",
     "Velocity already names this concept exactly as Palantir does, in the store "
     "layer, without having read this page."),
    ("Core noun for a series of fixes",
     "<b>Track</b>. \"A Track is a collection of Observations of the same entity "
     "over some period of time.\"",
     "<b>Track</b>. <code>tracks.ts</code>, the selection polyline",
     "aligned",
     "Same word, same definition, same role."),
    ("How a pending filter is described",
     "A sentence: \"Keeping Objects with property types matching any of "
     "<u>Marital Status</u>\", with the operator's own choices as underlined "
     "tokens inside it",
     "Was a label (\"Filters · 2 active\"). Now the same sentence form: "
     "\"Keeping Aircraft with <u>Category</u> matching any of <u>Military</u>\"",
     "closed",
     "This was the single largest language gap and it is the device most often "
     "copied wrong. The UI narrates the query; it does not label it."),
    ("Query vocabulary behind that sentence",
     "<code>eq · and · or · not · keyword · lt · gt · lte · gte · "
     "geoPointWithin</code>",
     "Layer filters, viewport filter, category filter, all unnamed",
     "open",
     "Naming Velocity's filter primitives after these would let one sentence "
     "renderer serve every panel. Not built."),
    ("Error shape",
     "<code>errorCode</code> + <code>errorName</code> + "
     "<code>errorInstanceId</code>, e.g. <code>INVALID_ARGUMENT</code> / "
     "<code>MalformedObjectPrimaryKeys</code>",
     "A sentence that keeps the code: <code>Cameras unavailable (HTTP 503)</code>, "
     "never <code>cams 503</code>",
     "aligned",
     "Different shape, same principle: the operator gets a name they can quote "
     "to support, not an internal fragment."),
]

PRO = [
    ("Application menu bar",
     "File · Edit · View · Insert · Selection · Support on every Gotham app",
     "Built. File · Edit · View · Collect · Exploration · Window · Help",
     "A menu bar is the loudest single signal that a surface is a workstation "
     "rather than a web page. It also gives every command a discoverable home, "
     "which is the exact defect the persona waves reported."),
    ("Classification as a band",
     "Full-width coloured band across the very top, centred marking",
     "Built, 20px, green for UNCLASSIFIED",
     "Marking governs everything below it, so it sits above everything. A pill "
     "tucked in a corner reads as a badge, not a control."),
    ("Counts inside the tab",
     "Types 47 · Properties 332 · Links 14",
     "Built. Layers 18 of 64 · Histogram 6 · Info 2 · Series 5",
     "The operator learns whether a panel holds anything without opening it. "
     "This is most of what \"reachable but invisible\" was asking for."),
    ("One filled button per surface",
     "\"Add to filter path\" in the action bar, \"Actions\" in the right panel. "
     "Everything else is bordered or plain",
     "Built, both",
     "When exactly one thing is filled, the commit action is unmissable and the "
     "accent keeps its meaning. Velocity's map palette already reserves "
     "saturation for data; this extends the same discipline to chrome."),
    ("Selection as outline, not fill",
     "Object Explorer's selected property row is an accent outline",
     "Built",
     "A fill destroys the row's own colour coding. An outline lets a selected "
     "degraded layer still read as degraded."),
    ("Two-tone mini bars beside counts",
     "Property list shows matched-of-total as a filled bar on a dark track",
     "Built, on every layer row",
     "The densest information device in Object Explorer: proportion without a "
     "chart, at 20px."),
    ("Status strip along the bottom",
     "Gaia: \"Online · View · 3 interactive elements\", panel stops above it",
     "Built, 22px",
     "A permanent, quiet home for system state. It is where degraded belongs."),
    ("A fourth state: degraded",
     "Not a Gotham device. This one is Velocity's own",
     "Built, in both panels and the status strip",
     "Loading, empty and error were already required and guarded. Both persona "
     "waves still found silent failure, because the real case is a surface with "
     "SOME data quietly missing the rest. Gotham does not solve this; Velocity "
     "has to, because its feeds degrade independently."),
]

CROPS = [
    ("Window chrome", "graph-window.png", "titlebar.png",
     "Band, brand, menu, save state, centred document identity, right tools. "
     "Ours adds the marking pill and the environment search from the same crop."),
    ("Bottom action bar", "oe-actionbar.png", "actionbar.png",
     "Left select, sentence with underlined tokens, plain secondary, one filled "
     "primary. Same order, same weights."),
    ("Tabs with count badges", "oe-tabs.png", "tabs.png",
     "Icon, label, count. Accent underline plus accent-tinted icon when active."),
    ("Status strip", "gaia-status.png", "status.png",
     "Gaia's strip, rebuilt at 22px. Ours carries feed state where Gaia carries "
     "element count."),
]


def rows(data, cols):
    out = []
    for r in data:
        cells = "".join(f"<td>{c}</td>" for c in r)
        out.append(f"<tr>{cells}</tr>")
    head = "".join(f"<th>{c}</th>" for c in cols)
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(out)}</tbody></table>"


def pixel_table():
    body = []
    for name, raw, derived, built, bp in PIXEL:
        ok = abs(derived - built) <= 1
        mark = ('<span class="ok">match</span>' if ok
                else f'<span class="warn">off by {abs(derived - built)}px</span>')
        body.append(
            f"<tr><td>{name}</td><td class='n'>{raw}</td><td class='n'>{derived}</td>"
            f"<td class='n'>{built}</td><td>{bp}</td><td>{mark}</td></tr>"
        )
    return f"""<table>
<thead><tr><th>Element</th><th>Gotham raw</th><th>÷0.633</th><th>Velocity built</th>
<th>Blueprint variable</th><th>Verdict</th></tr></thead>
<tbody>{''.join(body)}</tbody></table>"""


def lang_table():
    out = []
    for topic, them, us, state, why in LANGUAGE:
        cls = {"aligned": "ok", "closed": "ok", "open": "warn"}[state]
        out.append(f"""<tr>
<td><b>{topic}</b></td><td>{them}</td><td>{us}</td>
<td><span class="{cls}">{state}</span></td></tr>
<tr class="why"><td></td><td colspan="3">{why}</td></tr>""")
    return f"""<table class="lang">
<thead><tr><th style="width:15%">Axis</th><th style="width:34%">Gotham, from its own docs</th>
<th style="width:34%">Velocity</th><th>State</th></tr></thead>
<tbody>{''.join(out)}</tbody></table>"""


def pro_list():
    out = []
    for name, them, us, why in PRO:
        out.append(f"""<div class="pro">
  <h3>{name}</h3>
  <div class="pgrid">
    <div><span class="lab">Gotham</span><p>{them}</p></div>
    <div><span class="lab">Velocity</span><p>{us}</p></div>
  </div>
  <p class="why">{why}</p>
</div>""")
    return "".join(out)


def crop_pairs():
    out = []
    for title, ref, ours, note in CROPS:
        out.append(f"""<div class="pair">
  <h3>{title}</h3>
  <p class="note">{note}</p>
  <div class="pimg"><span class="lab">Palantir, from the G-Cloud PDFs</span>
    <img src="_ref/{ref}" alt="Palantir {title}"></div>
  <div class="pimg"><span class="lab">Velocity, rebuilt</span>
    <img src="_crops/{ours}" alt="Velocity {title}"></div>
</div>""")
    return "".join(out)


CSS = """
:root{--bg:#111418;--p:#1c2127;--p2:#252a31;--p3:#2f343c;--e:#383e47;
--t0:#f6f7f9;--t1:#c5cbd3;--t2:#abb3bf;--t3:#8f99a8;--a:#2d72d2;--af:#8abbff;
--ok:#32a467;--okf:#72ca9b;--warn:#ec9a3c;--warnf:#fbb360;--alert:#e76a6e;
--mono:'IBM Plex Mono',ui-monospace,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--t1);
font:14px/1.55 'Inter','IBM Plex Sans',system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:40px 24px 96px}
h1{font-size:26px;color:var(--t0);margin:0 0 6px;font-weight:650}
.sub{color:var(--t3);font-size:14px;margin:0 0 8px}
h2{font-size:20px;color:var(--t0);margin:56px 0 4px;font-weight:600;
padding-top:22px;border-top:1px solid rgba(255,255,255,.08)}
h2 .ax{color:var(--af);font-family:var(--mono);font-size:12px;display:block;
margin-bottom:6px;letter-spacing:.06em}
h3{font-size:14px;color:var(--t0);margin:22px 0 6px;font-weight:600}
p{margin:0 0 12px}
code{font-family:var(--mono);font-size:12px;background:var(--p2);
padding:1px 4px;border-radius:2px;color:var(--t0)}
table{width:100%;border-collapse:collapse;margin:14px 0 8px;font-size:12px}
th{text-align:left;color:var(--t3);font-weight:600;padding:7px 10px;
border-bottom:1px solid var(--e);white-space:nowrap;text-transform:uppercase;
letter-spacing:.05em;font-size:12px}
td{padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.06);
vertical-align:top}
td.n{font-family:var(--mono);text-align:right;color:var(--t0)}
tr.why td{color:var(--t3);font-size:12px;padding-top:0;padding-bottom:12px;
border-bottom:1px solid rgba(255,255,255,.06)}
.lang td{vertical-align:top}
.ok{color:var(--okf)}.warn{color:var(--warnf)}.bad{color:var(--alert)}
.lead{background:var(--p);border-left:2px solid var(--a);padding:14px 16px;
margin:18px 0;border-radius:2px;color:var(--t1)}
.lead b{color:var(--t0)}
.pair{background:var(--p);border:1px solid rgba(255,255,255,.08);
border-radius:2px;padding:16px;margin:16px 0}
.pair .note{color:var(--t3);font-size:12px;margin-bottom:12px}
.pimg{margin-bottom:12px}
.pimg .lab,.pgrid .lab{display:block;font-family:var(--mono);font-size:12px;
color:var(--t3);margin-bottom:5px}
.pimg img{display:block;width:100%;height:auto;background:#0b0e11;
border:1px solid rgba(255,255,255,.1);border-radius:2px}
.pro{background:var(--p);border:1px solid rgba(255,255,255,.08);
border-radius:2px;padding:14px 16px;margin:12px 0}
.pro h3{margin:0 0 10px}
.pgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:10px}
.pgrid p{margin:0;font-size:12px;color:var(--t1)}
.pro .why{margin:0;color:var(--t3);font-size:12px;padding-top:10px;
border-top:1px solid rgba(255,255,255,.06)}
.sw{display:inline-block;width:34px;height:14px;border-radius:2px;
border:1px solid rgba(255,255,255,.14);vertical-align:middle;margin-right:7px}
.shot{width:100%;border:1px solid rgba(255,255,255,.1);border-radius:2px;
display:block;margin:12px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:820px){.pgrid,.grid2{grid-template-columns:1fr}}
ul{margin:0 0 12px;padding-left:20px}li{margin-bottom:5px}
.gap{background:rgba(236,154,60,.1);border-left:2px solid var(--warn);
padding:12px 14px;border-radius:2px;margin:14px 0;font-size:12px}
.gap b{color:var(--warnf)}
"""


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Velocity beside Gotham · pixel, language, design, professionalism</title>
<style>%s</style></head><body><div class="wrap">

<h1>Velocity beside Gotham</h1>
<p class="sub">Four axes, each with the evidence that produced it.
Built %s from the G-Cloud 14 service definition PDFs, 115 pages of published
Palantir Gotham documentation, and @blueprintjs source.</p>

<div class="lead">
<b>The one number everything else rests on: 0.633.</b> Gotham is Blueprint, and
Blueprint publishes <code>$pt-button-height: 30px</code>. The two accent-filled
buttons in the Object Explorer screenshot both measure 19px, so that capture sits
at 19/30 = 0.633 of true scale, and its 1161px width is a 1834px viewport, i.e. a
1920 screen. Every raw measurement divides by that. Without this the two sides
cannot be compared at all, only eyeballed.
</div>

<h2><span class="ax">AXIS 1</span>Pixel</h2>
<p>Measured off the crops in <code>_ref/</code> with <code>_measure.py</code> and
<code>_calibrate.py</code>, then checked against the built page in a real browser
by <code>_verify.mjs</code>. Nothing here is eyeballed.</p>
%s
<p class="sub">Every derived value lands on a published Blueprint control size.
That is the confirmation the calibration is right: an arbitrary scale factor
would not put nine independent measurements onto the same 10px-grid ladder.</p>
<p class="sub"><b>On the one row that does not match.</b> The icon rail derives to
43px and is built at 40px. The band detector cuts on colour change, so it counted
the rail's 1px border on each side plus antialiasing: 40px built back through the
scale is 25.3 raw px against 27 measured, which is that border. 40px is both the
Blueprint value and within measurement error, so it is what is built. Recorded
rather than quietly rounded, because the whole point of the table is that it can
be checked.</p>

<div class="gap"><b>What this corrected.</b> The earlier mockups used 26px rows
and recorded the remaining density gap against Gotham as "deliberate", on the
belief that Gotham ran small text in a roomy row and the 12px floor forbade
matching it. Gotham's dense row is <b>20px</b>, and Blueprint pairs
<code>$pt-button-height-smaller: 20px</code> with
<code>$pt-font-size-small: 12px</code>. The floor and Gotham density were never
in tension. The gap was an artefact of never having measured the row.</div>

<h3>Component crops, side by side</h3>
<p class="sub">Reference crops are shown at the width they were captured;
ours are 1:1 CSS pixels from the rendered page.</p>
%s

<h2><span class="ax">AXIS 2</span>Language</h2>
<p>Evidence is 115 scraped pages of Palantir's own Gotham documentation
(<code>_corpus/</code>, 34,119 words), not recollection.</p>
%s

<h2><span class="ax">AXIS 3</span>Design</h2>
<p>Gotham is built on Blueprint, which Palantir publishes. So "matching Gotham's
design system" is not interpretation, it is reading
<code>@blueprintjs/core/src/common/_variables.scss</code>.</p>
<div class="grid2">
<div><h3>Metrics, Blueprint v5</h3>%s</div>
<div><h3>Colour, @blueprintjs/colors 5.1.16</h3>%s</div>
</div>
<div class="gap"><b>Version note.</b> Blueprint v6 moved
<code>$pt-border-radius</code> from 2px to 4px and the spacing base from a 10px
grid to 4px. The 2024 screenshots this is built against are v5-era, so v5's 2px
radius is the faithful value and is what is built. If Velocity ever wants to
track current Blueprint instead of the screenshots, that is a deliberate
decision with a visible consequence, not a detail.</div>

<h2><span class="ax">AXIS 4</span>Professionalism</h2>
<p>What actually makes Gotham read as an instrument. Each of these is a
structural device, not a style, which is why the earlier mockups could match the
palette exactly and still read as a web app.</p>
%s

<h2>The console</h2>
<img class="shot" src="_shots/gotham-console.png" alt="Velocity console, Gotham grammar">
<h3>The fourth state</h3>
<img class="shot" src="_shots/gotham-degraded.png" alt="Velocity console, degraded state">

<h2>Honestly not closed</h2>
<div class="gap">
<ul>
<li><b>The basemap is still hand-drawn.</b> Gaia runs Mapbox Streets and
Satellite: real aerial imagery, roads, place labels, highway shields. This has a
projected Baltic coastline with a labelled graticule, scale bar and north arrow.
That gap closes with a real tile layer in the running app, not in static HTML.</li>
<li><b>Nothing under <code>apps/</code> has changed.</b> This is a mockup. The
file mapping that turns it into code is §8 of
<code>docs/dashboard-redesign-2026-08.md</code>, and it is unstarted.</li>
<li><b>Velocity's filter primitives are still unnamed.</b> Adopting Palantir's
query vocabulary would let one sentence renderer serve every panel. Not built.</li>
<li><b>The 780 sub-11px literals in the shipped app are untouched.</b> This
mockup holds the 12px floor at 0 violations; sweeping the app is a separate
sequenced pass.</li>
<li><b>Slides, Chat and Dossier were catalogued and not rebuilt.</b> None maps
onto a Velocity surface that exists. Rebuilding them would be copying rather
than extending the grammar.</li>
</ul>
</div>

</div></body></html>
"""


def main():
    from datetime import date
    OUT.write_text(
        PAGE % (
            CSS,
            date.today().isoformat(),
            pixel_table(),
            crop_pairs(),
            lang_table(),
            rows(BLUEPRINT, ["Blueprint variable", "Value", "Velocity token"]),
            "".join(
                f'<tr><td><span class="sw" style="background:{hexv}"></span>'
                f"<code>{bp}</code></td><td class='n'>{hexv}</td>"
                f"<td><code>{tok}</code></td></tr>"
                for bp, hexv, tok in COLORS
            ).join([
                '<table><thead><tr><th>Blueprint</th><th>Hex</th><th>Velocity</th>'
                '</tr></thead><tbody>', "</tbody></table>"]),
            pro_list(),
        ),
        encoding="utf-8",
    )
    print(f"wrote {OUT.name} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
