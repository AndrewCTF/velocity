import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Cesium from "cesium";
import {
  useLayerStyles,
  opacityMul,
  scaleMul,
  tintOf,
} from "./layerStyleStore.js";
import { PrimitiveEntityLayer } from "../globe/adapters/PrimitiveEntityLayer.js";

const LAYER = "places.ports";

function fakeScene(): Cesium.Scene {
  return {
    primitives: { add: vi.fn(), remove: vi.fn() },
    requestRender: vi.fn(),
    frameState: { mode: Cesium.SceneMode.SCENE3D },
  } as unknown as Cesium.Scene;
}

beforeEach(() => {
  localStorage.clear();
  useLayerStyles.setState({ overrides: {} });
});

describe("layerStyleStore", () => {
  it("persists overrides and clamps malformed values", () => {
    useLayerStyles.getState().setOverride(LAYER, { scale: 1.5 });
    useLayerStyles.getState().setOverride(LAYER, { opacity: 0.4 });
    const saved = JSON.parse(
      localStorage.getItem("velocity.layerStyles.v1") ?? "{}",
    ) as Record<string, unknown>;
    expect(saved[LAYER]).toEqual({ scale: 1.5, opacity: 0.4 });
    expect(scaleMul(LAYER)).toBe(1.5);
    expect(opacityMul(LAYER)).toBe(0.4);

    useLayerStyles.getState().setOverride(LAYER, { scale: 9, color: "red" });
    expect(scaleMul(LAYER)).toBe(2);
    expect(tintOf(LAYER)).toBeNull();
    expect(scaleMul("__proto__")).toBe(1);

    useLayerStyles.getState().reset(LAYER);
    expect(useLayerStyles.getState().overrides[LAYER]).toBeUndefined();
    expect(opacityMul(LAYER)).toBe(1);
  });

  it("restyles an existing icon in place when the override changes", () => {
    const layer = new PrimitiveEntityLayer(fakeScene(), {
      layerId: LAYER,
      styleFn: () => ({ imageUri: "data:image/svg+xml,x", scale: 0.8 }),
      labelFn: () => null,
      billboardBase: () => ({}),
      labelBase: (text) => ({ text, position: Cesium.Cartesian3.ZERO }),
      getClock: () => Cesium.JulianDate.now(),
    });
    const e = new Cesium.Entity({
      id: "port-1",
      position: Cesium.Cartesian3.fromDegrees(10, 50),
    });
    layer.sync(e, {});
    const bb = (
      layer as unknown as { prims: Map<string, { bb: Cesium.Billboard }> }
    ).prims.get("port-1")!.bb;
    expect(bb.scale).toBeCloseTo(0.8);
    expect(bb.color.equals(Cesium.Color.WHITE)).toBe(true);

    useLayerStyles
      .getState()
      .setOverride(LAYER, { scale: 2, color: "#ff0000" });
    // Same billboard object: upserted, not removed and re-added.
    const prims = (
      layer as unknown as { prims: Map<string, { bb: Cesium.Billboard }> }
    ).prims;
    expect(prims.get("port-1")!.bb).toBe(bb);
    expect(bb.scale).toBeCloseTo(1.6);
    expect(bb.color.red).toBeCloseTo(1);
    expect(bb.color.green).toBeCloseTo(0);

    useLayerStyles.getState().reset(LAYER);
    expect(bb.scale).toBeCloseTo(0.8);
    expect(bb.color.equals(Cesium.Color.WHITE)).toBe(true);
    layer.destroy();
  });
});
