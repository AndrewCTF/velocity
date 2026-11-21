// Layer registry — architectural backbone per plan §locked-decisions and
// research_updated.md §1.1. Both the Cesium and MapLibre adapters subscribe
// to events emitted here so they stay in sync.

import { isLayerDescriptor, type LayerDescriptor } from "@osint/shared";

export type RegistryEvent =
  | { type: "register"; layer: LayerDescriptor }
  | { type: "unregister"; id: string }
  | { type: "enable"; id: string }
  | { type: "disable"; id: string }
  | { type: "opacity"; id: string; opacity: number }
  | { type: "time-window"; id: string; from: string; to: string }
  | { type: "title"; id: string; title: string }
  | { type: "reorder"; id: string; from: number; to: number };

export type RegistryListener = (e: RegistryEvent) => void;

interface LayerState {
  descriptor: LayerDescriptor;
  enabled: boolean;
}

export class LayerRegistry {
  private layers = new Map<string, LayerState>();
  private listeners = new Set<RegistryListener>();

  register(layer: LayerDescriptor): void {
    if (!isLayerDescriptor(layer)) {
      throw new TypeError(
        `LayerRegistry.register: invalid descriptor (id=${(layer as { id?: unknown }).id ?? "?"})`,
      );
    }
    if (this.layers.has(layer.id)) {
      throw new Error(`LayerRegistry: duplicate id "${layer.id}"`);
    }
    this.layers.set(layer.id, {
      descriptor: layer,
      enabled: layer.visibleByDefault,
    });
    this.emit({ type: "register", layer });
  }

  unregister(id: string): void {
    if (!this.layers.delete(id)) return;
    this.emit({ type: "unregister", id });
  }

  enable(id: string): void {
    const s = this.require(id);
    if (s.enabled) return;
    s.enabled = true;
    this.emit({ type: "enable", id });
  }

  disable(id: string): void {
    const s = this.require(id);
    if (!s.enabled) return;
    s.enabled = false;
    this.emit({ type: "disable", id });
  }

  setOpacity(id: string, opacity: number): void {
    if (opacity < 0 || opacity > 1 || Number.isNaN(opacity)) {
      throw new RangeError(`opacity must be in [0,1], got ${opacity}`);
    }
    const s = this.require(id);
    s.descriptor = { ...s.descriptor, opacity };
    this.emit({ type: "opacity", id, opacity });
  }

  /** D75: rename a layer (the inline rename writes the first mapped id's
   *  title so the Data sources tab agrees with the Map layers row). */
  setTitle(id: string, title: string): void {
    const s = this.require(id);
    const v = title.trim();
    if (!v || v === s.descriptor.title) return;
    s.descriptor = { ...s.descriptor, title: v };
    this.emit({ type: "title", id, title: v });
  }

  setTimeWindow(id: string, from: string, to: string): void {
    const s = this.require(id);
    s.descriptor = {
      ...s.descriptor,
      time: { ...s.descriptor.time, from, to },
    };
    this.emit({ type: "time-window", id, from, to });
  }

  list(): readonly LayerDescriptor[] {
    return [...this.layers.values()].map((s) => s.descriptor);
  }

  /** Move one layer's stacking position (D77: the list order IS the draw
   *  order). `to` is the new index in `list()`; out-of-range is clamped.
   *  Reorders the internal Map (insertion order = list order) and emits. */
  reorder(id: string, to: number): void {
    const idx = [...this.layers.keys()].indexOf(id);
    if (idx < 0) throw new Error(`LayerRegistry: unknown id "${id}"`);
    const entries = [...this.layers.entries()];
    const [entry] = entries.splice(idx, 1);
    const clamped = Math.max(0, Math.min(entries.length, to));
    entries.splice(clamped, 0, entry!);
    this.layers = new Map(entries);
    this.emit({ type: "reorder", id, from: idx, to: clamped });
  }

  get(id: string): LayerDescriptor | undefined {
    return this.layers.get(id)?.descriptor;
  }

  isEnabled(id: string): boolean {
    return this.layers.get(id)?.enabled ?? false;
  }

  subscribe(fn: RegistryListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private require(id: string): LayerState {
    const s = this.layers.get(id);
    if (!s) throw new Error(`LayerRegistry: unknown id "${id}"`);
    return s;
  }

  private emit(e: RegistryEvent): void {
    for (const l of this.listeners) l(e);
  }
}
