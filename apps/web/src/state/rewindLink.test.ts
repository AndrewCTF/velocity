import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeRewind,
  isRewindId,
  parseRewind,
  type Rewind,
  type RewindCamera,
} from "./rewindLink.js";

// The fragment is an input anyone can hand the console, so most of this file is
// the parse refusing things: it must return null or drop the bad part, never
// throw, and never hand TimeDock a number outside the range it validated.

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const T = Date.UTC(2026, 9, 17, 9, 30, 0);
const MIN_T = Date.UTC(2020, 0, 1);
const HOUR = 3_600_000;

const CAM: RewindCamera = {
  lon: 2.35,
  lat: 48.85,
  height: 12_000,
  heading: 90,
  pitch: -45,
};
const C = "c=2.35,48.85,12000,90,-45";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("encodeRewind", () => {
  it("writes the documented format: camera, then selection, then time", () => {
    expect(encodeRewind({ c: CAM, sel: "aircraft:ABC123", t: T })).toBe(
      `#${C}&sel=aircraft:ABC123&t=${T}`,
    );
  });

  it("writes the camera alone for a live link with nothing selected", () => {
    expect(encodeRewind({ c: CAM })).toBe(`#${C}`);
    expect(encodeRewind({ c: CAM, sel: undefined, t: undefined })).toBe(
      `#${C}`,
    );
  });

  it("rounds to a metre, a tenth of a degree and whole metres of height", () => {
    expect(
      encodeRewind({
        c: {
          lon: 2.123456789,
          lat: -48.000004,
          height: 12_000.6,
          heading: 90.04,
          pitch: -44.96,
        },
      }),
    ).toBe("#c=2.12346,-48,12001,90,-45");
  });

  it("clamps what Cesium could never report and wraps the heading", () => {
    const hash = encodeRewind({
      c: { lon: 400, lat: -95, height: 0.2, heading: -90, pitch: 120 },
    });
    expect(hash).toBe("#c=180,-90,1,270,90");
    expect(parseRewind(hash)).not.toBeNull();
  });

  it("keeps a heading that rounds up to a full turn inside the accepted range", () => {
    const hash = encodeRewind({ c: { ...CAM, heading: 359.96 } });
    expect(hash).toContain(",360,");
    expect(parseRewind(hash)?.c.heading).toBe(360);
    // A full turn exactly is north, written as 0.
    expect(encodeRewind({ c: { ...CAM, heading: 360 } })).toContain(",0,");
  });

  it("writes no link at all when the camera is not a number", () => {
    expect(encodeRewind({ c: { ...CAM, lon: NaN } })).toBe("");
    expect(encodeRewind({ c: { ...CAM, height: Infinity } })).toBe("");
    expect(encodeRewind({ c: { ...CAM, pitch: undefined as never } })).toBe("");
  });

  it("leaves out a selection the parse would refuse, instead of writing it", () => {
    for (const sel of [
      "landing:12.5,41.2", // comma
      "port:Port of Rotterdam", // spaces
      "https://x.test/a", // slash
      "<script>alert(1)</script>",
      "",
      "a".repeat(129),
    ])
      expect(encodeRewind({ c: CAM, sel })).toBe(`#${C}`);
    expect(encodeRewind({ c: CAM, sel: "a".repeat(128) })).toContain("&sel=");
  });

  it("leaves out a time outside the window parse would accept", () => {
    for (const t of [MIN_T - 1, NOW + HOUR + 1, NaN, Infinity, -5])
      expect(encodeRewind({ c: CAM, t })).toBe(`#${C}`);
    // Whole milliseconds only.
    expect(encodeRewind({ c: CAM, t: T + 0.9 })).toBe(`#${C}&t=${T}`);
  });
});

