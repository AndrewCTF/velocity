// Freshness of a contact's POSITION, and how the globe should say so.
//
// The backend now publishes the age of the DATA rather than the age of the
// response: cached tiers stamp an absolute `pos_epoch` and the serve boundary
// re-derives `seen_pos_s` against the current clock (see routes/adsb.py
// `_age_cached_positions`). Before that, an OpenSky contact pulled once per UTC
// day reported "5 s old" all day and rendered as a live aircraft parked on this
// morning's fix — the operator's "so many dead planes".
//
// Fixing the number is only half of it. A stale contact is still real evidence
// (it is where the aircraft WAS), so we keep drawing it and say so, rather than
// deleting it and quietly shrinking the picture. The research this came from is
// unambiguous that publishing your lag builds trust rather than costing it:
// "Is Hormuz open yet?" led with a four-day data lag and took 484 points on HN
// (docs/research-last30days-2026-07-29.md §3), while the largest cluster of
// complaints on a 312-point launch was a map that failed silently (§5.1).

/** Age past which a fix stops reading as live. Mirrors `_FRESH_POS_S` in routes/adsb.py. */
export const FRESH_POS_S = 120;

/** Opacity applied to a stale contact's icon. Dim enough to recede, bright
 *  enough to stay legible against the dark globe. */
export const STALE_ALPHA = 0.45;

/**
 * How old this contact's position is, in seconds. Returns null when the feed
 * did not say — an unknown age is not evidence of staleness, and guessing one
 * would be the same class of lie the backend fix just removed.
 */
export function positionAgeS(props: Record<string, unknown>): number | null {
  const v = props['seen_pos_s'];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

/**
 * True when this contact should render as stale. Prefers the backend's own
 * `stale` verdict (it knows which tier served the fix and what that tier's
 * refresh interval means) and falls back to the age threshold.
 */
export function isStale(props: Record<string, unknown>): boolean {
  const flag = props['stale'];
  if (typeof flag === 'boolean') return flag;
  const age = positionAgeS(props);
  return age != null && age > FRESH_POS_S;
}

/**
 * Compact human age: "12s", "5m", "6h", "2d". Coarse on purpose — the point is
 * "this is not live", and second-precision on a six-hour-old fix reads as more
 * certainty than we have.
 */
export function agoText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/**
 * The label suffix for a stale contact, or null when it is live (or its age is
 * unknown). Separator is ` · ` per the dashboard copy rule in CLAUDE.md — no em
 * dashes anywhere in operator-visible copy.
 */
export function staleLabelSuffix(props: Record<string, unknown>): string | null {
  if (!isStale(props)) return null;
  const age = positionAgeS(props);
  if (age == null) return null;
  return ` · ${agoText(age)} ago`;
}

/**
 * Compose an identifier with its staleness suffix. Keeps the identifier
 * resolvers in labelStyle.ts pure (callsign → registration → ICAO24 is a guarded
 * invariant) while still letting the globe show the age.
 */
export function withStaleness(
  text: string | null,
  props: Record<string, unknown>,
): string | null {
  if (text == null) return null;
  const suffix = staleLabelSuffix(props);
  return suffix ? `${text}${suffix}` : text;
}
