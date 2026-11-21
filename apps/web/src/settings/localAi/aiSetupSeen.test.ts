import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasSeenAiSetup,
  markAiSetupSeen,
  shouldOfferAiSetup,
} from "./aiSetupSeen.js";

// The wizard reads the SERVER's GPU and offers a model download to the server's
// disk. A Pixel 7 first visit was shown a 22 GB download for a card the phone
// cannot see, so a touch device never offers it.

function stubMedia(matching: (q: string) => boolean): void {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: matching(q) }));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("shouldOfferAiSetup", () => {
  it("offers the wizard to a first visit from a desktop browser", () => {
    stubMedia(() => false);
    expect(shouldOfferAiSetup()).toBe(true);
  });

  it("never offers it on a touch-only device, seen or not", () => {
    stubMedia((q) => q === "(pointer: coarse) and (hover: none)");
    expect(hasSeenAiSetup()).toBe(false);
    expect(shouldOfferAiSetup()).toBe(false);
  });

  it("does not offer it twice on a desktop", () => {
    stubMedia(() => false);
    markAiSetupSeen();
    expect(shouldOfferAiSetup()).toBe(false);
  });
});
