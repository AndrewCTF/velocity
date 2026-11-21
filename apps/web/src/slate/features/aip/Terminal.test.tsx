// The native terminal: every rendered control runs, typed text survives a
// re-render, and the simulation row appears with its three actions.
import { describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("../../../transport/http.js", () => ({
  apiFetch: vi.fn(
    async () => new Response(JSON.stringify({ detail: "x" }), { status: 503 }),
  ),
}));
vi.mock("./lightHormuz.png", () => ({ default: "x.png" }));

import { Terminal } from "./Terminal.js";

describe("native AIP terminal", () => {
  it("wires every top-row control and keeps typed text", async () => {
    const calls: string[] = [];
    render(
      <Terminal
        onFoundry={() => calls.push("foundry")}
        onHub={() => calls.push("hub")}
        onInvestigate={() => calls.push("inv")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Investigations" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open the Foundry workspace" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^AI hub/ }));
    expect(calls).toEqual(["inv", "foundry", "hub"]);

    const box = screen.getByLabelText("Ask AIP") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "half typed" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Proposals: run a simulation" }),
    );
    expect((screen.getByLabelText("Ask AIP") as HTMLInputElement).value).toBe(
      "half typed",
    );
    for (const n of [
      "Propose these changes",
      "Run a new simulation",
      "Exit simulation mode",
    ])
      expect(screen.getByRole("button", { name: n })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Exit simulation mode" }),
    );
    expect(
      screen.queryByRole("button", { name: "Propose these changes" }),
    ).toBeNull();
    cleanup();
  });

  it("a chokepoint question opens the hand-off drawer and closes it", async () => {
    render(<Terminal onFoundry={() => {}} onHub={() => {}} />);
    const box = screen.getByLabelText("Ask AIP");
    fireEvent.change(box, { target: { value: "congestion at Hormuz" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Hand-off Inspector" }),
    );
    await waitFor(() => screen.getByLabelText("Hand-off inspector"));
    fireEvent.click(
      screen.getByRole("button", { name: "Close the hand-off inspector" }),
    );
    expect(screen.queryByLabelText("Hand-off inspector")).toBeNull();
    cleanup();
  });
});
