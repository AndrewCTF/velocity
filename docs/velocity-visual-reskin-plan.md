# Velocity visual reskin — design plan

Goal: take the reskin from *additive dark-theme* to a coherent, unmistakable
visual identity for a live intelligence COP. Grounds: the real Palantir-Gotham
grammar I analyzed (classification-first, instrument density, map-as-canvas /
chrome-floats, MIL-STD symbology, semantic-only color) + Velocity's existing
token + instrument system. Written against the actual files.

## 1. Direction (the thesis)

**Velocity is a live sensor feed of the planet, and the UI should read as the
instrument glass over that feed — not a dashboard that happens to contain a
map.** The globe is the hero and the canvas; every piece of chrome is a precise,
quiet instrument module docked to a sensor frame. The product's whole reason to
exist — *fused, classified, trustworthy observation* — becomes the visual
identity, not a coat of paint.

The current build inverts this: the chrome is a generic dark dashboard and the
globe is "the content area." We flip it.

## 2. Signature — the sensor frame

The one memorable element, the place we spend all the boldness:

**The viewport is framed as a classified sensor display.** Everything else stays
disciplined and quiet around it.

- **Classification frame** — a hairline top + bottom strip spanning the full
  width carrying the live handling caveat (`UNCLAS // OSINT // NOFORN-N/A`), the
  data-posture (keyless vs commercial), and the session/build id. Real
  classified systems are *banner-framed*; for an OSINT tool the honest banner is
  `UNCLAS // OPEN-SOURCE`. This is the domain's actual visual grammar, not decoration.
- **Corner reticle ticks** at the four viewport corners (scope/viewfinder marks).
- **Edge instrument readouts** — current camera center (lat/lon), bearing, scale,
  and UTC rendered small and mono at the frame edges, like a sensor OSD.
- **Selection = reticle lock** — on entity select, the corner ticks converge to a
  bracket around the contact (replaces today's bare magenta polyline pickup; the
  guardrailed polyline stays, the bracket is added chrome).
- **Ambient life** — one slow sweep line traversing the frame (~20s), off under
  `prefers-reduced-motion`. Says "live feed," not "animated app."

Why this and not a trendy accent: the boldness goes into a structural device
that is *true to the subject* (a fused-sensor COP is literally framed glass),
which no generic dark dashboard has — instead of spending it on a color the way
every AI design does.

## 3. Token system

### Color — substrate colder, semantics kept, color = meaning only
Velocity's semantic palette is already correct and partly guardrailed; we tighten
the substrate temperature and stop using color decoratively.

