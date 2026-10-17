// Replay must hide the live primitive layers, including one that registers
// after the replay started (a rewind link opens replay before layers load).
import { afterEach, describe, expect, it } from "vitest";
import {
  liveHidden,
  registerLiveLayer,
  setLiveLayersHidden,
} from "./liveVisibility.js";

function layer(): { hidden: boolean | null; setLiveHidden(h: boolean): void } {
  return {
    hidden: null,
    setLiveHidden(h) {
      this.hidden = h;
    },
  };
}

afterEach(() => setLiveLayersHidden(false));

describe("liveVisibility", () => {
  it("hides and restores every registered layer", () => {
    const a = layer();
    const off = registerLiveLayer(a);
    setLiveLayersHidden(true);
    expect(a.hidden).toBe(true);
    expect(liveHidden()).toBe(true);
    setLiveLayersHidden(false);
    expect(a.hidden).toBe(false);
    off();
  });

  it("hides a layer that registers while replay is already on", () => {
    setLiveLayersHidden(true);
    const late = layer();
    const off = registerLiveLayer(late);
    expect(late.hidden).toBe(true);
    off();
  });

  it("stops touching a layer once it unregisters", () => {
    const a = layer();
    registerLiveLayer(a)();
    setLiveLayersHidden(true);
    expect(a.hidden).toBeNull();
  });
});
