#!/usr/bin/env python3
"""_build.py — generate the console mockup set.

    node _icons.mjs > _sprite.svg     # once, or when the icon list changes
    python3 _build.py                 # all pages

Every page composes from _parts.py and _map.py, so a panel renders the same on
each page or it renders wrong on all of them. Output is deterministic: a fixed
RNG seed means a screenshot diff is a real change, not a reshuffle.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from _parts import (RNG, actionbar, bar, count, ic, kv, mark, meter, obj_card,
                    page, panel_head, panel_tools, row, sect, spark, state,
                    banner, switch, thumb, dots, tabstrip, titlebar, COLOR,
                    silhouette)
import _map as M
import _apps as A
import _kit as K
import _decide as D

HERE = Path(__file__).parent
written: list[tuple[str, str]] = []


def emit(name: str, title: str, body: str) -> None:
    (HERE / name).write_text(page(title, body))
    written.append((name, title))


# ════════════════════════════════════════════════════════════════════════════
# The map console
# ════════════════════════════════════════════════════════════════════════════

def map_well(*, selected: bool = False, dock_html: str | None = None,
             overlay: str = "", strip_link: str = "ok") -> str:
    sel_track = (M.selection_track() +
                 '<span class="reticle" style="left:55.6%;top:44.6%"></span>'
                 ) if selected else ""
    return f"""<main class="map">
{M.tiles()}
<div class="map-fade"></div>
{M.contacts()}
{sel_track}
{M.labels()}
{M.map_strip(link=strip_link)}
{M.toolbar('select' if selected else 'hand')}\n{M.compass(0)}
{M.map_furniture()}
{overlay}
{dock_html if dock_html is not None else M.dock()}
</main>"""


def console(*, tab: str = "Layers", left: str, right: str = "",
            selected: bool = False, dock_html: str | None = None,
            overlay: str = "", action: str = "", doc: str = "Baltic approaches watch",
            strip_link: str = "ok") -> str:
    body_cls = "body" if right else "body no-right"
    return f"""<div class="shell">
{titlebar(doc=doc)}
{tabstrip(tab)}
<div class="{body_cls}">
{left}
{map_well(selected=selected, dock_html=dock_html, overlay=overlay, strip_link=strip_link)}
{right}
</div>
{action}
</div>"""


SENTENCE_LIVE = ('Keeping <b>Aircraft</b> with <u>Category</u> matching any of '
                 '<u>Military</u>, <u>Emergency</u> and <u>Altitude</u> <u>above</u> '
                 '<u>FL300</u>')


def build_map() -> None:
    emit("10-map.html", "Map &middot; live",
         console(left=M.layers_panel(), right=M.series_panel(),
                 action=actionbar(SENTENCE_LIVE)))

    emit("11-map-selected.html", "Map &middot; contact selected",
         console(left=M.layers_panel(), right=M.selection_panel(), selected=True,
                 action=actionbar(SENTENCE_LIVE)))

    emit("12-map-replay.html", "Map &middot; replay",
         console(tab="Series", left=M.layers_panel(), right=M.series_panel(),
                 selected=True,
                 dock_html=M.dock(
                     playing=True, live=False, clock="2026-07-28 16:13:05 Z",
                     window_label=("Replaying <b>2026-07-28 14:15 to 17:10 Z</b> "
                                   "&middot; the strip spans the loaded range, not a fixed 20 h"),
                     foot_right=(f'{ic("check", "ic-sm")}<span>2,000 tracks &middot; '
                                 f'418,904 fixes &middot; 6 % of window truncated</span>')),
                 action=actionbar(
                     'Replaying <b>Aircraft</b> and <b>Vessels</b> where <u>seen</u> '
                     '<u>between</u> <u>14:15</u> and <u>17:10 Z</u>',
                     primary="Export this window")))

    emit("13-map-histogram.html", "Map &middot; histogram",
         console(tab="Histogram", left=M.histogram_panel(), right=M.selection_panel(),
                 selected=True, action=actionbar(SENTENCE_LIVE)))

    emit("14-map-find.html", "Map &middot; find",
         console(tab="Find", left=M.find_panel(), right=M.series_panel(),
                 overlay=(M.radius_aoi(52, 47, 300, "50 km")
                          + M.range_rings(52, 47, [(60, "10 km"), (110, "25 km"), (150, "50 km")])
                          + CTX_MENU),
                 action=actionbar(
                     'Keeping <b>Objects</b> <u>within</u> <u>50 km</u> of '
                     '<u>33UXP 0421 5518</u>', primary="Add to filter path")))

    emit("15-map-info.html", "Map &middot; info",
         console(tab="Info", left=M.info_panel(), right=M.series_panel(),
                 action=actionbar(SENTENCE_LIVE)))


# The cascading context menu, straight from tmp/palantir/parts/graph-dropdown.png.
# Every item carries a distinct 16px line icon; a submenu shows a caret.
CTX_MENU = f"""<div style="position:absolute;left:34%;top:30%;display:flex;align-items:flex-start">
  <div class="ctx">
    <div class="hd">1 selected item</div>
    <button>{ic('filter', 'ic-sm')}<span class="sp">Add selection as filter</span></button>
    <button>{ic('select', 'ic-sm')}<span class="sp">Select on graph</span>{ic('chevron-right', 'ic-sm')}</button>
    <button class="open">{ic('around', 'ic-sm')}<span class="sp">Search around</span>{ic('chevron-right', 'ic-sm')}</button>
    <button>{ic('network', 'ic-sm')}<span class="sp">Layout</span>{ic('chevron-right', 'ic-sm')}</button>
    <button>{ic('layers', 'ic-sm')}<span class="sp">Layers</span>{ic('chevron-right', 'ic-sm')}</button>
    <button>{ic('more', 'ic-sm')}<span class="sp">Actions</span>{ic('chevron-right', 'ic-sm')}</button>
    <div class="sep"></div>
    <div class="hd">1 selected contact</div>
    <button>{ic('pencil', 'ic-sm')}<span class="sp">Style</span>{ic('chevron-right', 'ic-sm')}</button>
    <button>{ic('annotate', 'ic-sm')}<span class="sp">Edit label</span></button>
    <button>{ic('link', 'ic-sm')}<span class="sp">Merge</span>{ic('chevron-right', 'ic-sm')}</button>
    <button>{ic('unlink', 'ic-sm')}<span class="sp">Unresolve</span></button>
    <div class="sep"></div>
    <button>{ic('trash', 'ic-sm')}<span class="sp">Remove</span>{ic('chevron-right', 'ic-sm')}</button>
  </div>
  <div class="ctx" style="margin-left:2px;margin-top:74px;min-width:180px">
    <button>{ic('file', 'ic-sm')}<span class="sp">Documents</span></button>
    <button>{ic('users', 'ic-sm')}<span class="sp">Entities</span></button>
    <button>{ic('calendar', 'ic-sm')}<span class="sp">Events</span></button>
    <button>{ic('list', 'ic-sm')}<span class="sp">Properties</span></button>
    <button>{ic('database', 'ic-sm')}<span class="sp">Record sourcing</span></button>
    <button>{ic('around', 'ic-sm')}<span class="sp">Related artifacts</span></button>
    <div class="sep"></div>
    <button><span class="sp">Create new search</span></button>
  </div>