describe("parseRewind", () => {
  it("round-trips every part", () => {
    const r: Rewind = { c: CAM, sel: "vessel:244630123", t: T };
    expect(parseRewind(encodeRewind(r))).toEqual(r);
  });

  it("survives a trip through a real URL, where : and , are not escaped", () => {
    const hash = encodeRewind({ c: CAM, sel: "aircraft:ABC123", t: T });
    const url = new URL(`https://velocity.test/app/?x=1${hash}`);
    expect(url.search).toBe("?x=1");
    expect(parseRewind(url.hash)).toEqual({
      c: CAM,
      sel: "aircraft:ABC123",
      t: T,
    });
  });

  it("accepts the hash with or without its leading #", () => {
    expect(parseRewind(`#${C}`)).toEqual({ c: CAM });
    expect(parseRewind(C)).toEqual({ c: CAM });
  });

  it("takes partial links: camera only, camera + selection, camera + time", () => {
    const camOnly = parseRewind(`#${C}`);
    expect(camOnly).toEqual({ c: CAM });
    expect(camOnly).not.toHaveProperty("sel");
    expect(camOnly).not.toHaveProperty("t");
    expect(parseRewind(`#${C}&sel=port:NLRTM`)).toEqual({
      c: CAM,
      sel: "port:NLRTM",
    });
    expect(parseRewind(`#${C}&t=${T}`)).toEqual({ c: CAM, t: T });
  });

  it("does not care what order the parts come in, or that they are percent-encoded", () => {
    expect(parseRewind(`#t=${T}&sel=aircraft%3AABC123&${C}`)).toEqual({
      c: CAM,
      sel: "aircraft:ABC123",
      t: T,
    });
    expect(parseRewind("#c=2.35%2C48.85%2C12000%2C90%2C-45")).toEqual({
      c: CAM,
    });
  });

  it("returns null for a hash that is not a rewind link", () => {
    for (const h of [
      "",
      "#",
      "#/route",
      "#section-2",
      // What an auth redirect leaves behind.
      "#access_token=abc.def.ghi&refresh_token=xyz&type=signup",
      // Valid selection and time, but no place to open.
      `#sel=aircraft:ABC123&t=${T}`,
      "#c=",
      "##c=2.35,48.85,12000,90,-45",
    ])
      expect(parseRewind(h), h).toBeNull();
  });

  it("voids the whole link when the camera is invalid", () => {
    const bad = [
      "NaN,NaN,NaN,NaN,NaN",
      "Infinity,0,1000,0,0",
      "1e999,0,1000,0,0", // exponent form is not a coordinate
      "0x10,0,1000,0,0",
      "2.35,48.85,1e4,90,-45",
      ",,,,",
      "2.35,48.85,12000,90", // 4 parts
      "2.35,48.85,12000,90,-45,0", // 6 parts
      "2.35,48.85,12000,90,", // empty last part
      " 2.35,48.85,12000,90,-45", // whitespace
      "+2.35,48.85,12000,90,-45", // explicit plus
      ".5,48.85,12000,90,-45", // no leading digit
      "181,0,1000,0,0", // lon
      "-180.0001,0,1000,0,0",
      "0,90.0001,1000,0,0", // lat
      "0,-91,1000,0,0",
      "0,0,0.99,0,0", // height
      "0,0,50000000.1,0,0",
      "0,0,-5,0,0",
      "0,0,1000,360.1,0", // heading
      "0,0,1000,-1,0",
      "0,0,1000,0,90.1", // pitch
      "0,0,1000,0,-90.1",
      // Finite, but absurd.
      `99999999999999999999999999999999999999,0,1000,0,0`,
      `${"9".repeat(400)},0,1000,0,0`, // Number() of this is Infinity
      `0,0,${"9".repeat(400)},0,0`,
    ];
    for (const c of bad) expect(parseRewind(`#c=${c}`), c).toBeNull();
  });

  it("accepts every boundary of the validated ranges", () => {
    expect(parseRewind("#c=-180,-90,1,0,-90")?.c).toEqual({
      lon: -180,
      lat: -90,
      height: 1,
      heading: 0,
      pitch: -90,
    });
    expect(parseRewind("#c=180,90,50000000,360,90")?.c).toEqual({
      lon: 180,
      lat: 90,
      height: 50_000_000,
      heading: 360,
      pitch: 90,
    });
  });

  it("refuses script tags wherever they are put", () => {
    for (const h of [
      "#c=<script>alert(1)</script>",
      "#c=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      `#c="><img src=x onerror=alert(1)>`,
      "#c=javascript:alert(1)",
    ])
      expect(parseRewind(h), h).toBeNull();

    // In `sel` and `t` the camera survives and the bad part is dropped.
    for (const sel of [
      "<script>alert(1)</script>",
      "%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      "%253Cscript%253E", // double-encoded: decodes once to a literal %3C
      "javascript:alert(1)",
      `"><img src=x onerror=alert(1)>`,
    ]) {
      const r = parseRewind(`#${C}&sel=${sel}&t=<script>`);
      expect(r, sel).toEqual({ c: CAM });
    }
  });

  describe("sel", () => {
    it("takes a plain id of up to 128 characters", () => {
      for (const sel of [
        "aircraft:ABC123",
        "quake:emsc:20261017_0000012",
        "satpos:12.3456:-45.6789",
        "a-b_c.d:e",
        "a".repeat(128),
      ])
        expect(parseRewind(`#${C}&sel=${sel}`)?.sel, sel).toBe(sel);
    });

    it("drops what falls outside the charset or the length", () => {
      // Written as they would sit in the URL, so the percent-decoding is part of
      // what is under test.
      for (const sel of [
        "",
        "a".repeat(129),
        "a%20b", // space
        "a%2Bb", // a literal +
        "a%2Cb",
        "a%2Fb",
        "..%2F..%2Fetc%2Fpasswd",
        "a%3Bb",
        "a%23b",
        "a%3Db",
        "a%2520b", // double-encoded: decodes once to a literal %20
        "aircraft:ABC%0A", // JS $ must not forgive a trailing newline
        "%EF%BD%81%EF%BD%82", // full-width letters
        "%C3%A9",
      ])
        expect(parseRewind(`#${C}&sel=${sel}`), sel).toEqual({ c: CAM });
      // Unencoded, + is a space in a query-style fragment.
      expect(parseRewind(`#${C}&sel=a+b`)).toEqual({ c: CAM });
    });

    it("accepts exactly A-Z a-z 0-9 : _ . - and nothing else", () => {
      // Every character through U+024F, sat between two letters and sent the way
      // a browser would encode it: a single stray allowed character is a hole.
      for (let cp = 0; cp <= 0x24f; cp++) {
        const ch = String.fromCharCode(cp);
        const want = /[A-Za-z0-9:_.-]/.test(ch);
        const r = parseRewind(`#${C}&sel=a${encodeURIComponent(ch)}b`);
        expect(r?.sel, `U+${cp.toString(16)}`).toBe(
          want ? `a${ch}b` : undefined,
        );
      }
      expect(isRewindId("<script>")).toBe(false);
      expect(parseRewind(`#${C}&sel=%3Cscript%3E`)).toEqual({ c: CAM });
    });

    it("takes the first of a repeated key", () => {
      expect(parseRewind(`#${C}&sel=port:A&sel=port:B`)?.sel).toBe("port:A");
    });
  });

  describe("t", () => {
    it("accepts the edges of [2020-01-01, now + 1h]", () => {
      expect(parseRewind(`#${C}&t=${MIN_T}`)?.t).toBe(MIN_T);
      expect(parseRewind(`#${C}&t=${NOW + HOUR}`)?.t).toBe(NOW + HOUR);
    });

    it("drops anything outside the window or not a whole number of milliseconds", () => {
      for (const t of [
        String(MIN_T - 1),
        String(NOW + HOUR + 1),
        "1760000000", // seconds, not milliseconds
        "0",
        "-1",
        "1.5e12",
        "1760000000000.5",
        "abc",
        "",
        " 1760000000000",
        "9".repeat(17), // too long to be a time, whatever it parses to
        "9".repeat(400),
        "NaN",
        "Infinity",
        "0x18A0B2C3D00",
      ]) {
        const r = parseRewind(`#${C}&t=${t}`);
        expect(r, t).toEqual({ c: CAM });
      }
    });
  });

  it("never throws, whatever it is given", () => {
    const hostile: unknown[] = [
      null,
      undefined,
      42,
      {},
      [],
      Symbol.iterator,
      "%",
      "#%",
      `#${C}&sel=%`,
      `#${C}&sel=%E0%A4%A`,
      `#${C}&sel=%FF%FE`,
      `#${C}&t=%`,
      "#c=%E0%A4%A",
      "\uD800",
      `#${C}&sel=\uD800`,
      "\u0000",
      `#${C}${"&x=1".repeat(5000)}`,
      "#" + "&".repeat(100_000),
    ];
    for (const h of hostile)
      expect(
        () => parseRewind(h as string),
        String(h).slice(0, 20),
      ).not.toThrow();
    // Too long to be a link at all.
    expect(parseRewind(`#${C}&sel=${"a".repeat(2000)}`)).toBeNull();
  });
});

