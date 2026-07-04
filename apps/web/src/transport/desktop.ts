// Desktop-capability gate. Detection (YOLO via CUDA) runs ONLY inside the Tauri
// desktop app (apps/desktop), NOT in a plain browser and NOT on the backend.
//
// Tauri 2 always injects window.__TAURI_INTERNALS__ with an `invoke(cmd, args)`
// function, regardless of withGlobalTauri — so we can call the Rust command
// `detect_image` / `detect_status` with zero added dependencies, and simply
// return null/false on the website so the UI degrades cleanly.

import type { DetectStatus, GroundDetection } from '../ground/types.js';

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function internals(): TauriInternals | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

/** True only inside the Tauri desktop shell (where the CUDA sidecar is spawned). */
export function isDesktop(): boolean {
  return internals() !== null;
}

function bytesToB64(bytes: Uint8Array): string {
  // ponytail: byte-by-byte + btoa. Fine for <1MB cam frames; swap to a streaming
  // encoder if large panoramas ever go through detect.
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/**
 * Run the desktop CUDA sidecar on an image. Returns null on the website (no
 * detection) or if the sidecar is unavailable. Boxes are normalized 0..1.
 */
export async function detectImage(bytes: Uint8Array): Promise<GroundDetection[] | null> {
  const t = internals();
  if (!t) return null;
  try {
    const raw = (await t.invoke('detect_image', { imageB64: bytesToB64(bytes) })) as {
      detections?: Array<{ cls: string; conf: number; bbox: { x: number; y: number; w: number; h: number } }>;
    };
    if (!raw?.detections) return null;
    return raw.detections.map((d, i) => ({ id: `${d.cls}:${i}`, cls: d.cls, conf: d.conf, bbox: d.bbox }));
  } catch {
    return null;
  }
}

/** Sidecar device/ready status for the UI chip; null on the website. */
export async function detectStatus(): Promise<DetectStatus | null> {
  const t = internals();
  if (!t) return null;
  try {
    return (await t.invoke('detect_status')) as DetectStatus;
  } catch {
    return null;
  }
}