| Token | Hex | Role |
|---|---|---|
| `ink-0` | `#090C12` | substrate (colder, deeper than today's `#080a0f`) |
| `ink-1` | `#10151D` | rail / frame base |
| `ink-2` | `#18202B` | raised panel / card |
| `ink-3` | `#222C3A` | input / hover |
| `line` | `rgba(138,166,200,0.10)` | hairline divider |
| `line-2` | `rgba(138,166,200,0.18)` | structural divider |
| `txt-0..3` | `#EAF0F7 · #B7C2D0 · #7E8B9C · #515D6E` | text ramp (cool greys) |
| `signal` | `#4FA0D8` | interactive / active / focus (steel-blue, institutional — NOT a trendy acid accent) |
| `threat` `warn` `nominal` `select` | `#FF5A52 · #F5A524 · #36D399 · #E25BEF` | **kept** — semantic only; `select` matches the globe polyline |

Rule encoded in the system: **color appears only to mean threat / warn /
nominal / selection / interactive.** Everything structural is ink + hairline +
type. (Audit + delete every decorative color use.)

### Type — drop Inter; condensed instrument labels are the typographic signature
| Role | Face | Use |
|---|---|---|
| **Structural / labels / caveats** | **Saira Condensed** (new) | section eyebrows, classification, instrument labels — uppercase, tracked `+0.6–1.2`. The MIL-spec "labeled panel" voice. |
| **Human body** | **IBM Plex Sans** (replaces Inter) | descriptions, news, prose — pairs natively with Plex Mono, institutional, kills the every-dashboard-is-Inter tell. |
| **Machine data** | **IBM Plex Mono** (kept) | IDs, coords, counts, timestamps, tables — already loaded. |

Scale (instrument-dense): `9 / 10 / 11 / 13 / 18px`. Tight leading. Tabular-nums
on all data. Condensed caps for every label; mono for every number; sans only
where a human reads sentences.

### Space, radius, motion
- **Density grid**: 4px base; panel padding `8/10px`, row rhythm `6px`. Tighter
  than today — instruments are packed.
- **Radius**: `2px` everywhere (down from 3–8). Hard-cornered = instrument-grade.
- **Motion**: power-on for panel mount (120ms, mechanical ease), reticle-lock on
  select, the ambient sweep. Nothing bouncy. Reduced-motion fully honored.

## 4. Critique vs the AI defaults (required self-check)

- **Near-black + single acid accent** (default): avoided — substrate is cold ink
  but the accent stays a *disciplined institutional blue* and the semantic palette
  is unchanged; boldness is the sensor frame, not a neon color.
- **Broadsheet hairlines** (default): hairlines exist because instruments use
  them, but the layout is floating-glass-over-live-map, not newspaper columns.
- **Warm cream + serif** (default): opposite of the brief.

The signature (sensor-frame + condensed MIL labels + map-as-hero/chrome-defers)
is specific to *live classified observation* and wouldn't appear on a generic
build. Passes.

## 5. Information architecture — the structural fix (not a band-aid)

The 7-peer-tab rail is the real failure I shipped (I crammed it by shrinking
padding). Fix it at the IA level: **separate persistent context from analytical
modes.**

```
 TODAY (broken)                      PROPOSED
 ┌──────────── command bar ───────┐  ┌═ UNCLAS // OPEN-SOURCE · keyless ═════┐  ← caveat frame
 │ Sel Alt Int New Task Life FMV  │  │ ┌cmd bar: search · AOI · MODES ▸ ─────┐│
 │  ↑ 7 peers, overflow, crammed  │  │ │ ◑3D ◯SIM │ ⌖TASKING ⌖TARGETS ⌖FMV  ││  ← modes, not tabs
 ├────┬──────────────────┬────────┤  │ ├────┬────────────────────┬──────────┤│
 │ OB │      globe       │ ctx    │  │ │ OB │       globe        │ context  ││
 │tree│                  │4tabs+3 │  │ │tree│   (hero canvas)    │ Sel·Alt· ││  ← right rail = 4 context tabs only
 │    │                  │crammed │  │ │    │  ⌖ reticle lock    │ Int·News ││
 └────┴──────────────────┴────────┘  │ └────┴────────────────────┴──────────┘│
                                      │ ▸ TARGETING board (full-width dock) ◂ ││  ← Kanban gets real width
                                      └═ center 31.4N 030.0E · brg 000 · z6 ═══┘  ← edge readouts + bottom caveat
```

- **Right rail** = context only: **Selection · Alerts · Intel · News** (the 4
  that answer "what's happening / what's selected"). Fits comfortably, no overflow.
- **Tasking / Targeting / FMV** become **MODES** invoked from the command bar
  (like the existing 3D/SIM toggles), each taking an appropriate surface:
  - **Targeting (Kanban)** → a **full-width bottom dock** (or full-screen
    workspace). This is the fix for the cramped 7-column board — it gets the room
    Gotham's board has, with real cards (intel attachments, weaponeering, approval
    chain), not icon+label+pips in a 360px slit.
  - **Tasking** → right-rail takeover or a center-left instrument overlay (it's a
    planning surface, not a context panel).
  - **FMV** → a center sensor-window overlay framed by the reticle (it IS a
    sensor view — it should live in the frame, not a side tab).
