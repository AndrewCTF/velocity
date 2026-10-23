// Curated catalogue of well-known COMMERCIAL imaging / RF-collection satellites,
// used by the tasking planner to decide which of CelesTrak's `active` group are
// "sensor" birds worth computing AOI passes for.
//
// This is a DELIBERATELY PARTIAL list of representative members of each
// constellation — it makes NO completeness claim. Constellations refresh often
// (ICEYE, Capella, Planet, Spire add/retire satellites constantly), so the
// planner matches BOTH ways:
//   1. exact NORAD id when we know it, and
//   2. case-insensitive NAME-substring (the `match` field) — so a fresh
//      "STARLINK-style" launch the operator pulls from CelesTrak still gets
//      classified by its object name even if its NORAD id isn't listed here.
//
// `norad: 0` means "we don't pin a specific catalogue number; classify this
// constellation purely by name substring". Where a real, stable NORAD id is
// known for a representative satellite it's filled in (best-effort, public).
// Every pinned id was checked against CelesTrak's GP OBJECT_NAME on 2026-10-23
// (BlackSky is catalogued as GLOBAL-n, so its ids classify it and the name
// rule does not). A pinned id wins over the name, so a wrong one mislabels
// whatever owns that number: re-check with gp.php?CATNR=<id> when editing.

export type SensorKind = "SAR" | "EO" | "MSI" | "RF";

export interface SensorSat {
  norad: number; // 0 = match by name substring only (no pinned catalogue id)
  name: string; // display name
  match: string; // lowercase object-name substring used to classify CelesTrak items
  sensor: SensorKind;
  operator: string;
}

// ~30 representative entries across the major commercial constellations.
export const SENSOR_SATS: readonly SensorSat[] = [
  // ── SAR (Synthetic Aperture Radar) — all-weather, day/night imaging ────────
  {
    norad: 43800,
    name: "ICEYE-X2",
    match: "iceye",
    sensor: "SAR",
    operator: "ICEYE",
  },
  {
    norad: 44390,
    name: "ICEYE-X4",
    match: "iceye",
    sensor: "SAR",
    operator: "ICEYE",
  },
  {
    norad: 46497,
    name: "ICEYE-X6",
    match: "iceye",
    sensor: "SAR",
    operator: "ICEYE",
  },
  {
    norad: 46496,
    name: "ICEYE-X7",
    match: "iceye",
    sensor: "SAR",
    operator: "ICEYE",
  },
  {
    norad: 0,
    name: "ICEYE (constellation)",
    match: "iceye",
    sensor: "SAR",
    operator: "ICEYE",
  },
  {
    norad: 57693,
    name: "CAPELLA-11 (ACADIA-1)",
    match: "capella",
    sensor: "SAR",
    operator: "Capella Space",
  },
  {
    norad: 59444,
    name: "CAPELLA-14 (ACADIA-4)",
    match: "capella",
    sensor: "SAR",
    operator: "Capella Space",
  },
  {
    norad: 60419,
    name: "CAPELLA-13 (ACADIA-3)",
    match: "capella",
    sensor: "SAR",
    operator: "Capella Space",
  },
  {
    norad: 0,
    name: "CAPELLA (constellation)",
    match: "capella",
    sensor: "SAR",
    operator: "Capella Space",
  },
  {
    norad: 58297,
    name: "UMBRA-07",
    match: "umbra",
    sensor: "SAR",
    operator: "Umbra",
  },
  {
    norad: 60541,
    name: "UMBRA-09",
    match: "umbra",
    sensor: "SAR",
    operator: "Umbra",
  },
  // Sentinel-1 classifies by NORAD id only: "sentinel-1" never equals an alpha
  // token, so Sentinel-2/3/6 (optical/altimetry) cannot fall into SAR by name.
  {
    norad: 39634,
    name: "SENTINEL-1A",
    match: "sentinel-1",
    sensor: "SAR",
    operator: "ESA Copernicus",
  },
  {
    norad: 62261,
    name: "SENTINEL-1C",
    match: "sentinel-1",
    sensor: "SAR",
    operator: "ESA Copernicus",
  },
  {
    norad: 66315,
    name: "SENTINEL-1D",
    match: "sentinel-1",
    sensor: "SAR",
    operator: "ESA Copernicus",
  },
  {
    norad: 0,
    name: "UMBRA (constellation)",
    match: "umbra",
    sensor: "SAR",
    operator: "Umbra",
  },

  // ── EO / MSI (Electro-Optical / Multispectral) — visible-light imaging ─────
  // Planet SkySat — sub-metre EO; Planet Dove/Flock — ~3 m daily MSI.
  {
    norad: 39418,
    name: "SKYSAT-A",
    match: "skysat",
    sensor: "EO",
    operator: "Planet",
  },
  {
    norad: 40072,
    name: "SKYSAT-B",
    match: "skysat",
    sensor: "EO",
    operator: "Planet",
  },
  {
    norad: 41601,
    name: "SKYSAT-C1",
    match: "skysat",
    sensor: "EO",
    operator: "Planet",
  },
  {
    norad: 0,
    name: "SKYSAT (constellation)",
    match: "skysat",
    sensor: "EO",
    operator: "Planet",
  },
  {
    norad: 0,
    name: "Planet DOVE / FLOCK",
    match: "flock",
    sensor: "MSI",
    operator: "Planet",
  },
  {
    norad: 0,
    name: "Planet DOVE",
    match: "dove",
    sensor: "MSI",
    operator: "Planet",
  },
  {
    norad: 0,
    name: "Planet SuperDove",
    match: "superdove",
    sensor: "MSI",
    operator: "Planet",
  },
  // BlackSky Global — rapid-revisit high-res EO.
  {
    norad: 43812,
    name: "BLACKSKY GLOBAL-2",
    match: "blacksky",
    sensor: "EO",
    operator: "BlackSky",
  },
  {
    norad: 47971,
    name: "BLACKSKY GLOBAL-9",
    match: "blacksky",
    sensor: "EO",
    operator: "BlackSky",
  },
  {
    norad: 49469,
    name: "BLACKSKY GLOBAL-14",
    match: "blacksky",
    sensor: "EO",
    operator: "BlackSky",
  },
  {
    norad: 0,
    name: "BLACKSKY (constellation)",
    match: "blacksky",
    sensor: "EO",
    operator: "BlackSky",
  },

  // ── RF (Radio-Frequency geolocation) — emitter mapping, AIS/RF survey ──────
  // HawkEye 360 flies in clusters; Spire LEMUR does RF (AIS/ADS-B) + GNSS-RO.
  {
    norad: 43765,
    name: "HAWK-A (HawkEye 360)",
    match: "hawk",
    sensor: "RF",
    operator: "HawkEye 360",
  },
  {
    norad: 43794,
    name: "HAWK-B (HawkEye 360)",
    match: "hawk",
    sensor: "RF",
    operator: "HawkEye 360",
  },
  {
    norad: 43799,
    name: "HAWK-C (HawkEye 360)",
    match: "hawk",
    sensor: "RF",
    operator: "HawkEye 360",
  },
  {
    norad: 0,
    name: "HAWKEYE 360 (constellation)",
    match: "hawkeye",
    sensor: "RF",
    operator: "HawkEye 360",
  },
  {
    norad: 0,
    name: "Spire LEMUR",
    match: "lemur",
    sensor: "RF",
    operator: "Spire Global",
  },
  {
    norad: 0,
    name: "Spire (constellation)",
    match: "spire",
    sensor: "RF",
    operator: "Spire Global",
  },
] as const;

