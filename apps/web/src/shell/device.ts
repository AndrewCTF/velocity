// Coarse device check for performance budgeting. A phone (even a recent flagship)
// can't render/upsert the full ~13k-aircraft world view every ~2 s — it pegs the
// GPU (heat) and starves the main thread so SampledPositionProperty never gets a
// frame to interpolate (planes freeze). Mobile clients get a smaller payload,
// fewer entities, a slower cadence and a lower render scale.
//
// Touch + small-screen is the signal (a coarse pointer catches phones/tablets;
// the width bound keeps desktop touchscreens out of the mobile budget).
export function isMobileDevice(): boolean {
  if (typeof matchMedia === 'undefined') return false;
  return matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 1024px)').matches;
}
