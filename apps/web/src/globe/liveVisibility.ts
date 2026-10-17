// Replay hides the live map. Entity layers hide through their data source's
// `show` flag (HistoryPlayback.hideLive), but the batched primitive layers
// (aircraft, vessels, satellites, reference markers) draw their pixels from
// pooled Billboard/Label collections that follow no data source, so a replay of
// 2025 drew today's traffic on top of it (measured 2026-10-17: 9,631 live
// aircraft billboards and 6,000 vessels still shown with the live data sources
// hidden). Those layers register here and hide their own primitives.

export interface LiveHideable {
  setLiveHidden(hidden: boolean): void;
}

const layers = new Set<LiveHideable>();
let hidden = false;

/** True while a replay owns the map; a layer created now must start hidden. */
export function liveHidden(): boolean {
  return hidden;
}

/** Register a primitive layer; returns its unregister. */
export function registerLiveLayer(layer: LiveHideable): () => void {
  layers.add(layer);
  if (hidden) layer.setLiveHidden(true);
  return () => {
    layers.delete(layer);
  };
}

export function setLiveLayersHidden(next: boolean): void {
  if (next === hidden) return;
  hidden = next;
  for (const layer of layers) layer.setLiveHidden(next);
}
