// Prototype-pollution guards for objects keyed by data (ASVS V15.3.6).
//
// A plain `{}` indexed by a feed-supplied or user-typed key misbehaves on three
// names: `obj['__proto__'] = x` re-points that object's prototype instead of
// storing x, and `constructor` / `prototype` read back inherited values, so a
// tally of `acc[k] = (acc[k] ?? 0) + 1` turns into string concatenation and
// `(acc[k] ||= []).push()` throws. Two tools, pick by the target:
//   - dict(): a prototype-less record for tallies and key/value bags we build.
//   - isUnsafeKey(): skip the key when the target is someone else's object
//     (a Cesium PropertyBag) that must keep its prototype.

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

export function isUnsafeKey(key: string): boolean {
  return UNSAFE.has(key);
}

/** A record with no prototype: every string key, `__proto__` included, is plain data. */
export function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
