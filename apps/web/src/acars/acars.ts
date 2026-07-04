import { apiFetch } from '../transport/http.js';

// One normalized ACARS/VDL/HFDL/SATCOM message from /api/acars (airframes.io).
export interface AcarsMsg {
  id?: number;
  t?: string | null;
  label?: string | null;
  tail?: string | null;
  icao?: string | null;
  flight?: string | null;
  mode?: string | null;
  system?: string | null; // ACARS | VDL | HFDL | SATCOM (clean datalink carrier)
  station?: string | null;
  text?: string | null;
  freq?: number | null;
  lat?: number | null;
  lon?: number | null;
}

export const ACARS_SYSTEMS = ['ACARS', 'VDL', 'HFDL', 'SATCOM'] as const;
export type AcarsSystem = (typeof ACARS_SYSTEMS)[number];

export interface AcarsResponse {
  messages: AcarsMsg[];
  summary?: { count?: number; with_position?: number; stations?: number; source?: string; coverage?: string };
}

// Recent datalink firehose (≤100, backend-cached 15s). Throws on non-2xx.
export async function fetchAcars(limit = 100, signal?: AbortSignal): Promise<AcarsResponse> {
  const r = await apiFetch(`/api/acars?limit=${limit}`, signal ? { signal } : {});
  if (!r.ok) throw new Error(`acars ${r.status}`);
  return (await r.json()) as AcarsResponse;
}

// Inferred message ORIGIN: crew/pilot free-text vs automatic system message.
// ACARS carries NO origin flag, so this is best-effort, label + payload based:
//   - no free text                  → system (machine/control frame)
//   - label H1 / _d / SA / Q*       → system (position, link control, media)
//   - free text with real words     → pilot (crew/AOC free text, e.g. "RLS VERIFICATION")
//   - else (coded telemetry digits) → system
const SYS_LABELS = new Set(['H1', '_D', 'SA', 'SQ', ':;', '4;', '52']);
export type AcarsOrigin = 'pilot' | 'system';
export function originOf(m: AcarsMsg): AcarsOrigin {
  const t = (m.text ?? '').trim();
  if (!t) return 'system';
  const lab = (m.label ?? '').toUpperCase();
  if (lab.startsWith('Q')) return 'system';
  if (SYS_LABELS.has(lab)) return 'system';
  return /[A-Za-z]{3,}/.test(t) ? 'pilot' : 'system';
}

export function systemOf(m: AcarsMsg): string {
  return m.system ?? m.mode ?? '—';
}
