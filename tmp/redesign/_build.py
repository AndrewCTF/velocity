#!/usr/bin/env python3
"""Assemble the redesign mockups.

The seven Palantir panels are authored ONCE here and injected into every page
that shows them, so "at fidelity" means the same markup everywhere rather than a
sketch on the direction pages and a real one on the gallery. Output is plain
self-contained HTML: no build step is needed to view it, and no network fetch
happens at render time.
"""
import pathlib, re
from _a11y import upgrade

HERE = pathlib.Path(__file__).parent
GLOBE = re.sub(r'^<!--.*?-->\s*', '', HERE.joinpath('_globe.svg').read_text(), flags=re.S).strip()

ICONS = """<svg style="display:none" aria-hidden="true"><defs>
<g id="i-search" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></g>
<g id="i-grid" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></g>
<g id="i-select" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="m9 9 8 3-3.4 1.6L12 17Z"/></g>
<g id="i-around" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="2.6"/><circle cx="5" cy="6" r="2.2"/><circle cx="19" cy="6" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="m10.2 10.4-3.4-2.8M13.8 10.4l3.4-2.8M13.8 13.6l3.4 2.8"/></g>
<g id="i-draw" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3Z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5Z"/><path d="m2 2 7.6 7.6"/></g>
<g id="i-camera" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L8 6.5H4.5A1.5 1.5 0 0 0 3 8v10a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V8a1.5 1.5 0 0 0-1.5-1.5H16Z"/><circle cx="12" cy="12.5" r="3.4"/></g>
<g id="i-ruler" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 14.1 14.1 2.6a2 2 0 0 1 2.8 0l4.5 4.5a2 2 0 0 1 0 2.8L9.9 21.4a2 2 0 0 1-2.8 0l-4.5-4.5a2 2 0 0 1 0-2.8Z"/><path d="m7 10 2 2M10 7l2 2M13 4l2 2M4 13l2 2"/></g>
<g id="i-pin" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5.5-8 12-8 12s-8-6.5-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.6"/></g>
<g id="i-trash" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/></g>
<g id="i-hand" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6.5a1.5 1.5 0 0 0-3 0V11"/><path d="M15 10.5V4.5a1.5 1.5 0 0 0-3 0V11"/><path d="M12 10.5V5.5a1.5 1.5 0 0 0-3 0V13"/><path d="M9 12V9a1.5 1.5 0 0 0-3 0v6.5c0 3.6 2.4 5.5 6 5.5s6-1.9 6-5.5V11"/></g>
<g id="i-bell" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 6-3 7-3 7h18s-3-1-3-7"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/></g>
<g id="i-pause" fill="currentColor" stroke="none"><rect x="6" y="4.5" width="4" height="15" rx="1.5"/><rect x="14" y="4.5" width="4" height="15" rx="1.5"/></g>
<g id="i-chev" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></g>
<g id="i-up" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></g>
<g id="i-lock" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></g>
<g id="i-x" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></g>
<g id="i-eye" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></g>
<g id="i-graph" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="7" r="2.6"/><circle cx="12" cy="18" r="2.6"/><path d="m8.3 7.3 2 8.4M16.6 9.2l-3 6.9M8.5 6.4l7-.3"/></g>
<g id="i-target" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/></g>
<g id="i-db" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><ellipse cx="12" cy="5.5" rx="8" ry="3.2"/><path d="M4 5.5v13c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-13"/><path d="M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2"/></g>
<g id="i-gear" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8.5"/></g>
<g id="i-plane" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 8 14h8L12 2Z"/><path d="M10 17h4v3l-2-1.2L10 20v-3Z"/></g>
<g id="i-layers" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></g>
<g id="i-hist" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 21V10"/><path d="M9 21V4"/><path d="M15 21v-8"/><path d="M21 21V8"/></g>
<g id="i-info" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5"/><path d="M12 8h.01"/></g>
<g id="i-series" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m7 14 3.5-4 3 2.6L20 6"/></g>
<g id="i-clock" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></g>
</defs></svg>"""

# ── The seven panels, authored once ─────────────────────────────────────────

P = {}

P['layers'] = """
<div class="phead"><h2>Layers</h2><span class="badge">18 of 64 on</span><span style="flex:1"></span><button class="btn sm quiet">Presets</button></div>
<div class="pbody">
  <div class="input" style="margin-bottom:14px"><svg width="15" height="15" style="opacity:.55"><use href="#i-search"/></svg><span class="ph">Filter sources</span></div>
  <div style="display:flex;gap:7px;flex-wrap:wrap">
    <span class="chip on">Air picture</span><span class="chip">Maritime</span><span class="chip">Conflict</span><span class="chip">Cyber</span>
  </div>

  <div class="sec"><div class="sech"><h3>Air</h3><span class="ct">3 of 6</span></div>
    <div class="row on"><span class="dot ok"></span><span class="nm">Aircraft<span class="sub">Multi-source ADS-B · 1 s</span></span><span class="ct">12,418</span><span class="toggle on"><i></i></span></div>
    <div style="display:flex;align-items:center;gap:11px;padding:2px 0 14px 19px">
      <div class="meter" style="flex:1"><i style="width:100%"></i></div>
      <span class="mono" style="font-size:var(--fs-cap);color:var(--txt-3)">100%</span>
      <span class="chip on" style="padding:3px 10px" title="Loading method">Auto</span>
      <svg width="15" height="15" style="color:var(--txt-4)" title="Lock layer"><use href="#i-lock"/></svg>
    </div>
    <div class="row on"><span class="dot ok"></span><span class="nm">Military<span class="sub">airplanes.live</span></span><span class="ct">284</span><span class="toggle on"><i></i></span></div>
    <div class="row on"><span class="dot warn"></span><span class="nm">Emergency<span class="sub">Squawk 7500, 7600, 7700</span></span><span class="ct">3</span><span class="toggle on"><i></i></span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">TFR and airspace</span><span class="ct">&mdash;</span><span class="toggle"><i></i></span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">SIGMET and AIRMET</span><span class="ct">&mdash;</span><span class="toggle"><i></i></span></div>
    <div class="row"><span class="dot alert"></span><span class="nm">Ground stops<span class="sub">Unavailable (HTTP 503)</span></span><span class="ct">&mdash;</span><span class="toggle"><i></i></span></div>
  </div>

  <div class="sec"><div class="sech"><h3>Maritime</h3><span class="ct">3 of 11</span></div>
    <div class="row on"><span class="dot ok"></span><span class="nm">Vessels<span class="sub">All AIS sources</span></span><span class="ct">31,204</span><span class="toggle on"><i></i></span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Baltic AIS</span><span class="ct">1,842</span><span class="toggle"><i></i></span></div>
    <div class="row on"><span class="dot ok"></span><span class="nm">Dark-vessel SAR<span class="sub">Sentinel-1 · 6 areas</span></span><span class="ct">6</span><span class="toggle on"><i></i></span></div>
    <div class="row"><span class="dot"></span><span class="nm">Parking mode</span><span class="ct">&mdash;</span><span class="toggle"><i></i></span></div>
    <div class="row on"><span class="dot ok"></span><span class="nm">Naval warnings</span><span class="ct">311</span><span class="toggle on"><i></i></span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Marine buoys</span><span class="ct">1,204</span><span class="toggle"><i></i></span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Chokepoint congestion</span><span class="ct">9</span><span class="toggle"><i></i></span></div>
  </div>

  <div class="sec"><div class="sech"><h3>Ground and hazards</h3><span class="ct">4 of 13</span></div>
    <div class="row on"><span class="dot ok"></span><span class="nm">Earthquakes</span><span class="ct">118</span><span class="toggle on"><i></i></span></div>
    <div class="row on"><span class="dot warn"></span><span class="nm">Fires<span class="sub">Largest layer in view. Switch to Tile loading?</span></span><span class="ct">14,818</span><span class="toggle on"><i></i></span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Wildfire perimeters</span><span class="ct">204</span><span class="toggle"><i></i></span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Tropical cyclones</span><span class="ct">3</span><span class="toggle"><i></i></span></div>
  </div>

  <div class="sec"><div class="sech"><h3>Space</h3><span class="ct">1 of 5</span></div>
    <div class="row on"><span class="dot ok"></span><span class="nm">Stations and ISS</span><span class="ct">12</span><span class="toggle on"><i></i></span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Starlink</span><span class="ct">7,412</span><span class="toggle"><i></i></span></div>
  </div>
  <div class="sec"><div class="sech"><h3>Signals and events</h3><span class="ct">2 of 6</span></div>
    <div class="row on"><span class="dot ok"></span><span class="nm">Armed conflict</span><span class="ct">642</span><span class="toggle on"><i></i></span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Internet outages</span><span class="ct">17</span><span class="toggle"><i></i></span></div>
  </div>
  <div class="sec"><div class="sech"><h3>Infrastructure</h3><span class="ct">5 of 18</span></div>
    <div class="row on"><span class="dot ok"></span><span class="nm">Submarine cables</span><span class="ct">486</span><span class="toggle on"><i></i></span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Power plants</span><span class="ct">2,000</span><span class="toggle"><i></i></span></div>
  </div>
  <div class="sec"><div class="sech"><h3>Reference</h3><span class="ct">1 of 1</span></div>
    <div class="row"><span class="dot"></span><span class="nm">COP units<span class="sub">MIL-STD-2525, notional</span></span><span class="ct">&mdash;</span><span class="toggle"><i></i></span></div>
  </div>
  <div class="sec"><div class="sech"><h3>Superseded</h3><span class="ct">3 hidden</span></div>
    <p style="font-size:var(--fs-cap);color:var(--txt-3);line-height:1.6">adsb.fi, OpenSky states and AISStream each duplicate a source that is already on. Kept and reachable, not dropped.</p>
  </div>
</div>"""

