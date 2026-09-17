// Web Worker wrapping heatmapChunk's decoder, so decoding a ~9 MB / ~400k-row
// chunk never blocks the render thread. This file plays both roles tar1090's
// own approach avoids splitting into two files: instantiated from the main
// thread via `createHeatmapDecoder()`, it also IS the worker script Vite
// bundles when a `Worker` loads it by its own URL below.
//
// `typeof window === 'undefined'` is how we tell the two contexts apart
// without the `webworker` lib (this repo's tsconfig ships `DOM`, not
// `DOM`+`webworker` — they declare conflicting globals) — a dedicated worker
// has no `window`, a browser main thread and jsdom both do.
import { decodeHeatmapChunk, type DecodedHeatmapChunk } from './heatmapChunk.js';

interface DecodeRequest {
  id: number;
  buf: ArrayBuffer;
}
interface DecodeResponse {
  id: number;
  decoded?: DecodedHeatmapChunk;
  error?: string;
}

if (typeof window === 'undefined' && typeof self !== 'undefined') {
  self.onmessage = (ev: MessageEvent<DecodeRequest>) => {
    const { id, buf } = ev.data;
    const reply = (msg: DecodeResponse): void => (self as unknown as Worker).postMessage(msg);
    try {
      reply({ id, decoded: decodeHeatmapChunk(buf) });
    } catch (err) {
      reply({ id, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export interface HeatmapDecoder {
  decode(buf: ArrayBuffer): Promise<DecodedHeatmapChunk>;
  terminate(): void;
}

let nextRequestId = 1;

/** One decoder per HistoryPlayback controller. Uses a real Worker when the
 *  environment provides one; falls back to decoding synchronously on the
 *  caller's own thread (jsdom/tests, or any environment with no Worker). */
export function createHeatmapDecoder(): HeatmapDecoder {
  if (typeof Worker === 'undefined') {
    return {
      decode: (buf) => Promise.resolve(decodeHeatmapChunk(buf)),
      terminate: () => {},
    };
  }

  const worker = new Worker(new URL('./heatmapWorker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: (d: DecodedHeatmapChunk) => void; reject: (e: unknown) => void }>();

  worker.onmessage = (ev: MessageEvent<DecodeResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.error) p.reject(new Error(ev.data.error));
    else if (ev.data.decoded) p.resolve(ev.data.decoded);
    else p.reject(new Error('heatmap worker: empty response'));
  };
  worker.onerror = (ev: ErrorEvent) => {
    // A worker-level error (e.g. a syntax error in the bundled script) has no
    // request id to route to — reject everything still outstanding so a caller
    // never hangs forever.
    for (const p of pending.values()) p.reject(new Error(ev.message || 'heatmap worker error'));
    pending.clear();
  };

  return {
    decode(buf: ArrayBuffer): Promise<DecodedHeatmapChunk> {
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, buf }, [buf]);
      });
    },
    terminate(): void {
      worker.terminate();
      pending.clear();
    },
  };
}
