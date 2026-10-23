// Settings · Map defaults: a saved home view persists and is where the
// zoom-out / reset-view action (flyToGlobal) actually flies.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Cesium from "cesium";

vi.mock("../transport/http.js", () => ({ apiFetch: vi.fn() }));

import { MapDefaults } from "./SettingsModal.js";
import { useSettings } from "../state/settings.js";
import { flyToGlobal } from "../globe/camera.js";

function fakeViewer() {
  const flyTo = vi.fn();
  const viewer = {
    camera: { flyTo, frustum: { fov: Cesium.Math.toRadians(60) } },
    canvas: { clientWidth: 1200, clientHeight: 800, width: 1200, height: 800 },
  } as unknown as Cesium.Viewer;
  return { viewer, flyTo };
}

describe("Map defaults home view", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettings.getState().set("homeView", null);
  });

  it("saves a home view that flyToGlobal honours, and clears back to the globe", () => {
    render(<MapDefaults />);
    const save = screen.getByRole("button", { name: "Save home view" });
    fireEvent.change(screen.getByLabelText("Longitude"), {
      target: { value: "56.3" },
    });
    fireEvent.change(screen.getByLabelText("Latitude"), {
      target: { value: "26.6" },
    });
    fireEvent.change(screen.getByLabelText("Height (km)"), {
      target: { value: "500" },
    });
    fireEvent.click(save);
    expect(useSettings.getState().homeView).toEqual({
      lon: 56.3,
      lat: 26.6,
      height: 500_000,
    });
    expect(localStorage.getItem("velocity.settings")).toContain("56.3");

    const { viewer, flyTo } = fakeViewer();
    flyToGlobal(viewer);
    const dest = (flyTo.mock.calls[0]![0] as { destination: Cesium.Cartesian3 })
      .destination;
    const c = Cesium.Cartographic.fromCartesian(dest);
    expect(Cesium.Math.toDegrees(c.longitude)).toBeCloseTo(56.3, 5);
    expect(Cesium.Math.toDegrees(c.latitude)).toBeCloseTo(26.6, 5);
    expect(c.height).toBeCloseTo(500_000, 0);

    fireEvent.click(screen.getByRole("button", { name: "Use whole globe" }));
    expect(useSettings.getState().homeView).toBeNull();
    flyToGlobal(viewer);
    const d2 = Cesium.Cartographic.fromCartesian(
      (flyTo.mock.calls[1]![0] as { destination: Cesium.Cartesian3 })
        .destination,
    );
    expect(Cesium.Math.toDegrees(d2.longitude)).toBeCloseTo(20, 5);
  });

  it("refuses an out-of-range home view", () => {
    render(<MapDefaults />);
    fireEvent.change(screen.getByLabelText("Longitude"), {
      target: { value: "200" },
    });
    fireEvent.change(screen.getByLabelText("Latitude"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("Height (km)"), {
      target: { value: "100" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Save home view",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/Longitude runs -180 to 180/)).toBeTruthy();
  });
});