P['find'] = """
<div class="phead"><h2>Find</h2><span class="badge accent">MGRS</span><span style="flex:1"></span><button class="btn sm quiet">Saved</button></div>
<div class="pbody">
  <div class="input focus" style="margin-bottom:12px"><span class="mono">33UXP 0421 5518</span></div>
  <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:var(--sp-2)">
    <button class="btn sm accent">Fly here</button><button class="btn sm">Drop a pin</button><button class="btn sm">Search 50 km</button>
  </div>
  <p style="font-size:var(--fs-cap);color:var(--txt-3)">Reads as MGRS · 54.3181 N, 18.7122 E</p>

  <div class="sec"><div class="sech"><h3>Contacts</h3><span class="ct">2</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">RCH471<span class="sub">C-17A · FL310 · 12 km away</span></span><span class="ct">aircraft</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">NORDIC STAR<span class="sub">MMSI 273441000 · 4 km away</span></span><span class="ct">vessel</span></div>
  </div>

  <div class="sec"><div class="sech"><h3>Places</h3><span class="ct">3</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Gdansk Lech Walesa<span class="sub">EPGD · airport</span></span><span class="ct">8 km</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Port of Gdansk<span class="sub">PLGDN · port</span></span><span class="ct">3 km</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Gdynia naval base<span class="sub">military base</span></span><span class="ct">21 km</span></div>
  </div>

  <div class="sec"><div class="sech"><h3>Saved areas</h3><span class="ct">6</span></div>
    <div class="row on"><span class="dot ok"></span><span class="nm">Baltic approaches</span><span class="ct">active</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Bab-el-Mandeb</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Taiwan Strait</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Hormuz</span></div>
  </div>

  <div class="sec"><div class="sech"><h3>Non-geographic</h3></div>
    <p style="font-size:var(--fs-cap);color:var(--txt-3);line-height:1.6;margin-bottom:9px">Domains, people, usernames, companies and wallets resolve here too, and open in the Investigate surface.</p>
    <div class="state warn"><b>OSINT lookups need a key</b><p>Object search works keyless. Sanctions, registry and breach lookups do not.</p></div>
  </div>

  <div class="sec"><div class="sech"><h3>Formats accepted</h3></div>
    <p style="font-size:var(--fs-cap);color:var(--txt-3);line-height:1.8">Decimal degrees · degrees minutes seconds · MGRS · UTM · MMSI · IMO · ICAO24 · callsign · vessel name · place name · domain · wallet</p>
  </div>
</div>"""