- **Left rail** = the **order-of-battle tree** (today's layer folders) — keep,
  restyle to the instrument language; it's already the most Gotham-correct part.

This kills the overflow at the root and gives each pillar the surface its
content demands.

## 6. Component language

Restyle the existing `shell/instruments.tsx` primitives to the new tokens + add
the frame primitives. One language, applied everywhere.

- **`Caveat`** → promoted from a pill to the **frame banner** primitive (top/bottom
  strips + per-card footer variant).
- **`Widget` / `SectionLabel`** → condensed-caps Saira labels, 2px radius, tighter
  padding, hairline-only separation.
- **`KV` / `KVRow`** → the core instrument readout: condensed label · mono value ·
  tabular-nums, right-aligned numerics.
- **New `Reticle`** (corner ticks + lock bracket), **`OsdReadout`** (edge
  coordinate/bearing/scale), **`FrameSweep`** (ambient).
- **`Badge` / `StatusDot`** → semantic-only tones, unchanged behavior.
- Tables/lists (flyovers, alerts, targets) → a single dense `DataRow` with
  hairline rhythm + hover `signal` underline.

## 7. What stays untouched (guardrails)

Hard-locked by CLAUDE.md — the reskin does **not** touch them:
- `styles.ts` aircraft/vessel category SVGs + their colors (airliner `#facc15`
  etc) — data symbology is sacred.
- `labelStyle.ts` label font/colors.
- Selection polyline `#d946ef` (the reticle bracket is *added* chrome around it).
- Aircraft teleport / no-motion-synthesis, `requestRenderMode`, the hot-blob path.

The reskin is **chrome only** — frame, panels, type, tokens. Never the data layer.

## 8. Phasing

| Phase | Scope | Risk | Ship value |
|---|---|---|---|
| **V1 — visual language** | tokens.css + tailwind (palette/space/radius), fonts (Saira + Plex Sans), restyle `instruments.tsx` primitives, the caveat **frame** + OSD readouts + corner reticle | low (chrome only, guardrail-bounded) | immediate "this is a different product" — applied to every existing panel at once |
| **V2 — IA restructure** | right rail → 4 context tabs; Tasking/Targeting/FMV → command-bar modes; **Targeting → full-width dock**; FMV → framed center window | medium (layout, panel mounts) | fixes the cramped Kanban + 7-tab overflow at the root |
| **V3 — motion + selection** | reticle-lock on select, frame sweep, panel power-on | low | the "live sensor" feel that sells it |

Recommend V1 first (biggest perceived change for least risk; everything inherits
it), then V2 (the structural payoff), then V3 (polish).

## 9. The one risk + fallback

**Risk:** the persistent classification *frame* (top/bottom banners + edge OSD +
corner reticle) eats ~24–32px of vertical room and could feel like cosplay if
over-styled. **Mitigation:** hairline-thin, mono-small, information-bearing
(real caveat + real coordinates, not flavor text); collapsible to a single 16px
top strip. **Fallback** if it doesn't earn its space in a mockup: keep the
caveat as the top strip only + the corner reticle, drop the bottom banner and
edge OSD. The token + type + density work (V1) stands regardless.

## 10. Open decisions (operator)

1. **Scope** — V1 visual-language only (true "reskin"), or V1+V2 (visual + the IA
   restructure that fixes the cramped Kanban)? Recommend V1+V2; the Kanban won't
   stop being cramped without V2.
2. **Boldness of the frame** — full sensor frame (banners + OSD + reticle) vs the
   minimal version (top caveat + corner ticks). Recommend building the full one in
   a mockup, then cutting per §9.
3. **Font budget** — Saira Condensed adds one web font on a Cesium-heavy app.
   Worth it for the signature; alternative is using Plex Sans condensed-tracked
   for labels (no new font, weaker signature).
