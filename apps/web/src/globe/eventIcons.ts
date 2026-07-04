// Event / incident symbology — inline SVG glyphs baked as data URIs, mirroring
// icons.ts. These replace the old "translucent red disc + text" rendering of
// conflict / GDELT / ACLED / IODA / fused-incident points: an analyst wants to
// read WHAT happened (a bombing, a clash, a drone strike, a jamming site) from
// the glyph, not decode a colored circle. Orientation-agnostic (events carry no
// heading) so, unlike aircraft, these are never rotated. currentColor-style
// fill + dark outline halo so they stay legible on a dark satellite basemap.

function dataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const OUT = '#05070b'; // near-black outline halo (matches label pill background)
const GLYPH_FG = '#ffffff'; // white foreground drawn on the colored tile

// FR24-style solid tile backing for the HIGH-INTENSITY conflict glyphs (blast,
// airstrike, artillery, clash, gunfire, drone, naval). A filled rounded square in
// the EVENT COLOR with a dark outline halo, so the symbol reads as a bold marker
// at distance instead of thin strokes lost on the basemap; the glyph is drawn in
// white on top (AreaAdapter never tints billboard.color, so white stays white).
// `glyph` markup is authored in the original 0..24 space — the group insets it
// into the tile's safe area (≈4.2..19.8) so nothing overhangs the rounded corners.
// The lower-intensity glyphs (protest / outage / jamming / incident) keep their
// thin-stroke look — the operator wanted the FIGHT symbols to shout, not the set.
function backed(color: string, glyph: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26">
    <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="${color}" stroke="${OUT}" stroke-width="1.4"/>
    <g transform="translate(4.2 4.2) scale(0.65)" fill="${GLYPH_FG}" stroke-linejoin="round">${glyph}</g>
  </svg>`;
}

// Explosion starburst — bombing / explosion / IED / remote violence.
function blastSvg(color: string): string {
  return backed(
    color,
    `<path d="M12 1 L13.7 7.2 L18.5 3.2 L16.4 9 L22.8 8.2 L17.6 12 L22.8 15.8 L16.4 15 L18.5 20.8 L13.7 16.8 L12 23 L10.3 16.8 L5.5 20.8 L7.6 15 L1.2 15.8 L6.4 12 L1.2 8.2 L7.6 9 L5.5 3.2 L10.3 7.2 Z"
      fill="${GLYPH_FG}"/>`,
  );
}

// Falling aerial bomb — air strike / missile strike.
function airstrikeSvg(color: string): string {
  return backed(
    color,
    `<path d="M12 21.5 C8.4 21.5 6.8 18.3 6.8 15 C6.8 10.8 9.8 7.6 12 3.5 C14.2 7.6 17.2 10.8 17.2 15 C17.2 18.3 15.6 21.5 12 21.5 Z"
      fill="${GLYPH_FG}"/>
    <rect x="11.1" y="1.4" width="1.8" height="3.4" rx="0.6" fill="${GLYPH_FG}"/>
    <path d="M8.6 2.6 L12 5.6 L15.4 2.6" fill="none" stroke="${GLYPH_FG}" stroke-width="2"/>`,
  );
}

// Incoming trajectory + burst — shelling / artillery / rocket / mortar.
function artillerySvg(color: string): string {
  return backed(
    color,
    `<path d="M3 20 Q11 1 21 11" fill="none" stroke="${GLYPH_FG}" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="2.2 2.4"/>
    <path d="M18.4 8.4 L22.6 10.8 L18.8 13.4 Z" fill="${GLYPH_FG}"/>
    <path d="M3 20 l3 -1.1 l-1.1 3 z" fill="${GLYPH_FG}"/>`,
  );
}

// Crossed blades — armed clash / battle / offensive.
function clashSvg(color: string): string {
  return backed(
    color,
    `<path d="M4 3 L14 15 L12.5 16.5 L2.5 4.5 Z" fill="${GLYPH_FG}"/>
    <path d="M20 3 L10 15 L11.5 16.5 L21.5 4.5 Z" fill="${GLYPH_FG}"/>
    <circle cx="4" cy="19" r="2.4" fill="${GLYPH_FG}"/>
    <circle cx="20" cy="19" r="2.4" fill="${GLYPH_FG}"/>`,
  );
}

// Target reticle — armed assault / gunfire / attack on unit.
function gunfireSvg(color: string): string {
  return backed(
    color,
    `<circle cx="12" cy="12" r="7.5" fill="none" stroke="${GLYPH_FG}" stroke-width="2.4"/>
    <circle cx="12" cy="12" r="2.6" fill="${GLYPH_FG}"/>
    <line x1="12" y1="1.5" x2="12" y2="5.5" stroke="${GLYPH_FG}" stroke-width="2.4" stroke-linecap="round"/>
    <line x1="12" y1="18.5" x2="12" y2="22.5" stroke="${GLYPH_FG}" stroke-width="2.4" stroke-linecap="round"/>
    <line x1="1.5" y1="12" x2="5.5" y2="12" stroke="${GLYPH_FG}" stroke-width="2.4" stroke-linecap="round"/>
    <line x1="18.5" y1="12" x2="22.5" y2="12" stroke="${GLYPH_FG}" stroke-width="2.4" stroke-linecap="round"/>`,
  );
}

// Flag on a pole — protest / riot / demonstration / unrest.
function protestSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <line x1="6.5" y1="2.5" x2="6.5" y2="22" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M6.5 3.5 L19 6.2 L6.5 11 Z" fill="${color}" stroke="${OUT}" stroke-width="0.6" stroke-linejoin="round"/>
  </svg>`;
}