P['histogram'] = """
<div class="phead"><h2>Histogram</h2><span class="badge">13,204</span><span style="flex:1"></span><button class="btn sm quiet">Clear 2</button></div>
<div class="pbody">
  <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:var(--sp-2)">
    <span class="chip on">Military</span><span class="chip on">FL300 to FL800</span>
  </div>
  <div class="sec"><div class="sech"><h3>Aircraft category</h3><span class="ct">12,418</span></div>
    <div class="hbar sel"><span class="hb-l">Military</span><span class="hb-t"><i style="width:9%"></i></span><span class="hb-c">284</span></div>
    <div class="hbar"><span class="hb-l">Airliner</span><span class="hb-t"><i style="width:96%"></i></span><span class="hb-c">9,914</span></div>
    <div class="hbar"><span class="hb-l">Private</span><span class="hb-t"><i style="width:18%"></i></span><span class="hb-c">1,806</span></div>
    <div class="hbar"><span class="hb-l">Helicopter</span><span class="hb-t"><i style="width:4%"></i></span><span class="hb-c">371</span></div>
    <div class="hbar"><span class="hb-l">Glider</span><span class="hb-t"><i style="width:1%"></i></span><span class="hb-c">43</span></div>
  </div>
  <div class="sec"><div class="sech"><h3>Altitude band</h3></div>
    <div class="hbar"><span class="hb-l">On ground</span><span class="hb-t"><i style="width:21%"></i></span><span class="hb-c">2,104</span></div>
    <div class="hbar"><span class="hb-l">0 to 1 km</span><span class="hb-t"><i style="width:9%"></i></span><span class="hb-c">918</span></div>
    <div class="hbar"><span class="hb-l">1 to 3 km</span><span class="hb-t"><i style="width:14%"></i></span><span class="hb-c">1,402</span></div>
    <div class="hbar sel"><span class="hb-l">3 to 8 km</span><span class="hb-t"><i style="width:32%"></i></span><span class="hb-c">3,211</span></div>
    <div class="hbar sel"><span class="hb-l">8 to 12 km</span><span class="hb-t"><i style="width:41%"></i></span><span class="hb-c">4,118</span></div>
    <div class="hbar"><span class="hb-l">12 km and up</span><span class="hb-t"><i style="width:6%"></i></span><span class="hb-c">602</span></div>
    <div class="hbar"><span class="hb-l">Not reported</span><span class="hb-t"><i style="width:1%"></i></span><span class="hb-c">63</span></div>
  </div>
  <div class="sec"><div class="sech"><h3>Vessel type</h3><span class="ct">31,204</span></div>
    <div class="hbar"><span class="hb-l">Cargo</span><span class="hb-t"><i style="width:74%"></i></span><span class="hb-c">11,842</span></div>
    <div class="hbar"><span class="hb-l">Tanker</span><span class="hb-t"><i style="width:41%"></i></span><span class="hb-c">6,551</span></div>
    <div class="hbar"><span class="hb-l">Fishing</span><span class="hb-t"><i style="width:28%"></i></span><span class="hb-c">4,470</span></div>
    <div class="hbar"><span class="hb-l">Passenger</span><span class="hb-t"><i style="width:12%"></i></span><span class="hb-c">1,918</span></div>
    <div class="hbar"><span class="hb-l">Military</span><span class="hb-t"><i style="width:2%"></i></span><span class="hb-c">204</span></div>
  </div>
  <div class="sec"><div class="sech"><h3>Flag, derived</h3><span class="ct">top 12</span></div>
    <div class="hbar"><span class="hb-l">US</span><span class="hb-t"><i style="width:88%"></i></span><span class="hb-c">3,914</span></div>
    <div class="hbar"><span class="hb-l">DE</span><span class="hb-t"><i style="width:34%"></i></span><span class="hb-c">1,502</span></div>
    <div class="hbar"><span class="hb-l">GB</span><span class="hb-t"><i style="width:31%"></i></span><span class="hb-c">1,371</span></div>
    <div class="hbar"><span class="hb-l">PA</span><span class="hb-t"><i style="width:22%"></i></span><span class="hb-c">981</span></div>
  </div>
  <div class="sec"><div class="sech"><h3>Squawk</h3><span class="ct">top 12</span></div>
    <div class="hbar"><span class="hb-l">Emergency</span><span class="hb-t"><i style="width:2%;background:var(--alert)"></i></span><span class="hb-c">3</span></div>
    <div class="hbar"><span class="hb-l">2000</span><span class="hb-t"><i style="width:44%"></i></span><span class="hb-c">1,912</span></div>
    <div class="hbar"><span class="hb-l">7000</span><span class="hb-t"><i style="width:38%"></i></span><span class="hb-c">1,644</span></div>
  </div>
  <p style="font-size:var(--fs-cap);color:var(--txt-3);line-height:1.6;margin-top:var(--sp-4)">
    Brushing a bucket dims the contacts that do not match. It never removes them, so a filter can never be mistaken for an empty feed.
  </p>
</div>"""

P['info'] = """
<div class="phead"><h2>Info</h2><span class="badge warn">2 degraded</span><span style="flex:1"></span><button class="btn sm quiet">Export</button></div>
<div class="pbody">
  <div class="state warn" style="padding-top:0">
    <b>Showing 2 of 3 vessel sources</b>
    <p>The MyShipTracking sidecar has been silent for 6 minutes, so vessel counts read low. Last good data 06:14Z.</p>
    <button class="btn sm">Restart the sidecar</button>
  </div>

  <div class="sec"><div class="sech"><h3>What you are looking at</h3></div>
    <dl class="kv">
      <dt>Contacts on screen</dt><dd>13,204</dd>
      <dt>Aircraft</dt><dd>12,418</dd>
      <dt>Vessels</dt><dd>31,204</dd>
      <dt>Layers on</dt><dd>18 of 64</dd>
      <dt>Cesium data sources</dt><dd>78</dd>
      <dt>Viewport</dt><dd>54.3 N to 55.9 N</dd>
    </dl>
  </div>

  <div class="sec"><div class="sech"><h3>Feeds</h3><span class="ct">11 of 13 healthy</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">OpenSky<span class="sub">breadth · 1 pull per UTC day</span></span><span class="ct">2 s</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">airplanes.live<span class="sub">grid overlay</span></span><span class="ct">1 s</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">ShipXplorer<span class="sub">direct</span></span><span class="ct">4 s</span></div>
    <div class="row"><span class="dot warn"></span><span class="nm">MyShipTracking<span class="sub">sidecar :8093 · silent</span></span><span class="ct">6 min</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">USGS quakes</span><span class="ct">58 s</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">NASA FIRMS</span><span class="ct">4 min</span></div>
    <div class="row"><span class="dot alert"></span><span class="nm">FAA NAS status<span class="sub">Unavailable (HTTP 503)</span></span><span class="ct">&mdash;</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">CelesTrak<span class="sub">TLE · 2 h cache</span></span><span class="ct">41 min</span></div>
  </div>

  <div class="sec"><div class="sech"><h3>Render</h3></div>
    <dl class="kv">
      <dt>Frames per second</dt><dd>58</dd>
      <dt>Renders per second</dt><dd>6.0</dd>
      <dt>Push drain</dt><dd>41 ms</dd>
      <dt>Frame time p50</dt><dd>148.7 ms</dd>
      <dt>JS heap</dt><dd>2,476 MB</dd>
    </dl>
  </div>

  <div class="sec"><div class="sech"><h3>Backend</h3></div>
    <dl class="kv">
      <dt>Event loop lag p99</dt><dd>18 ms</dd>
      <dt>Snapshot cycle</dt><dd>1.0 s</dd>
      <dt>Snapshot age</dt><dd>0.4 s</dd>
      <dt>Upstream requests</dt><dd>221 per min</dd>
    </dl>
  </div>

  <div class="sec"><div class="sech"><h3>Recording</h3></div>
    <dl class="kv">
      <dt>Since</dt><dd>2026-06-14</dd>
      <dt>On disk</dt><dd>4.1 GB</dd>
      <dt>Fixes</dt><dd>25.7 M</dd>
      <dt>Retention</dt><dd>byte capped</dd>
    </dl>
  </div>

  <div class="sec"><div class="sech"><h3>Watchboxes</h3><span class="ct">3</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Gdansk approach<span class="sub">any military aircraft</span></span><span class="ct">2 hits</span></div>
    <div class="row"><span class="dot"></span><span class="nm">Kerch Strait<span class="sub">AIS gap over 2 h</span></span><span class="ct">0</span></div>
    <div class="row"><span class="dot ok"></span><span class="nm">Bornholm cable<span class="sub">vessel loitering</span></span><span class="ct">1 hit</span></div>
  </div>
</div>"""

