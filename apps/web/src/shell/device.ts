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

// Graded device capability tier — a supplement to the binary isMobileDevice()
// heuristic, which misses the case that actually lags: a weak-GPU DESKTOP or
// laptop (mouse + wide screen → reads as "not mobile" → gets full quality).
// One-shot (no continuous polling): we probe RAM, CPU cores and, decisively, the
// WebGL unmasked renderer string for software / very-weak GPUs. Used only to
// SUGGEST (not force) the 2D map and to hint the Performance preset; the manual
// quality preset is the real lever. Memoized — the WebGL probe allocates a
// throwaway context, so we run it once.
export type DeviceTier = 'low' | 'mid' | 'high';

let _tier: DeviceTier | null = null;

// GPUs / renderers that cannot carry the full 3D scene at a usable frame rate.
// Software rasterizers first (definitive), then common integrated/basic strings.
const WEAK_RENDERER = /swiftshader|llvmpipe|softpipe|mesa\s+(offscreen|software)|microsoft\s+basic\s+render|apple\s+software|virgl|gdi\s+generic/i;

function probeRenderer(): { failed: boolean; weak: boolean } {
  if (typeof document === 'undefined') return { failed: false, weak: false };
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { failed: true, weak: true };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '')
      : String(gl.getParameter(gl.RENDERER) ?? '');
    return { failed: false, weak: WEAK_RENDERER.test(renderer) };
  } catch {
    // Context creation threw → treat as a failed/very-weak GPU.
    return { failed: true, weak: true };
  }
}

export function deviceTier(): DeviceTier {
  if (_tier !== null) return _tier;
  if (typeof navigator === 'undefined') return (_tier = 'high');

  const { failed, weak } = probeRenderer();
  // A software renderer or a failed WebGL context is decisive — it will never
  // hold the globe smoothly, regardless of RAM/cores.
  if (failed || weak) return (_tier = 'low');

  // navigator.deviceMemory (GiB, Chromium-only) and hardwareConcurrency (logical
  // cores) are coarse but cheap. Missing values are left undefined so a browser
  // that doesn't report them isn't penalized.
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency;
  const lowMem = typeof mem === 'number' && mem <= 4;
  const lowCores = typeof cores === 'number' && cores <= 4;

  // Both weak → low; either weak (or a small touch device) → mid; else high.
  if (lowMem && lowCores) return (_tier = 'low');
  if (lowMem || lowCores || isMobileDevice()) return (_tier = 'mid');
  return (_tier = 'high');
}
