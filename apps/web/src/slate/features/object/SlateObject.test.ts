// Selection contract for the Slate object panel: port clicks from the
// main globe must resolve to a SlateObject id. The globe picks
// `picked.id.id` (GlobeCanvas ScreenSpaceEventHandler) and SlateShell
// renders SlateObject only when isSlateObject(selected) is true, so
// both halves of the click path share this predicate. This suite pins
// that a port id — the shape the backend emits (places.py bbox_features
// `port:{wpi}` / `port:{name}`) — is accepted while non-object ids are
// rejected, so a future regex edit cannot silently force port clicks
// back to the generic Selection panel.
import { describe, expect, it } from "vitest";
import { isSlateObject } from "./SlateObject.js";

describe("isSlateObject", () => {
  it("accepts port ids from the places.ports layer", () => {
    expect(isSlateObject("port:7950")).toBe(true);
    expect(isSlateObject("port:Rotterdam")).toBe(true);
    expect(isSlateObject("port:")).toBe(true);
  });

  it("still accepts vessel and aircraft ids", () => {
    expect(isSlateObject("vessel:356123456")).toBe(true);
    expect(isSlateObject("aircraft:a1b2c3")).toBe(true);
  });

  it("rejects non-object selections and null", () => {
    expect(isSlateObject(null)).toBe(false);
    expect(isSlateObject("airport:EGLL")).toBe(false);
    expect(isSlateObject("incident:42")).toBe(false);
    expect(isSlateObject("places.ports")).toBe(false);
    expect(isSlateObject("")).toBe(false);
  });
});