P['selection'] = """
<div class="phead"><h2>RYR4213</h2><span class="badge accent">Aircraft</span><span style="flex:1"></span><button class="btn sm quiet">Compact</button></div>
<div class="pbody">
  <div class="mono" style="font-size:var(--fs-cap);color:var(--txt-3);margin-bottom:11px">ICAO24 4CA2D3 · IE · updated 1 s ago</div>
  <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:var(--sp-4)">
    <span class="badge">Airliner</span><span class="badge ok">3 sources</span><span class="badge">Boeing 737-800</span>
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn sm accent">Slew to</button><button class="btn sm">Follow</button>
    <button class="btn sm">Search around</button><button class="btn sm">Pattern of life</button>
    <button class="btn sm">Flag</button>
  </div>

  <div class="sec"><div class="sech"><h3>Details</h3></div>
    <dl class="kv">
      <dt>Callsign</dt><dd>RYR4213</dd>
      <dt>ICAO24</dt><dd>4CA2D3</dd>
      <dt>Squawk</dt><dd>2117</dd>
      <dt>ADS-B category</dt><dd>A3</dd>
      <dt>Ground speed</dt><dd>449 kn</dd>
      <dt>Track</dt><dd>024&deg;</dd>
      <dt>Vertical rate</dt><dd>+4.2 m/s</dd>
      <dt>Altitude</dt><dd>9,754 m</dd>
      <dt>Position</dt><dd>54.3181, 18.7122</dd>
      <dt>Registration</dt><dd class="na">&mdash;</dd>
    </dl>
  </div>

  <div class="sec"><div class="sech"><h3>Flight</h3><span class="ct">DUB to GDN</span></div>
    <dl class="kv">
      <dt>Departed</dt><dd>Dublin 06:12Z</dd>
      <dt>Arriving</dt><dd>Gdansk 09:05Z</dd>
      <dt>Progress</dt><dd>78%</dd>
    </dl>
  </div>

  <div class="sec"><div class="sech"><h3>Correlations</h3><span class="ct">1</span></div>
    <div class="row"><span class="dot warn"></span><span class="nm">Crossed a naval warning area 14 min ago<span class="sub">NAVAREA I broadcast 311</span></span></div>
  </div>

  <div class="sec"><div class="sech"><h3>Freshness</h3></div>
    <dl class="kv">
      <dt>Last refresh</dt><dd>1 s</dd>
      <dt>Last position fix</dt><dd>2 s</dd>
      <dt>Seen by</dt><dd>3 sources</dd>
      <dt>Confidence</dt><dd>high</dd>
    </dl>
  </div>
</div>"""

P['series'] = """
<div class="phead"><h2>Series</h2><span class="badge">last 60 min</span><span style="flex:1"></span><button class="btn sm quiet">6 h</button></div>
<div class="pbody">
  <div class="sec" style="margin-top:0">
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:5px">
      <span style="font-size:var(--fs-dense);color:var(--txt-2)">Altitude</span>
      <span class="mono" style="font-size:var(--fs-dense)">9,754 m</span></div>
    <svg class="spark" viewBox="0 0 320 58" preserveAspectRatio="none">
      <polygon class="fill" points="0,56 24,52 48,45 72,36 96,26 120,20 144,16 168,14 192,13 216,12 240,11 264,10 288,9 320,9 320,58 0,58"/>
      <polyline points="0,56 24,52 48,45 72,36 96,26 120,20 144,16 168,14 192,13 216,12 240,11 264,10 288,9 320,9"/></svg>
  </div>
  <div class="sec">
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:5px">
      <span style="font-size:var(--fs-dense);color:var(--txt-2)">Ground speed</span>
      <span class="mono" style="font-size:var(--fs-dense)">449 kn</span></div>
    <svg class="spark mag" viewBox="0 0 320 58" preserveAspectRatio="none">
      <polygon class="fill" points="0,50 24,42 48,33 72,27 96,21 120,19 144,18 168,21 192,18 216,17 240,18 264,16 288,16 320,17 320,58 0,58"/>
      <polyline points="0,50 24,42 48,33 72,27 96,21 120,19 144,18 168,21 192,18 216,17 240,18 264,16 288,16 320,17"/></svg>
  </div>
  <div class="sec">
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:5px">
      <span style="font-size:var(--fs-dense);color:var(--txt-2)">Vertical rate</span>
      <span class="mono" style="font-size:var(--fs-dense)">+4.2 m/s</span></div>
    <svg class="spark" viewBox="0 0 320 58" preserveAspectRatio="none">
      <polyline points="0,14 24,18 48,22 72,20 96,26 120,30 144,29 168,33 192,31 216,34 240,32 264,35 288,33 320,34"/></svg>
    <div style="display:flex;justify-content:space-between;margin-top:7px">
      <span class="mono" style="font-size:var(--fs-cap);color:var(--txt-3)">07:42Z</span>
      <span class="mono" style="font-size:var(--fs-cap);color:var(--txt-3)">08:42Z</span></div>
  </div>
  <div class="sec"><div class="sech"><h3>Coverage</h3></div>
    <div class="state warn" style="padding-bottom:0"><b>47 of 60 minutes recorded</b>
      <p>The archive has gaps where the feed was silent. The chart does not interpolate across them.</p></div>
  </div>
  <p style="font-size:var(--fs-cap);color:var(--txt-3);line-height:1.6;margin-top:var(--sp-4)">
    The panel the reference has and we do not. It turns a position into a behaviour, and shares its implementation with the Foundry series workbench.
  </p>
</div>"""

P['time'] = """
<div class="phead"><h2>Time selection</h2><span class="badge accent">Live</span><span style="flex:1"></span><button class="btn sm quiet">UTC</button></div>
<div class="pbody">
  <dl class="kv" style="margin-bottom:var(--sp-4)">
    <dt>Window</dt><dd>07:42Z to 08:42Z</dd>
    <dt>Current timestamp</dt><dd>08:42:17Z</dd>
    <dt>Time zone</dt><dd>UTC</dd>
    <dt>Playback</dt><dd>live</dd>
  </dl>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn sm on">View latest</button><button class="btn sm">Local time</button>
  </div>

  <div class="sec"><div class="sech"><h3>Speed</h3></div>
    <div style="display:flex;gap:7px;flex-wrap:wrap">
      <span class="chip on">1&times;</span><span class="chip">10&times;</span><span class="chip">60&times;</span>
      <span class="chip">600&times;</span><span class="chip">3600&times;</span>
    </div>
  </div>

  <div class="sec"><div class="sech"><h3>Replay window</h3></div>
    <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:11px">
      <span class="chip">1 h</span><span class="chip on">6 h</span><span class="chip">24 h</span>
      <span class="chip">3 d</span><span class="chip">7 d</span>
    </div>
    <div class="input"><span class="mono">2026-08-01</span><span style="flex:1"></span><span style="font-size:var(--fs-cap);color:var(--txt-3)">UTC day</span></div>
  </div>

  <div class="sec"><div class="sech"><h3>Auto pause at</h3><span class="ct">3</span></div>
    <div class="row"><span class="dot alert"></span><span class="nm">Emergency squawk<span class="sub">N612DA · 08:11Z</span></span></div>
    <div class="row"><span class="dot warn"></span><span class="nm">AIS gap opened<span class="sub">SPARTA IV · 08:26Z</span></span></div>
    <div class="row"><span class="dot warn"></span><span class="nm">Watchbox hit<span class="sub">Gdansk approach · 08:39Z</span></span></div>
    <p style="font-size:var(--fs-cap);color:var(--txt-3);line-height:1.6;margin-top:11px">
      Replay stops itself at the moments that matter, which turns a scrub into a briefing.
    </p>
  </div>

  <div class="sec"><div class="sech"><h3>Archive</h3></div>
    <dl class="kv">
      <dt>Recording since</dt><dd>2026-06-14</dd>
      <dt>On disk</dt><dd>4.1 GB</dd>
      <dt>Fixes</dt><dd>25.7 M</dd>
      <dt>Tracks in window</dt><dd>1,204</dd>
    </dl>
  </div>
</div>"""


