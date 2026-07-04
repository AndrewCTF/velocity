import { type EventGlyph } from '../eventIcons.js';

// Classify a conflict / incident / outage feature into a symbology glyph +
// colour. This is the dispatch that turns "armed clash", CAMEO root 20, or a
// fused-incident domain set into a MEANINGFUL icon (bombing, clash, drone,
// jamming…) instead of a bare red disc + text. Mirrors styles.ts's per-category
// dispatch pattern. Pure + deterministic so the AreaAdapter can call it per
// feature every poll without allocation surprises.

export interface EventSymbol {
  glyph: EventGlyph;
  color: string;
  /** High-intensity events pulse (billboard scale breathe) to draw the eye. */
  pulse: boolean;
}

// Violence palette — deep red for mass violence, red/orange down the intensity
// ramp, violet for jamming (matches the GPS-jamming layer), amber for outages,
// yellow for civil unrest. Kept as literals (not tokens): these are legend
// swatch colours, not app chrome (same policy as styles.ts HEX_* constants).
const C_MASS = '#dc2626';
const C_STRIKE = '#ef4444';
const C_CLASH = '#f97316';
const C_GUN = '#fb923c';
const C_PROTEST = '#eab308';
const C_JAM = '#a855f7';
const C_OUTAGE = '#f59e0b';
const C_NAVAL = '#38bdf8';

// Keyword → glyph. Ordered by specificity: a "drone strike" must match `drone`
// before `strike`, a "naval clash" match `naval` before `clash`. First hit wins.
const KEYWORD_RULES: Array<[RegExp, EventGlyph]> = [
  [/\b(drone|uav|shahed|geran|loiter\w*|fpv|kamikaze)\b/i, 'drone'],
  [/\b(jam+|spoof\w*|gnss|gps deni)/i, 'jamming'],
  [/(outage|internet|connectivity|ddos|blackout|throttl)/i, 'outage'],
  [/(naval|maritime|warship|frigate|corvette|port strike|harbou?r)/i, 'naval'],
  [/(air ?strike|airstrike|air raid|missile|ballistic|cruise|guided bomb|kab\b|glide bomb|sortie)/i, 'airstrike'],
  [/(shell\w*|artiller\w*|rocket|mortar|grad|himars|mlrs|bombard|barrage)/i, 'artillery'],
  [/(explos\w*|blast|detonat\w*|\bied\b|land ?mine|car bomb|suicide)/i, 'blast'],
  [/(protest|riot|demonstrat\w*|rally|unrest|strike action|march)/i, 'protest'],
  [/(clash\w*|battle|fight\w*|offensive|assault on|storm\w*|engag\w*|firefight|combat)/i, 'clash'],
  [/(gun\w*|shoot\w*|small ?arms|sniper|shell?ing of|attack|raid|kill\w*|casualt)/i, 'gunfire'],
];

// CAMEO root code (GDELT `root`) → glyph fallback when the text is unhelpful.
//   18 assault, 19 fight, 20 use of unconventional mass violence.
const CAMEO_ROOT: Record<string, EventGlyph> = {
  '20': 'blast',
  '19': 'clash',
  '18': 'gunfire',
};

const GLYPH_COLOR: Record<EventGlyph, string> = {
  blast: C_STRIKE,
  airstrike: C_STRIKE,
  artillery: C_STRIKE,
  clash: C_CLASH,
  gunfire: C_GUN,
  drone: C_STRIKE,
  naval: C_NAVAL,
  protest: C_PROTEST,
  jamming: C_JAM,
  outage: C_OUTAGE,
  incident: C_STRIKE,
};

function matchKeyword(text: string): EventGlyph | null {
  for (const [re, glyph] of KEYWORD_RULES) {
    if (re.test(text)) return glyph;
  }
  return null;
}

/** GDELT armed-conflict cell → symbol. `root` is the CAMEO root code string. */
export function conflictSymbol(label: string, root: string, mentions: number): EventSymbol {
  const glyph = matchKeyword(label) ?? CAMEO_ROOT[root] ?? 'clash';
  const mass = root === '20';
  return {
    glyph,
    color: mass ? C_MASS : GLYPH_COLOR[glyph],
    pulse: mass || mentions >= 25,
  };
}

// Fused-incident domain → glyph, in priority order (first present domain wins).
const DOMAIN_GLYPH: Array<[string, EventGlyph]> = [
  ['gps-jamming', 'jamming'],
  ['spoofing', 'jamming'],
  ['dark-vessel', 'naval'],
  ['ais-gap', 'naval'],
  ['military', 'clash'],
  ['air-emergency', 'incident'],
  ['quake', 'incident'],
  ['event', 'incident'],
];

/** Fused-brief incident → symbol from its domain set + narrative text. */
export function incidentSymbol(
  domains: string[],
  narrative: string,
  threatLevel: string,
): EventSymbol {
  // Narrative keyword first (most specific: "drone strike on port"), then the
  // domain taxonomy, then a generic incident diamond.
  let glyph = matchKeyword(narrative);
  if (!glyph) {
    for (const [dom, g] of DOMAIN_GLYPH) {
      if (domains.includes(dom)) {
        glyph = g;
        break;
      }
    }
  }
  glyph ??= 'incident';
  return { glyph, color: GLYPH_COLOR[glyph], pulse: threatLevel === 'high' };
}

/** CAIDA IODA internet-outage event → symbol. */
export function outageSymbol(score: number): EventSymbol {
  return { glyph: 'outage', color: C_OUTAGE, pulse: score >= 50 };
}
