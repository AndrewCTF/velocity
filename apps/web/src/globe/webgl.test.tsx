import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasWebGL2 } from "./webgl.js";
import { NoWebGL, RequireWebGL2 } from "./NoWebGL.js";

// A device that cannot give the globe a WebGL 2 context used to land in the
// generic "globe" error boundary: a panel that "stopped rendering", with no
// cause and no way out. These pin the probe, the message, and that the globe
// is only ever rendered behind the probe.

// jsdom answers getContext with a "not implemented" error on the virtual
// console, so every case replaces it.
function stubGetContext(impl: (type: string) => unknown) {
  return vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(impl as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hasWebGL2", () => {
  it("is true when the browser hands back a webgl2 context", () => {
    const spy = stubGetContext((type) =>
      type === "webgl2" ? { getExtension: () => null } : null,
    );
    expect(hasWebGL2()).toBe(true);
    expect(spy).toHaveBeenCalledWith("webgl2");
  });

  it("is false when getContext returns null (acceleration off, blocklisted GPU, --disable-3d-apis)", () => {
    stubGetContext(() => null);
    expect(hasWebGL2()).toBe(false);
  });

  it("is false when getContext throws", () => {
    stubGetContext(() => {
      throw new Error("blocked by policy");
    });
    expect(hasWebGL2()).toBe(false);
  });

  it("only ever asks for webgl2, because Cesium does not fall back to WebGL 1 once the class exists", () => {
    const spy = stubGetContext(() => null);
    hasWebGL2();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) expect(call[0]).toBe("webgl2");
  });

  it("gives the probe context back instead of leaving it to the garbage collector", () => {
    const loseContext = vi.fn();
    stubGetContext(() => ({
      getExtension: (name: string) =>
        name === "WEBGL_lose_context" ? { loseContext } : null,
    }));
    expect(hasWebGL2()).toBe(true);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("still answers yes when the probe context will not release", () => {
    stubGetContext(() => ({
      getExtension: () => {
        throw new Error("context already lost");
      },
    }));
    expect(hasWebGL2()).toBe(true);
  });
});

describe("NoWebGL", () => {
  it("says what the map needs and why it is missing", () => {
    render(<NoWebGL />);
    expect(
      screen.getByText(
        "This map needs WebGL 2, which this browser or device has turned off or does not support.",
      ),
    ).toBeInTheDocument();
  });

  it("gives one thing to try", () => {
    render(<NoWebGL />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /another browser, or turn on hardware acceleration/,
    );
  });

  it("carries no em dash (dashboard copy rule, apps/web/CLAUDE.md)", () => {
    render(<NoWebGL />);
    expect(screen.getByRole("alert").textContent).not.toContain("—");
  });
});

describe("RequireWebGL2", () => {
  it("renders the globe where WebGL 2 is available", () => {
    stubGetContext(() => ({ getExtension: () => null }));
    render(
      <RequireWebGL2>
        <div>the-globe</div>
      </RequireWebGL2>,
    );
    expect(screen.getByText("the-globe")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the message and never mounts the globe where it is not", () => {
    stubGetContext(() => null);
    const mounted = vi.fn();
    function Globe(): JSX.Element {
      mounted();
      return <div>the-globe</div>;
    }
    render(
      <RequireWebGL2>
        <Globe />
      </RequireWebGL2>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/needs WebGL 2/);
    expect(screen.queryByText("the-globe")).not.toBeInTheDocument();
    expect(mounted).not.toHaveBeenCalled();
  });

  it("probes once per mount, not once per render (each probe is a GL context)", () => {
    const spy = stubGetContext(() => ({ getExtension: () => null }));
    const { rerender } = render(
      <RequireWebGL2>
        <div>a</div>
      </RequireWebGL2>,
    );
    rerender(
      <RequireWebGL2>
        <div>b</div>
      </RequireWebGL2>,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// The gate is only worth anything while every place that renders the globe sits
// behind it. A second <GlobeCanvas> added next to the first would walk around
// it and land back in the error boundary.
describe("the globe is rendered behind the gate", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(p);
    }
    return out;
  }

  it("App.tsx is the only render site and wraps it in RequireWebGL2", () => {
    const sites = walk(SRC).filter((f) =>
      readFileSync(f, "utf8").includes("<GlobeCanvas"),
    );
    expect(sites.map((f) => relative(SRC, f))).toEqual(["App.tsx"]);
    expect(readFileSync(join(SRC, "App.tsx"), "utf8")).toMatch(
      /<RequireWebGL2>\s*<GlobeCanvas[\s\S]*?\/>\s*<\/RequireWebGL2>/,
    );
  });
});