// Quadcopter — drone / UAV strike / loitering munition.
function droneSvg(color: string): string {
  return backed(
    color,
    `<line x1="6" y1="6" x2="18" y2="18" stroke="${GLYPH_FG}" stroke-width="2"/>
    <line x1="18" y1="6" x2="6" y2="18" stroke="${GLYPH_FG}" stroke-width="2"/>
    <circle cx="6" cy="6" r="3" fill="none" stroke="${GLYPH_FG}" stroke-width="1.8"/>
    <circle cx="18" cy="6" r="3" fill="none" stroke="${GLYPH_FG}" stroke-width="1.8"/>
    <circle cx="6" cy="18" r="3" fill="none" stroke="${GLYPH_FG}" stroke-width="1.8"/>
    <circle cx="18" cy="18" r="3" fill="none" stroke="${GLYPH_FG}" stroke-width="1.8"/>
    <rect x="9.3" y="9.3" width="5.4" height="5.4" rx="1" fill="${GLYPH_FG}"/>`,
  );
}

// Ship hull + burst — naval clash / maritime incident / dark-vessel event.
function navalSvg(color: string): string {
  return backed(
    color,
    `<path d="M3 13 L21 13 L18 19 L6 19 Z" fill="${GLYPH_FG}"/>
    <rect x="10" y="8" width="4" height="5" fill="${GLYPH_FG}"/>
    <path d="M15.5 3 L16.6 6 L19.5 6 L17.2 7.9 L18.1 11 L15.5 9.2 L12.9 11 L13.8 7.9 L11.5 6 L14.4 6 Z"
      fill="${GLYPH_FG}"/>`,
  );
}

// Globe with a slash — internet outage (IODA) / connectivity loss.
function outageSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <circle cx="12" cy="12" r="8.5" fill="none" stroke="${color}" stroke-width="1.4"/>
    <ellipse cx="12" cy="12" rx="3.6" ry="8.5" fill="none" stroke="${color}" stroke-width="1"/>
    <line x1="3.5" y1="12" x2="20.5" y2="12" stroke="${color}" stroke-width="1"/>
    <line x1="4.5" y1="4.5" x2="19.5" y2="19.5" stroke="${OUT}" stroke-width="3"/>
    <line x1="4.5" y1="4.5" x2="19.5" y2="19.5" stroke="${color}" stroke-width="1.6"/>
  </svg>`;
}

// Antenna radiating waves + slash — GPS jamming / GNSS spoofing.
function jammingSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22">
    <line x1="12" y1="9" x2="12" y2="21" stroke="${color}" stroke-width="1.6"/>
    <path d="M9 9 L12 4 L15 9 Z" fill="${color}" stroke="${OUT}" stroke-width="0.5" stroke-linejoin="round"/>
    <path d="M6.5 12 A6 6 0 0 1 17.5 12" fill="none" stroke="${color}" stroke-width="1.1"/>
    <path d="M4 14 A9 9 0 0 1 20 14" fill="none" stroke="${color}" stroke-width="1.1" opacity="0.7"/>
  </svg>`;
}

// Diamond with exclamation — generic fused incident / warning fallback.
function incidentSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <path d="M12 2 L22 12 L12 22 L2 12 Z" fill="${color}" stroke="${OUT}" stroke-width="0.75" stroke-linejoin="round"/>
    <text x="12" y="16.5" text-anchor="middle" font-family="monospace" font-size="12" font-weight="bold" fill="${OUT}">!</text>
  </svg>`;
}

export type EventGlyph =
  | 'blast'
  | 'airstrike'
  | 'artillery'
  | 'clash'
  | 'gunfire'
  | 'protest'
  | 'drone'
  | 'naval'
  | 'outage'
  | 'jamming'
  | 'incident';

const BUILDERS: Record<EventGlyph, (color: string) => string> = {
  blast: blastSvg,
  airstrike: airstrikeSvg,
  artillery: artillerySvg,
  clash: clashSvg,
  gunfire: gunfireSvg,
  protest: protestSvg,
  drone: droneSvg,
  naval: navalSvg,
  outage: outageSvg,
  jamming: jammingSvg,
  incident: incidentSvg,
};

// key → data URI cache so we don't reflow the same SVG every render frame.
const _cache = new Map<string, string>();

/** Data URI for one event glyph tinted `color`, cached by (glyph, color). */
export function eventIcon(glyph: EventGlyph, color: string): string {
  const key = `${glyph}:${color}`;
  let v = _cache.get(key);
  if (!v) {
    v = dataUri(BUILDERS[glyph](color));
    _cache.set(key, v);
  }
  return v;
}
