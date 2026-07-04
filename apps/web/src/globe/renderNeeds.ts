// Clock-driven animation registry for the P0d render governor (design §5.1).
//
// The governor relaxes maximumRenderTimeChange to Infinity (stop rendering on
// clock advance) ONLY when the scene is genuinely idle. Some animations aren't
// visible from GlobeCanvas' own state — orbiting satellites (SGP4 SampledPosition)
// and the emergency-squawk pulse both need the scene to render every frame. Each
// such owner declares its need here; the governor keeps rendering while any need
// is registered.
//
// ponytail: a Set of string keys, not an event system. Owners call setRenderNeed
// on state change; the governor polls hasRenderNeed() on its 250 ms tick.

const needs = new Set<string>();

export function setRenderNeed(key: string, on: boolean): void {
  if (on) needs.add(key);
  else needs.delete(key);
}

export function hasRenderNeed(): boolean {
  return needs.size > 0;
}