def body_of(panel):
    """Inner HTML of a panel's .pbody, so right-side panels can be composed into
    one scrolling column instead of three separate cards."""
    i = panel.index('<div class="pbody">') + len('<div class="pbody">')
    return panel[i:panel.rindex('</div>')]

# Direction A stacks Selection, Series and Time selection in one scrolling
# column: they are all answering questions about the same selected thing.
RIGHT_STACK = (P['selection'][:P['selection'].rindex('</div>')]
    + '<div class="sec"><div class="sech"><h3>Series</h3><span class="ct">last 60 min</span></div></div>'
    + body_of(P['series'])
    + '<div class="sec"><div class="sech"><h3>Time selection</h3><span class="ct">live</span></div></div>'
    + body_of(P['time'])
    + '</div>')

TOOLBAR = """<div class="toolbar" style="%s">
  <div class="tool" title="Pan"><svg><use href="#i-hand"/></svg></div>
  <div class="tool-div"></div>
  <div class="tool%s" title="Select"><svg><use href="#i-select"/></svg></div>
  <div class="tool%s" title="Search around"><svg><use href="#i-around"/></svg></div>
  <div class="tool%s" title="Draw"><svg><use href="#i-draw"/></svg></div>
  <div class="tool" title="Capture"><svg><use href="#i-camera"/></svg></div>
  <div class="tool%s" title="Measure"><svg><use href="#i-ruler"/></svg></div>
  <div class="tool" title="Annotate"><svg><use href="#i-pin"/></svg></div>
  <div class="tool" title="Delete"><svg><use href="#i-trash"/></svg></div>
</div>"""

def toolbar(pos, active=None):
    return TOOLBAR % (pos,
        ' on' if active == 'select' else '', ' on' if active == 'around' else '',
        ' on' if active == 'draw' else '', ' on' if active == 'measure' else '')

CONTACTS = """
  <!-- Positions are over water and inside the map window. Screen percent maps
       back to the basemap through the SVG's slice transform, so a contact drawn
       at 43% / 28% sits in the open Baltic rather than on Poland. -->
  <div class="contact" style="left:43.1%;top:27.8%;color:var(--d-airliner);transform:rotate(64deg)"><i></i></div>
  <div class="contact" style="left:53.4%;top:34.4%;color:var(--d-airliner);transform:rotate(-108deg)"><i></i></div>
  <div class="contact" style="left:63.9%;top:30.0%;color:var(--d-mil);transform:rotate(212deg)"><i></i></div>
  <div class="contact" style="left:37.5%;top:36.7%;color:var(--d-heli);transform:rotate(18deg)"><i></i></div>
  <div class="contact" style="left:69.4%;top:22.2%;color:var(--d-private);transform:rotate(-42deg)"><i></i></div>
  <div class="contact" style="left:30.6%;top:27.8%;color:var(--d-glider);transform:rotate(96deg)"><i></i></div>
  <div class="contact sq" style="left:47.2%;top:46.7%;color:var(--d-cargo)"><i></i></div>
  <div class="contact sq" style="left:56.9%;top:48.9%;color:var(--d-tanker)"><i></i></div>
  <div class="contact sq" style="left:59.7%;top:52.2%;color:var(--d-fishing)"><i></i></div>
  <div class="contact sq" style="left:51.0%;top:41.0%;color:var(--d-passenger)"><i></i></div>
  <div class="contact" style="left:73.8%;top:36.7%;color:var(--d-emergency);transform:rotate(140deg)"><i></i></div>
  <div class="track" style="left:52.4%;top:44.0%;width:118px;transform:rotate(-24deg)"></div>
  <div class="contact sel" style="left:59.4%;top:37.0%;color:var(--d-select);transform:rotate(24deg)"><i></i></div>"""

TIMEDOCK = """<div class="timedock" style="%s">
  <div class="tbar">
    <button class="btn sm quiet" aria-label="Pause playback"><svg width="14" height="14" aria-hidden="true"><use href="#i-pause"/></svg></button>
    <span class="mono" style="font-size:var(--fs-cap);color:var(--txt-2)">07:42Z</span>
    <div class="scrub"><i style="left:73%%"></i></div>
    <span class="mono" style="font-size:var(--fs-cap);color:var(--txt-2)">08:42Z</span>
    <span class="chip on" style="padding:4px 11px">Live</span>
    <button class="btn sm quiet">6 h <svg width="12" height="12"><use href="#i-chev"/></svg></button>
    <button class="btn sm quiet" aria-label="Collapse the time dock"><svg width="14" height="14" aria-hidden="true"><use href="#i-up"/></svg></button>
  </div>%s
</div>"""

TIMEDOCK_EXP = """
  <div class="exp">
    <div class="lanes">
      <div class="lane"><span class="lb">Alerts</span><span class="lt"><b style="left:31%;background:var(--alert)"></b><b style="left:64%;background:var(--alert)"></b></span></div>
      <div class="lane"><span class="lb">Detections</span><span class="lt"><b style="left:12%;background:var(--warn)"></b><b style="left:40%;background:var(--warn)"></b><b style="left:52%;background:var(--warn)"></b><b style="left:78%;background:var(--warn)"></b></span></div>
      <div class="lane"><span class="lb">AIS gaps</span><span class="lt"><b style="left:22%;background:var(--mag)"></b><b style="left:69%;background:var(--mag)"></b></span></div>
    </div>
    <div class="density">
      <b style="height:22%"></b><b style="height:31%"></b><b style="height:26%"></b><b style="height:44%"></b>
      <b style="height:38%" class="w"></b><b style="height:52%"></b><b style="height:47%"></b><b style="height:61%"></b>
      <b style="height:55%"></b><b style="height:72%" class="a"></b><b style="height:64%"></b><b style="height:58%"></b>
      <b style="height:49%"></b><b style="height:66%"></b><b style="height:71%"></b><b style="height:59%" class="w"></b>
      <b style="height:63%"></b><b style="height:77%"></b><b style="height:82%" class="a"></b><b style="height:69%"></b>
      <b style="height:74%"></b><b style="height:61%"></b><b style="height:57%"></b><b style="height:66%"></b>
    </div>
  </div>"""

def page(title, body, extra_css=''):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{title}</title>
<link rel="stylesheet" href="mock.css" />
{extra_css}</head>
<body>

{ICONS}

{body}
</body>
</html>
"""

TOPNAV = """<nav class="topnav">
  <a href="00-index.html">Board</a>
  <a href="a-panel-parity.html">A · Panel parity</a>
  <a href="b-verb-first.html">B · Verb first</a>
  <a href="c-palette-first.html">C · Palette first</a>
  <a href="panels.html"%s>Panels</a>
  <a href="foundry.html">Foundry</a>
  <a href="components.html">Components</a>
  <a href="rehoming.html">Re-homing</a>
  <a href="states.html">States and keyboard</a>
