// Shared camera-motion flag — one source of truth so any layer can cheaply skip
// heavy per-push / per-frame work while the operator is actively dragging or
// zooming (design §5.2). GlobeCanvas owns the moveStart/moveEnd wiring; readers
// just call isCameraMoving() / cameraMovingForMs().
//
// ponytail: module singleton + two ints, not per-layer camera listeners. The
// §5.6 cleanup already wants ONE motion watcher; this is it.

let moving = false;
let movingSince = 0;

export function setCameraMoving(v: boolean): void {
  if (v && !moving) movingSince = performance.now();
  moving = v;
}

export function isCameraMoving(): boolean {
  return moving;
}

/** Milliseconds the camera has been continuously in motion, else 0. */
export function cameraMovingForMs(): number {
  return moving ? performance.now() - movingSince : 0;
}
