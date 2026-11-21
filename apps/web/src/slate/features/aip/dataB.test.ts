import { describe, expect, it } from "vitest";
import {
  age,
  axis,
  busiest,
  clock,
  devices,
  dur,
  ell,
  groups,
  mgrs,
  nicNames,
  nodash,
  watchItems,
  type Host,
  type Src,
} from "./dataB.js";

const host: Host = {
  taken: 0,
  uptime_s: 100,
  cpu: { model: "AMD Ryzen 9 9950X3D 16-Core Processor", threads: 32 },
  loadavg: [8, 8, 8],
  mem_mb: { total: 124026, used: 60000 },
  root: { size: 100, used: 50 },
  hwmon: [
    { chip: "nvme", temps: { Composite: 30 } },
    { chip: "nvme", temps: { Composite: 40 } },
    { chip: "k10temp", temps: { Tctl: 75.5, Tccd1: 50, Tccd2: 60 } },
    { chip: "spd5118", temps: { temp1_input: 50 } },
  ],
  gpu: {
    name: "NVIDIA GeForce RTX 5090",
    temp_c: 40,
    power_w: 47.6,
    power_limit_w: 400,
  },
  disks: [
    { name: "nvme0n1", bytes: 1.024e12, model: null },
    { name: "sda", bytes: 1.0e12, model: null },
  ],
  net: {
    lo: { oper: "unknown", speed_mbps: null, rx_bytes: 0, tx_bytes: 0 },
    "br-1": { oper: "down", speed_mbps: null, rx_bytes: 0, tx_bytes: 0 },
    enp8s0: { oper: "up", speed_mbps: 1000, rx_bytes: 1, tx_bytes: 1 },
    docker0: { oper: "down", speed_mbps: null, rx_bytes: 0, tx_bytes: 0 },
    proton0: { oper: "unknown", speed_mbps: 10000, rx_bytes: 0, tx_bytes: 0 },
  },
  listening: { "8000": { pid: 7, etimes: 90061, rss_mb: 10 } },
};