</nav>"""

def note(d, sub):
    return (f'<div class="mocknote"><b>{d}</b><span>{sub}</span>'
            f'<a href="00-index.html">Back to the board</a></div>')

# ── Direction A ─────────────────────────────────────────────────────────────
# The chosen shape: A's four named panels are fixed and always visible, and the
# tab row also carries whatever the operator pins. That is C's idea, and it drops
# into A without changing A's model: the four names never move, pins are extra.
a_tabs = """<nav class="ptabs">
        <a href="#" class="on">Layers<span class="key">1</span></a>
        <a href="panels.html#find">Find<span class="key">2</span></a>
        <a href="panels.html#histogram">Histogram<span class="key">3</span></a>
        <a href="panels.html#info">Info<span class="key">4</span></a>
        <a href="panels.html#series" title="Pinned by you">Series<span class="key">5</span></a>
        <a href="#" title="Pin another panel" style="color:var(--txt-4)">+</a>
      </nav>"""

A = page('Velocity redesign · Direction A · Panel parity', f"""<div class="shell">
  <div class="globe">
    {GLOBE}
    {CONTACTS}
    <div class="osd" style="left:356px;top:96px">54.3181 N &nbsp;018.7122 E &nbsp;·&nbsp; MGRS 33UXP 0421 5518</div>
    <div class="osd" style="right:436px;top:96px">Carto dark &nbsp;·&nbsp; OSM &nbsp;·&nbsp; CARTO</div>
    {toolbar('left:356px;top:58px', 'select')}
    {TIMEDOCK % ('left:344px;right:425px;bottom:22px', TIMEDOCK_EXP)}
    <div class="statusbar"><b>Online</b><span class="sep"></span><span>Baltic approaches</span><span class="sep"></span><span>18 layers · 13,204 contacts</span><span class="sep"></span><span>1 s refresh</span><span style="flex:1"></span><span>Carto dark · OSM · CARTO</span></div>
  </div>

  <header class="topbar">
    <div class="brand"><i></i><b>Velocity</b></div>
    <div class="input focus" style="flex:0 0 320px">
      <svg width="16" height="16" style="opacity:.6"><use href="#i-search"/></svg>
      <span>Find anything</span><span style="flex:1"></span><kbd>&#8984;K</kbd></div>
    <button class="btn quiet"><svg width="15" height="15"><use href="#i-grid"/></svg> Apps <svg width="12" height="12"><use href="#i-chev"/></svg></button>
    <button class="btn quiet">Baltic approaches <svg width="12" height="12"><use href="#i-chev"/></svg></button>
    <div class="spacer"></div>
    <button class="btn quiet" style="color:var(--alert-fg)"><svg width="15" height="15"><use href="#i-bell"/></svg> 2</button>
    <span class="stat"><b>13,204</b><span>contacts</span></span>
    <span class="stat"><b>58</b><span>fps</span></span>
    <span class="mono" style="font-size:var(--fs-dense);color:var(--txt-2)">08:42:17Z</span>
    <span class="cls"><i></i> Unclassified</span>
  </header>

  <aside class="dock left">{a_tabs}{P['layers']}</aside>
  <aside class="dock right">{RIGHT_STACK}</aside>
</div>

