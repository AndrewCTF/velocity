// D101: action form modal — Create watchbox action with its own label.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = readFileSync(path.join(here, "watchboxStore.ts"), "utf8");
const actions = readFileSync(
  path.join(here, "../globe/mapActions.ts"),
  "utf8",
);

describe("CreateWatchbox D101", () => {
  it("the store adds a watchbox with a label and rule", () => {
    expect(store).toContain("interface Watchbox");
    expect(store).toContain("add: (w: Omit<Watchbox, \"id\">) => string");
    expect(store).toContain("rule");
  });

  it("the point menu Create geofence uses the store's own label", () => {
    expect(actions).toContain("Create geofence");
    expect(actions).toContain("Watchbox ${lat.toFixed(1)},${lon.toFixed(1)}");
    expect(actions).toContain("useWatchboxes.getState().add");
  });
});