describe("AIP part-B derivations (ported from _build_features_b.py)", () => {
  it("formats ages and durations as the builder does", () => {
    expect([age(59), age(61), age(7200), age(200000)]).toEqual([
      "59 seconds",
      "1 minute",
      "2 hours",
      "2 days",
    ]);
    expect(dur(90061)).toBe("1 day 1 hour 1 minute");
    expect(dur(120)).toBe("2 minutes");
    expect(clock(3723)).toBe("01:02:03");
    expect(nodash("AIS vessels — keyless")).toBe("AIS vessels - keyless");
  });

  it("MGRS carries the builder's format", () => {
    expect(mgrs(26.5, 56.3)).toMatch(/^40R[A-Z]{2} \d{5} \d{5}$/);
  });

  it("usage axis steps 1/2/5 and keeps the busiest hosts", () => {
    expect(axis(2690)).toEqual({ step: 1000, top: 3000 });
    expect(axis(7000)).toEqual({ step: 2000, top: 8000 });
    expect(axis(90)).toEqual({ step: 50, top: 100 });
    const src = [3, 9, 1].map(
      (ok, i) => ({ host: `h${i}`, ok, fail: 0 }) as Src,
    );
    expect(busiest(src, 2).map((x) => x.host)).toEqual(["h1", "h0"]);
  });

  it("2-sigma ellipse of a track along one axis", () => {
    const e = ell([
      [56, 26],
      [56.1, 26],
      [56.2, 26],
    ]);
    expect(e[0]).toBeCloseTo(56.1);
    expect(e[2]).toBeGreaterThan(e[3]);
    expect(Math.abs(e[4])).toBeLessThan(1);
  });

  it("devices: CPU, GPU, memory, disks, NICs without loopback or bridges", () => {
    expect(nicNames(host)).toEqual(["enp8s0", "proton0", "docker0"]);
    const d = devices(host);
    expect(d.map((x) => x.name)).toEqual([
      "AMD Ryzen 9 9950X3D",
      "NVIDIA GeForce RTX 5090",
      "System memory",
      "nvme0n1",
      "sda",
      "enp8s0",
      "proton0",
      "docker0",
    ]);
    expect(d.find((x) => x.name === "docker0")).toMatchObject({
      st: "Offline",
      extra: "link down",
    });
    expect(d.find((x) => x.name === "proton0")!.extra).toBe("10 Gb/s");
    expect(d.find((x) => x.name === "nvme0n1")).toMatchObject({
      extra: "1.0 TB",
      t: 30,
    });
  });

  it("software groups count what is not listening", () => {
    const g = groups(
      host,
      [
        { name: "a", status: "green" },
        { name: "b", status: "unknown" },
      ],
      [{ state: "failing", ok: 0 } as Src],
      null,
      true,
      { git_sha: "x", stores: { ontology: 1, audit: 1 } },
    );
    expect(g[0]).toMatchObject({
      name: "API and ingest",
      bad: 1,
      sub: "Tile process :8001 is not listening",
    });
    expect(g[1]).toMatchObject({
      name: "ADS-B sidecar",
      bad: 1,
      ps: "Process offline",
    });
    expect(g.find((x) => x.name === "Feeds")).toMatchObject({
      bad: 1,
      sub: "0 degraded, 1 not yet fetched",
    });
    expect(g.find((x) => x.name === "Data stores")!.tot).toBe(2);
  });

  it("watch items follow watch_items.py's rules", () => {
    const items = watchItems({
      sar: [
        {
          summary: { date: "2026-10-22", label: "Strait of Hormuz" },
          features: [
            {
              id: "sar:hormuz:0:2290",
              geometry: { type: "Point", coordinates: [56.3, 26.5] },
              properties: {
                darkCandidate: true,
                plausibleVessel: true,
                lengthM: 48.2,
              },
            },
            {
              id: "sar:hormuz:0:11",
              geometry: { type: "Point", coordinates: [56.3, 26.5] },
              properties: {
                darkCandidate: false,
                plausibleVessel: true,
                lengthM: 80,
              },
            },
          ],
        },
      ] as never,
      choke: {
        features: [
          {
            geometry: { type: "Point", coordinates: [56.3, 26.6] },
            properties: {
              name: "Strait of Hormuz",
              vessels: 132,
              stationary: 65,
              congestion: "high",
            },
          },
        ],
      },
      jam: {
        features: [
          {
            id: "jam:-108:35",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [40, 20],
                  [41, 20],
                ],
              ],
            },
            properties: { percent_bad: 25 },
          },
        ],
      },
      quake: {
        features: [
          {
            geometry: { type: "Point", coordinates: [-71, -31] },
            properties: {
              mag: 3,
              place: "CHILE",
              time: "2026-10-23T05:16:42Z",
              source_id: "x0073",
            },
          },
        ],
      },
      warn: null,
      sanc: {
        features: [
          {
            geometry: { type: "Point", coordinates: [56, 26] },
            properties: {
              mmsi: 9973 * 2 + 5,
              name: "X",
              sog: 0.2,
              shipType: 80,
              t: 1,
            },
          },
        ],
      },
      now: 2e9,
    });
    expect(items.find((i) => i.kind === "sar")).toMatchObject({
      id: "SR2290",
      title: "SAR hull 48 m, no AIS",
      link: "Sentinel-1 · Strait of Hormuz",
    });
    expect(items.filter((i) => i.kind === "sar")).toHaveLength(1);
    expect(items.find((i) => i.kind === "choke")!.title).toBe(
      "Strait of Hormuz: 65 of 132 stationary",
    );
    expect(items.find((i) => i.kind === "jam")).toMatchObject({
      id: "GJ0835",
      title: "GPS jamming, 25% bad NACp",
    });
    expect(items.some((i) => i.kind === "quake")).toBe(false); // outside the region
    expect(items.find((i) => i.kind === "ofac")).toMatchObject({
      id: "OF0005",
      title: "Registry-listed tanker at anchor",
    });
  });
});