{note('Direction A · Panel parity', 'Named panels, apps in a launcher, time as a dock')}""")

# ── Direction B ─────────────────────────────────────────────────────────────
b_css = """<style>
  .dock.verbs { left: 0; top: 46px; bottom: 22px; width: 150px; border-right: 1px solid var(--line-2); padding: 10px; gap: 3px; }
  .dock.verbs a { text-decoration: none; display: block; padding: 10px 12px; border-radius: var(--r-md); color: var(--txt-1); }
  .dock.verbs a:hover { background: var(--glass-2); }
  .dock.verbs a.on { background: var(--accent); box-shadow: var(--accent-glow); }
  .dock.verbs a b { display: block; font-size: var(--fs-body); font-weight: 500; }
  .dock.verbs a u { display: block; text-decoration: none; font-size: var(--fs-cap); color: var(--txt-3); margin-top: 3px; line-height: 1.45; }
  .dock.verbs a.on b { color: #fff; } .dock.verbs a.on u { color: rgba(255,255,255,.82); }
  .dock.verbs .bdg { float: right; font-family: var(--font-mono); font-size: var(--fs-cap); background: var(--alert); color: #fff; border-radius: 10px; padding: 0 7px; }
</style>
"""

b_tabs = """<nav class="ptabs">
        <a href="panels.html#find">Find</a>
        <a href="#" class="on">Histogram</a>
        <a href="#">Explorer</a>
        <a href="#">Saved</a>
      </nav>"""

B = page('Velocity redesign · Direction B · Verb first', f"""<div class="shell">
  <div class="globe">
    {GLOBE}
    <div class="contact" style="left:44%;top:34%;color:var(--d-mil);transform:rotate(28deg)"><i></i></div>
    <div class="contact" style="left:50%;top:27%;color:var(--d-mil);transform:rotate(-64deg)"><i></i></div>
    <div class="contact" style="left:56%;top:41%;color:var(--d-mil);transform:rotate(112deg)"><i></i></div>
    <div class="contact" style="left:40%;top:49%;color:var(--d-airliner);opacity:.16;transform:rotate(9deg)"><i></i></div>
    <div class="contact" style="left:61%;top:32%;color:var(--d-private);opacity:.16;transform:rotate(-30deg)"><i></i></div>
    <div class="contact sq" style="left:46%;top:56%;color:var(--d-cargo);opacity:.16"><i></i></div>
    <div class="contact sq" style="left:53%;top:60%;color:var(--d-tanker);opacity:.16"><i></i></div>
    <div class="contact" style="left:65%;top:46%;color:var(--d-emergency);transform:rotate(70deg)"><i></i></div>
    <div class="osd" style="left:514px;top:96px">54.3181 N &nbsp;018.7122 E</div>
    {toolbar('left:514px;top:58px', 'draw')}
    {TIMEDOCK % ('left:502px;right:425px;bottom:22px', '')}
    <div class="statusbar"><b>Online</b><span class="sep"></span><span>Baltic approaches</span><span class="sep"></span><span>18 layers · 13,204 contacts</span><span class="sep"></span><span>1 s refresh</span><span style="flex:1"></span><span>Carto dark · OSM · CARTO</span></div>
  </div>

  <header class="topbar">
    <div class="brand"><i></i><b>Velocity</b></div>
    <div class="input focus" style="flex:0 0 320px">
      <svg width="16" height="16" style="opacity:.6"><use href="#i-search"/></svg>
      <span>Find anything</span><span style="flex:1"></span><kbd>&#8984;K</kbd></div>
    <button class="btn quiet">Baltic approaches <svg width="12" height="12"><use href="#i-chev"/></svg></button>
    <div class="spacer"></div>
    <button class="btn quiet" style="color:var(--alert-fg)"><svg width="15" height="15"><use href="#i-bell"/></svg> 2</button>
    <span class="stat"><b>13,204</b><span>contacts</span></span>
    <span class="mono" style="font-size:var(--fs-dense);color:var(--txt-2)">08:42:17Z</span>
    <span class="cls"><i></i> Unclassified</span>
  </header>

  <nav class="dock verbs">
    <a href="panels.html#layers"><b>Watch</b><u>Layers · Info · Alerts</u></a>
    <a href="#" class="on"><b>Find</b><u>Find · Histogram · Explorer</u></a>
    <a href="panels.html#selection"><b>Understand</b><u>Selection · Series · Graph</u></a>
    <a href="#"><b>Decide</b><u>Targeting · Tasking · Reports</u></a>
    <a href="foundry.html"><b>Build</b><u>Foundry · Workflows</u></a>
    <div style="flex:1"></div>
    <a href="#"><b>Inbox<span class="bdg">7</span></b><u>Queue · Alerts</u></a>
    <a href="#"><b>Set up</b><u>Keys · Local AI</u></a>
  </nav>

  <aside class="dock left" style="left:150px;width:352px">{b_tabs}{P['histogram']}</aside>

  <aside class="dock right">
    <div class="phead"><h2>14 selected</h2><span class="badge mag">Box</span><span style="flex:1"></span><button class="btn sm quiet">Details</button></div>
    <div class="pbody">
      <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:var(--sp-3)">
        <span class="badge warn">9 military</span><span class="badge alert">1 emergency</span><span class="badge">4 airliner</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm">Invert</button><button class="btn sm">Select all in view</button>
        <button class="btn sm">Add to board</button><button class="btn sm">Export CSV</button></div>
      <div class="sec"><div class="sech"><h3>Contacts</h3><span class="ct">14</span></div>
        <div class="row on"><span class="dot" style="background:var(--d-emergency)"></span><span class="nm">N612DA<span class="sub">Squawk 7700</span></span><span class="ct">FL270</span></div>
        <div class="row"><span class="dot" style="background:var(--d-mil)"></span><span class="nm">RCH471<span class="sub">C-17A</span></span><span class="ct">FL310</span></div>
        <div class="row"><span class="dot" style="background:var(--d-mil)"></span><span class="nm">REACH902<span class="sub">KC-135R</span></span><span class="ct">FL290</span></div>
        <div class="row"><span class="dot" style="background:var(--d-mil)"></span><span class="nm">DUKE21</span><span class="ct">FL240</span></div>
        <div class="row"><span class="dot" style="background:var(--d-mil)"></span><span class="nm">NAVY6C</span><span class="ct">FL180</span></div>
        <div class="row"><span class="dot" style="background:var(--d-airliner)"></span><span class="nm">RYR4213</span><span class="ct">FL320</span></div>
        <div class="row"><span class="dot" style="background:var(--d-airliner)"></span><span class="nm">DLH88W</span><span class="ct">FL340</span></div>
      </div>
      <div class="sec"><div class="sech"><h3>Series</h3><span class="ct">selection, 60 min</span></div>
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:5px">
          <span style="font-size:var(--fs-dense);color:var(--txt-2)">Contacts in selection</span>
          <span class="mono" style="font-size:var(--fs-dense)">14</span></div>
        <svg class="spark" viewBox="0 0 320 58" preserveAspectRatio="none">
          <polygon class="fill" points="0,46 27,44 54,40 81,35 108,36 135,29 162,25 189,26 216,21 243,17 270,14 297,13 320,11 320,58 0,58"/>
          <polyline points="0,46 27,44 54,40 81,35 108,36 135,29 162,25 189,26 216,21 243,17 270,14 297,13 320,11"/></svg>
      </div>
      <div class="sec"><div class="sech"><h3>Time selection</h3></div>
        <dl class="kv" style="margin-bottom:12px">
          <dt>Window</dt><dd>07:42Z to 08:42Z</dd>
          <dt>Current</dt><dd>08:42:17Z</dd>
          <dt>Time zone</dt><dd>UTC</dd></dl>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm on">View latest</button><button class="btn sm">Auto pause · 3</button></div>
      </div>
    </div>
  </aside>
</div>

{note('Direction B · Verb first', 'The rail is the analyst loop; apps live inside verbs')}""", b_css)

# ── Direction C ─────────────────────────────────────────────────────────────
c_css = """<style>
  .float { position: absolute; z-index: var(--z-dock); background: var(--glass); backdrop-filter: var(--blur);
           border-radius: var(--r-lg); box-shadow: var(--sh-2); display: flex; flex-direction: column;
           overflow: hidden; max-height: calc(100% - 110px); }
  .float > .fh { display: flex; align-items: center; gap: 11px; height: 42px; padding: 0 12px 0 18px; cursor: move; }
  .float > .fh h2 { font-size: var(--fs-body); font-weight: 600; }
  .float .pbody { padding: 0 18px 18px; }
  .pinstrip { position: absolute; left: 12px; bottom: 12px; z-index: var(--z-dock); display: flex; gap: 3px; padding: 6px;
              background: var(--glass); backdrop-filter: var(--blur); border-radius: var(--r-lg); box-shadow: var(--sh-2); }
  .pinstrip .p { padding: 7px 13px; border-radius: var(--r-md); font-size: var(--fs-cap); color: var(--txt-3); cursor: pointer; }
  .pinstrip .p:hover { background: var(--glass-2); color: var(--txt-0); }
  .pinstrip .p.on { color: var(--txt-0); background: var(--glass-2); }
</style>
"""

C = page('Velocity redesign · Direction C · Palette first', f"""<div class="shell">
  <div class="globe">
    {GLOBE}
    {CONTACTS}
    <div class="osd" style="left:12px;bottom:74px">54.3181 N &nbsp;018.7122 E &nbsp;·&nbsp; MGRS 33UXP 0421 5518</div>
    {toolbar('left:12px;top:58px', 'measure')}

    <div class="float" style="left:12px;top:76px;width:340px">
      <div class="fh"><h2>Find</h2><span style="flex:1"></span><span class="badge accent">pinned</span>
        <svg width="15" height="15" style="color:var(--txt-3);cursor:pointer"><use href="#i-x"/></svg></div>
      {P['find'].replace('<div class="phead">', '<div class="phead" style="display:none">')}
    </div>

    <div class="float" style="right:84px;top:76px;width:360px">
      <div class="fh"><h2>Selection</h2><span style="flex:1"></span><span class="badge accent">pinned</span>
        <svg width="15" height="15" style="color:var(--txt-3);cursor:pointer"><use href="#i-x"/></svg></div>
      {P['selection'].replace('<div class="phead">', '<div class="phead" style="display:none">')}
    </div>

    <div class="pinstrip">
      <span class="p on">Find</span><span class="p on">Selection</span><span class="p">Layers</span>
      <span class="p">Histogram</span><span class="p">Series</span><span class="p">Time selection</span>
      <span class="p">Info</span><span class="p" style="color:var(--txt-4)">+ pin</span>
    </div>

    <div class="scrim">
      <div class="palette">
        <div class="pq"><svg width="21" height="21" style="color:var(--txt-3)"><use href="#i-search"/></svg>
          <span class="fake">mil<span class="cur">&nbsp;</span></span><span class="badge">32 results</span></div>
        <div class="plist">
          <div class="pgroup">Apps · 3 of 14</div>
          <div class="pitem on"><svg><use href="#i-target"/></svg><span class="pi-n">Targeting</span><span class="pi-h">kill-chain board</span><kbd>&crarr;</kbd></div>
          <div class="pitem"><svg><use href="#i-graph"/></svg><span class="pi-n">Graph</span><span class="pi-h">link analysis</span></div>
          <div class="pitem"><svg><use href="#i-db"/></svg><span class="pi-n">Foundry</span><span class="pi-h">datasets, pipelines, ontology</span></div>
          <div class="pgroup">Layers · 4 of 64</div>
          <div class="pitem"><svg><use href="#i-layers"/></svg><span class="pi-n">Aircraft · Military (airplanes.live)</span><span class="pi-h">on · 284</span></div>
          <div class="pitem"><svg><use href="#i-layers"/></svg><span class="pi-n">Military bases</span><span class="pi-h">off</span></div>
          <div class="pitem"><svg><use href="#i-layers"/></svg><span class="pi-n">Military installations (MIRTA)</span><span class="pi-h">off</span></div>
          <div class="pgroup">Panels</div>
          <div class="pitem"><svg><use href="#i-hist"/></svg><span class="pi-n">Histogram · filter by aircraft category</span><span class="pi-h">military</span></div>
          <div class="pgroup">Contacts · 18 live</div>
          <div class="pitem"><svg><use href="#i-plane"/></svg><span class="pi-n">RCH471</span><span class="pi-h">C-17A · FL310 · 4 min ago</span></div>
          <div class="pgroup">Settings</div>
          <div class="pitem"><svg><use href="#i-gear"/></svg><span class="pi-n">Military callsign matching</span><span class="pi-h">Set up · Classification</span></div>
          <div class="pgroup">Saved</div>
          <div class="pitem"><svg><use href="#i-bell"/></svg><span class="pi-n">Military over the Baltic</span><span class="pi-h">saved search · 7 new</span></div>
        </div>
        <div class="pfoot"><span><kbd>&uarr;</kbd> <kbd>&darr;</kbd> move</span><span><kbd>&crarr;</kbd> open</span>
          <span><kbd>&#8679;&crarr;</kbd> open beside</span><span><kbd>&#8984;&crarr;</kbd> pin</span>
          <span><kbd>esc</kbd> close</span><span style="flex:1"></span><span><kbd>?</kbd> all shortcuts</span></div>
      </div>
    </div>
    <div class="statusbar"><b>Online</b><span class="sep"></span><span>Baltic approaches</span><span class="sep"></span><span>18 layers · 13,204 contacts</span><span class="sep"></span><span>1 s refresh</span><span style="flex:1"></span><span>Carto dark · OSM · CARTO</span></div>
  </div>

  <header class="topbar">
    <div class="brand"><i></i><b>Velocity</b></div>
    <button class="btn accent"><svg width="15" height="15"><use href="#i-search"/></svg> Find anything
      <kbd style="background:rgba(255,255,255,.22);color:#fff;margin-left:5px">&#8984;K</kbd></button>
    <span style="font-size:var(--fs-cap);color:var(--txt-3)">One index · 14 apps · 64 layers · 18 panels · 7 tools · every setting</span>
    <div class="spacer"></div>
    <button class="btn quiet" style="color:var(--alert-fg)"><svg width="15" height="15"><use href="#i-bell"/></svg> 2</button>
    <span class="stat"><b>13,204</b><span>contacts</span></span>
    <span class="mono" style="font-size:var(--fs-dense);color:var(--txt-2)">08:42:17Z</span>
    <span class="cls"><i></i> Unclassified</span>
  </header>
</div>

{note('Direction C · Palette first', 'Minimal chrome, everything summoned, one index')}""", c_css)

# ── The panel gallery ───────────────────────────────────────────────────────
gal_css = """<style>
  .gal { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: var(--sp-5); align-items: start; }
  .gcard { border-radius: var(--r-lg); background: var(--glass); box-shadow: var(--sh-2); overflow: hidden; display: flex; flex-direction: column; height: 720px; }
  .gcard > .gcap { padding: 12px 18px; font-size: var(--fs-cap); color: var(--txt-3); border-bottom: 1px solid var(--line); flex: 0 0 auto; }
  .gcard > .gcap b { color: var(--accent-fg); font-weight: 600; }
</style>
"""

def gcard(anchor, cap, panel):
    return (f'<div class="gcard" id="{anchor}"><div class="gcap">{cap}</div>'
            f'<div style="flex:1;min-height:0;display:flex;flex-direction:column">{panel}</div></div>')

PANELS = page('Velocity redesign · All seven panels', f"""{TOPNAV % ' class="on"'}

<div class="doc" style="max-width:1500px">
<h1>All seven panels, at fidelity</h1>
<p class="lead">
  The Palantir map grammar in full: four left panels and three right panels, each
  built out rather than sketched. This is the same markup the direction pages use, so
  a panel cannot be convincing here and thin there. Scroll each card.
</p>
<div class="note">
  Left panels are peers and only one is open at a time, so the map is never covered by
  more than one. Right panels stack in a single scrolling column, because Selection,
  Series and Time selection are all answering questions about the same thing.
</div>

<h2>Left · what exists</h2>
<div class="gal">
  {gcard('layers', '<b>Layers</b> · add, manage and style object and overlay layers', P['layers'])}
  {gcard('find', '<b>Find</b> · find objects and locations, and navigate to coordinates', P['find'])}
  {gcard('histogram', '<b>Histogram</b> · analyse and filter by property and time series values', P['histogram'])}
  {gcard('info', '<b>Info</b> · an overall summary of the map', P['info'])}
</div>

<h2>Right · what is selected</h2>
<div class="gal">
  {gcard('selection', '<b>Selection</b> · analyse details about and act on the selected items', P['selection'])}
  {gcard('time', '<b>Time selection</b> · set the range and current timestamp', P['time'])}
  {gcard('series', '<b>Series</b> · temporal analysis of time series and event data', P['series'])}
</div>

<h2>What each panel answers</h2>
<table class="t">
  <thead><tr><th>Panel</th><th>Palantir's own description</th><th>The question it answers</th><th>Built from</th></tr></thead>
  <tbody>
    <tr><td>Layers</td><td>"Add, manage, and style object and overlay layers; set the base layer"</td><td>What is on the map, and is it healthy</td><td><code>LayerCatalog</code> + <code>LayerRail</code> merged, plus <code>setTimeWindow</code> and a loading method</td></tr>
    <tr><td>Find</td><td>"Find objects and locations; navigate to specific geospatial coordinates"</td><td>Where is the thing I am thinking of</td><td><code>SearchObjectsSidebar</code> + <code>CoordEntry</code> + chokepoints + extract, behind one sniffing input</td></tr>
    <tr><td>Histogram</td><td>"Analyze and filter objects based on property and time series values"</td><td>What is the shape of what I am looking at</td><td><code>explorer/facets.ts:322</code> already returns exactly these five</td></tr>
    <tr><td>Info</td><td>"Display an overall summary of the map"</td><td>What am I looking at, and why is it slow or low</td><td><code>FeedsPanel</code> + <code>OpsPanel</code> + <code>SysStats</code> + <code>MapHealthStrip</code></td></tr>
    <tr><td>Selection</td><td>"Analyze details about and take actions on the selected items"</td><td>What is this contact</td><td><code>EntityPanel</code>, 27 blocks, re-framed not rewritten</td></tr>
    <tr><td>Time selection</td><td>"Set the time range and current timestamp to apply to the map and time series views"</td><td>When am I looking at</td><td><code>Timeline</code> controls, including the auto-pause idea the reference singles out</td></tr>
    <tr><td>Series</td><td>"Enables temporal analysis of time series and event data"</td><td>What has this contact been doing</td><td><b>New.</b> Reads <code>/api/history/tracks</code>; shares its implementation with the Foundry series workbench</td></tr>
  </tbody>
</table>
</div>""", gal_css)

for name, html in [('a-panel-parity', A), ('b-verb-first', B), ('c-palette-first', C), ('panels', PANELS)]:
    HERE.joinpath(name + '.html').write_text(upgrade(html))
    print('wrote', name + '.html')
