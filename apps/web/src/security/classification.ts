// US IC classification ladder — mirror of apps/api/app/intel/classification.py.
// The Postgres RLS policies are the REAL enforcement; this client copy is for
// display (banner + badges) and for capping the create form at the user's
// clearance. Keep the ladder + marking format in sync with the backend.

export const LEVELS = [
  'UNCLASSIFIED',
  'CUI',
  'CONFIDENTIAL',
  'SECRET',
  'TOP SECRET',
] as const;

export type Level = 0 | 1 | 2 | 3 | 4;

export const UNCLASSIFIED: Level = 0;
export const CUI: Level = 1;
export const CONFIDENTIAL: Level = 2;
export const SECRET: Level = 3;
export const TOP_SECRET: Level = 4;

// US-standard banner accent colours.
export const LEVEL_COLOR: Record<number, string> = {
  0: '#007a33', // green
  1: '#6b2fa0', // purple
  2: '#0033a0', // blue
  3: '#c8102e', // red
  4: '#ff8c00', // orange
};

export function clampLevel(n: number): Level {
  const v = Number.isFinite(n) ? Math.trunc(n) : 0;
  return Math.max(0, Math.min(v, 4)) as Level;
}

export function label(level: number): string {
  return LEVELS[clampLevel(level)];
}

function normComps(compartments?: string[]): string[] {
  const set = new Set(
    (compartments ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean),
  );
  return Array.from(set).sort();
}

export function marking(level: number, compartments?: string[]): string {
  const comps = normComps(compartments);
  return label(level) + (comps.length ? `//${comps.join('/')}` : '');
}

export function canRead(
  clearance: number,
  held: string[],
  rowLevel: number,
  rowComps?: string[],
): boolean {
  if (clampLevel(rowLevel) > clampLevel(clearance)) return false;
  const have = new Set((held ?? []).map((c) => c.toUpperCase()));
  for (const c of normComps(rowComps)) {
    if (!have.has(c)) return false;
  }
  return true;
}