// Build a fast NORAD→sensor lookup once (skips the 0 sentinels).
const BY_NORAD = new Map<number, SensorSat>();
for (const s of SENSOR_SATS) {
  if (s.norad > 0 && !BY_NORAD.has(s.norad)) BY_NORAD.set(s.norad, s);
}

// Name-substring rules, longest-substring-first so e.g. "superdove" wins over
// "dove" and "hawkeye" is checked before "hawk".
const NAME_RULES: readonly SensorSat[] = [...SENSOR_SATS].sort(
  (a, b) => b.match.length - a.match.length,
);

// Classify a CelesTrak object by NORAD id (preferred) then by name substring.
// Returns undefined for anything not in a curated commercial-sensor constellation.
export function sensorOf(name: string, norad?: number): SensorSat | undefined {
  if (norad != null && norad > 0) {
    const hit = BY_NORAD.get(norad);
    if (hit) return hit;
  }
  const lc = (name || "").toLowerCase();
  if (!lc) return undefined;
  // Match on whole ALPHA tokens, NOT a bare substring — an unanchored includes()
  // mis-classifies unrelated active-group sats (GLOBALHAWK→"hawk", INSPIRESAT→
  // "spire", TURTLEDOVE→"dove"), over-counting the "known-sensor" set. A token
  // equals the match, or (for distinctive >=5-char names only, to keep short
  // tokens like "hawk"/"dove" exact) starts with it. Longest-first keeps
  // "superdove" winning over "dove".
  const tokens = lc.match(/[a-z]+/g) ?? [];
  for (const rule of NAME_RULES) {
    const m = rule.match;
    for (const tok of tokens) {
      if (tok === m || (m.length >= 5 && tok.startsWith(m))) return rule;
    }
  }
  return undefined;
}

// Distinct sensor kinds present in the catalogue (for chip rendering).
export const SENSOR_KINDS: readonly SensorKind[] = ["EO", "MSI", "SAR", "RF"];