</div>"""


# ════════════════════════════════════════════════════════════════════════════
# States. Four, not three: the real failure the persona waves kept finding is
# DEGRADED, where a surface has some data and is quietly missing the rest.
# ════════════════════════════════════════════════════════════════════════════

def skeleton_rows(n: int = 9) -> str:
    out = []
    for i in range(n):
        w = 40 + (i * 17) % 45
        out.append(
            f'<div class="row two"><span class="skel" style="width:12px;height:12px"></span>'
            f'<span class="nm"><span class="skel" style="display:block;width:{w}%;height:9px"></span>'
            f'<span class="skel" style="display:block;width:{w - 18}%;height:7px;margin-top:4px"></span></span>'
            f'<span class="skel" style="width:84px;height:10px"></span></div>')
    return "".join(out)


def build_states() -> None:
    loading = (f'<aside class="panel">{panel_head("Layers")}{panel_tools()}'
               f'<div class="panel-body">{sect("Air", "")}{skeleton_rows()}</div></aside>')
    empty = (f'<aside class="panel">{panel_head("Find")}{panel_tools()}'
             f'<div class="panel-body">'
             + state("", "No contacts in this area",
                     "Nothing is transmitting inside 50 km of 33UXP 0421 5518. "
                     "Widen the radius, or check the Info panel for a silent feed.",
                     "search")
             + '<div class="pad"><button class="btn sm gho" style="width:100%">'
             + ic("around", "ic-sm") + "Search 200 km instead</button></div></div></aside>")
    error = (f'<aside class="panel">{panel_head("Layers")}{panel_tools()}'
             f'<div class="panel-body">'
             + state("err", "Layers unavailable (HTTP 503)",
                     "The backend answered but could not serve the layer registry. "
                     "Live contacts on the map are unaffected.",
                     "circle-alert")
             + '<div class="pad" style="display:flex;gap:6px;justify-content:center">'
             + f'<button class="btn sm pri">{ic("refresh", "ic-sm")}Retry</button>'
             + '<button class="btn sm gho">Open Info</button></div></div></aside>')

    grid = f"""<div class="shell">
{titlebar(doc='States &middot; loading, empty, error, degraded')}
{tabstrip('Layers')}
<div class="app">
  <div class="app-body">
    <div class="grid g4" style="height:100%;align-items:stretch">
      <div class="card"><div class="card-h">Loading</div><div class="card-b flush" style="height:760px;display:flex">{loading}</div></div>
      <div class="card"><div class="card-h">Empty</div><div class="card-b flush" style="height:760px;display:flex">{empty}</div></div>
      <div class="card"><div class="card-h">Error</div><div class="card-b flush" style="height:760px;display:flex">{error}</div></div>
      <div class="card"><div class="card-h">Degraded</div><div class="card-b flush" style="height:760px;display:flex">{M.layers_panel(degraded=True)}</div></div>
    </div>
    <p class="mut" style="margin:12px 0 0;font-size:12px;max-width:760px;line-height:1.6">
      Three states were already required by <span class="mono">docs/frontend.md:147</span> and guarded by
      <span class="mono">layer-rail/OpsPanel.test.tsx:34</span>. Both persona waves still found silent failure,
      because the real case is the fourth: the surface has some data and is quietly missing the rest.
      A vessel count that reads low because one of two sources is wedged has to say so on the count itself.
    </p>
  </div>
</div>
</div>"""
    emit("16-states.html", "States", grid)


def build_apps() -> None:
    for fn, (title, maker) in A.APPS.items():
        emit(fn, title, maker())
    emit("32-decide.html", "Decide", D.decide_page())


NAV = [("00-index.html", "Board"), ("01-kit.html", "Kit"),
       ("10-map.html", "Map"), ("12-map-replay.html", "Replay"),
       ("16-states.html", "States"), ("20-graph.html", "Graph"),
       ("27-foundry.html", "Foundry")]


def build_frame() -> None:
    emit("01-kit.html", "Component kit", K.kit_page(K.nav(NAV, "01-kit.html")))
    emit("00-index.html", "Console board", K.index_page(written, K.nav(NAV, "00-index.html")))


if __name__ == "__main__":
    build_map()
    build_states()
    build_apps()
    build_frame()
    for name, title in written:
        print(f"  {name:28s} {title}")
    print(f"{len(written)} pages")
