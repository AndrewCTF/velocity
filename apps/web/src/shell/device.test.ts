// isMobileDevice() gates the phone data budget (viewport aircraft, no world
// socket, entity caps). It keys on touch-only input, not width: a landscape
// tablet is wider than 1024 px and still needs the budget.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMobileDevice } from "./device.js";

function stubMedia(matching: (q: string) => boolean): void {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: matching(q) }));
}

afterEach(() => vi.unstubAllGlobals());

describe("isMobileDevice", () => {
  it("is true for a touch-only device at tablet-landscape width", () => {
    stubMedia((q) => q === "(pointer: coarse) and (hover: none)");
    expect(isMobileDevice()).toBe(true);
  });

  it("is false for a touchscreen laptop whose primary pointer hovers", () => {
    stubMedia((q) => q === "(any-pointer: coarse)");
    expect(isMobileDevice()).toBe(false);
  });
});