// A seeded generator, so a failure here is reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("parseRewind and encodeRewind under random input", () => {
  it("returns only validated values from garbage built out of the link alphabet", () => {
    const alphabet = "#c=,&selt0123456789-.+%:<>_ae";
    const rand = rng(7);
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      let h = "";
      const len = Math.floor(rand() * 60);
      for (let j = 0; j < len; j++)
        h += alphabet.charAt(Math.floor(rand() * alphabet.length));
      // Half the time, start from something close to a real link.
      if (i % 2) h = `#${C}&sel=port:NLRTM&t=${T}` + h;
      const r = parseRewind(h);
      if (!r) continue;
      accepted++;
      expect(r.c.lon).toBeGreaterThanOrEqual(-180);
      expect(r.c.lon).toBeLessThanOrEqual(180);
      expect(r.c.lat).toBeGreaterThanOrEqual(-90);
      expect(r.c.lat).toBeLessThanOrEqual(90);
      expect(r.c.height).toBeGreaterThanOrEqual(1);
      expect(r.c.height).toBeLessThanOrEqual(5e7);
      expect(r.c.heading).toBeGreaterThanOrEqual(0);
      expect(r.c.heading).toBeLessThanOrEqual(360);
      expect(r.c.pitch).toBeGreaterThanOrEqual(-90);
      expect(r.c.pitch).toBeLessThanOrEqual(90);
      if (r.sel !== undefined) expect(isRewindId(r.sel)).toBe(true);
      if (r.t !== undefined) {
        expect(r.t).toBeGreaterThanOrEqual(MIN_T);
        expect(r.t).toBeLessThanOrEqual(NOW + HOUR);
      }
    }
    // The generator does reach the accept path, or the loop above proves nothing.
    expect(accepted).toBeGreaterThan(500);
  });

  it("encodes any finite camera into a link that parses back inside the range", () => {
    const rand = rng(11);
    const wide = (n: number): number => (rand() - 0.5) * n;
    for (let i = 0; i < 2000; i++) {
      const c: RewindCamera = {
        lon: wide(1000),
        lat: wide(400),
        height: wide(2e8),
        heading: wide(2000),
        pitch: wide(500),
      };
      const hash = encodeRewind({ c });
      const r = parseRewind(hash);
      expect(r, hash).not.toBeNull();
    }
  });

  it("round-trips in-range cameras to the precision it writes", () => {
    const rand = rng(13);
    for (let i = 0; i < 2000; i++) {
      const c: RewindCamera = {
        lon: (rand() - 0.5) * 360,
        lat: (rand() - 0.5) * 180,
        height: 1 + rand() * 4e7,
        heading: rand() * 360,
        pitch: (rand() - 0.5) * 180,
      };
      const back = parseRewind(encodeRewind({ c }))?.c;
      // Half of the last decimal written, plus float noise.
      expect(Math.abs((back?.lon ?? NaN) - c.lon)).toBeLessThanOrEqual(
        5e-6 + 1e-9,
      );
      expect(Math.abs((back?.lat ?? NaN) - c.lat)).toBeLessThanOrEqual(
        5e-6 + 1e-9,
      );
      expect(Math.abs((back?.height ?? NaN) - c.height)).toBeLessThanOrEqual(
        0.5 + 1e-9,
      );
      // Heading wraps at 360, so 359.96 and 0 are the same direction.
      const dh = Math.abs((back?.heading ?? NaN) - c.heading);
      expect(Math.min(dh, 360 - dh)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs((back?.pitch ?? NaN) - c.pitch)).toBeLessThanOrEqual(
        0.05 + 1e-9,
      );
    }
  });
});

describe("isRewindId", () => {
  it("matches what parseRewind keeps as a selection", () => {
    expect(isRewindId("aircraft:ABC123")).toBe(true);
    expect(isRewindId("")).toBe(false);
    expect(isRewindId("a b")).toBe(false);
    expect(isRewindId("a".repeat(128))).toBe(true);
    expect(isRewindId("a".repeat(129))).toBe(false);
    expect(isRewindId("landing:12.5,41.2")).toBe(false);
  });
});
