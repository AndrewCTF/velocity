import { describe, it, expect } from "vitest";
import * as Cesium from "cesium";
import { refreshBagInPlace } from "./PollGeoJsonAdapter.js";

// The §5.3.1 push diet replaced `entity.properties = new PropertyBag(props)` per
// contact per push with in-place value swaps. The 2026-06-30 guardrail requires
// the bag's VALUES to stay live (a silent break froze "Last seen"). This proves
// getValue() reflects an in-place refresh — and that new keys are added.
describe("refreshBagInPlace", () => {
  it("updates existing values in place so getValue() stays fresh", () => {
    const bag = new Cesium.PropertyBag({ seen_pos_s: 1, callsign: "AAL1" });
    const before = bag.getValue(Cesium.JulianDate.now());
    expect(before.seen_pos_s).toBe(1);

    refreshBagInPlace(bag, { seen_pos_s: 9, callsign: "AAL1" });
    const after = bag.getValue(Cesium.JulianDate.now());
    expect(after.seen_pos_s).toBe(9); // freshness counter advanced
    expect(after.callsign).toBe("AAL1"); // static field intact
  });

  it("adds a key that was absent from the original bag", () => {
    const bag = new Cesium.PropertyBag({ a: 1 });
    refreshBagInPlace(bag, { a: 1, b: 2 });
    const v = bag.getValue(Cesium.JulianDate.now());
    expect(v.b).toBe(2);
  });

  it("leaves keys absent from the new props untouched (additive/overwrite, not replace)", () => {
    // Characterization guard: refresh does NOT prune keys missing from the new
    // frame — a previously-seen field survives a partial update. If this ever
    // changes to replace-semantics, the change should be deliberate and reviewed.
    const bag = new Cesium.PropertyBag({ callsign: "AAL1", squawk: "1200" });
    refreshBagInPlace(bag, { callsign: "AAL2" }); // no squawk this frame
    const v = bag.getValue(Cesium.JulianDate.now());
    expect(v.callsign).toBe("AAL2"); // updated
    expect(v.squawk).toBe("1200"); // retained, not dropped
  });

  it("is idempotent — re-applying identical props leaves the value stable", () => {
    const bag = new Cesium.PropertyBag({ seen_pos_s: 3 });
    refreshBagInPlace(bag, { seen_pos_s: 7 });
    refreshBagInPlace(bag, { seen_pos_s: 7 });
    expect(bag.getValue(Cesium.JulianDate.now()).seen_pos_s).toBe(7);
  });

  it("swaps a value to a different type in place (no stale ConstantProperty)", () => {
    const bag = new Cesium.PropertyBag({ alt: 30000 });
    refreshBagInPlace(bag, { alt: "ground" });
    expect(bag.getValue(Cesium.JulianDate.now()).alt).toBe("ground");
  });
});
