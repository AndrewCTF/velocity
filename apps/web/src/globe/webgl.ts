// Can this browser give the globe a WebGL 2 context?
//
// Cesium asks for "webgl2" and, once the browser claims to know WebGL 2, does
// not fall back (Cesium's Context.js only drops to WebGL 1 when the
// WebGL2RenderingContext class is missing altogether). So a device with
// hardware acceleration off, a blocklisted GPU or `--disable-3d-apis` has the
// class, fails to hand out the context, and Cesium throws out of its
// constructor. That used to land in the generic "globe" error boundary: a
// "stopped rendering" notice that names neither the cause nor a way out.
// NoWebGL.tsx says what is missing instead; this is the probe it keys on.
//
// The probe is stricter than Cesium in one corner: a browser that has only
// WebGL 1 (Safari before 15) would run the globe in Cesium's fallback, and is
// turned away here because the message promises WebGL 2. Cesium's own default
// is WebGL 2, and that browser is five years old.

export function hasWebGL2(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    // The context was only a question. Hand the GPU slot back now instead of
    // leaving it to the garbage collector: browsers cap live contexts (about
    // 16) and the globe is about to need one of them.
    try {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      /* a probe that cannot be released is still a probe that answered yes */
    }
    return true;
  } catch {
    return false;
  }
}
