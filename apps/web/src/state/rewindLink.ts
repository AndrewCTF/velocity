// Rewind link: a URL fragment that reopens the console at a place, a selected
// contact and a past moment, on any device.
//
//   #c=<lon>,<lat>,<heightM>,<headingDeg>,<pitchDeg>&sel=<entityId>&t=<epochMs>
//
// `c` is the only required part. `sel` and `t` are independent extras.
//
// Pure and DOM-free so the parse is testable without a viewer. The fragment
// arrives from a URL anyone can hand us, so parseRewind VALIDATES every part and
// never throws: a bad camera voids the whole link (without a place there is
// nothing to open), while a bad `sel` or `t` is dropped and the rest still
// applies. Out-of-range values are rejected, never clamped: clamping would open
// the console somewhere other than where the sender was looking.
//
// ponytail: `sel` takes the plain id charset only, so ids carrying a comma, a
// slash or a space (the `<layer>:<lon>,<lat>` fallback ids, some URL-shaped
// ids) cannot ride in a link and are left out of it. Widen SEL_RE together with
// the tests if those ever need to be shareable.

export interface RewindCamera {
  /** Degrees, -180..180. */
  lon: number;
  /** Degrees, -90..90. */
  lat: number;
  /** Metres above the ellipsoid, 1..5e7. */
  height: number;
  /** Degrees clockwise from north, 0..360. */
  heading: number;
  /** Degrees, -90 (straight down) .. 90. */
  pitch: number;
}

export interface Rewind {
  c: RewindCamera;
  /** Entity id to select. */
  sel?: string | undefined;
  /** Epoch milliseconds (UTC) to replay from. Omitted for a live link. */
  t?: number | undefined;
}

// key, min, max, decimals written. 5 decimals of a degree is about a metre; the
// angles do not need more than a tenth of a degree to look at the same scene.
const FIELDS = [
  ["lon", -180, 180, 5],
  ["lat", -90, 90, 5],
  ["height", 1, 5e7, 0],
  ["heading", 0, 360, 1],
  ["pitch", -90, 90, 1],
] as const;

const MIN_T = Date.UTC(2020, 0, 1);
// A sender whose clock runs a little fast is not a hostile link.
const T_SLACK_MS = 3_600_000;
// The longest honest link is ~220 characters; anything past this is not one.
const MAX_HASH = 1024;
const SEL_RE = /^[A-Za-z0-9:_.-]{1,128}$/;
// Plain decimals only. Number() alone accepts "", " ", "0x10", "1e3" and
// "Infinity", none of which belongs in a coordinate.
const NUM_RE = /^-?\d+(?:\.\d+)?$/;
const EPOCH_RE = /^\d{1,16}$/;

/** True when `id` can ride in a link's `sel` part. */
export function isRewindId(id: string): boolean {
  return SEL_RE.test(id);
}

function num(s: string | undefined): number | null {
  if (s === undefined || !NUM_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function inWindow(t: number): boolean {
  return t >= MIN_T && t <= Date.now() + T_SLACK_MS;
}

function parseCamera(raw: string | null): RewindCamera | null {
  const parts = raw?.split(",");
  if (parts?.length !== FIELDS.length) return null;
  const c: Partial<RewindCamera> = {};
  for (const [i, [key, lo, hi]] of FIELDS.entries()) {
    const n = num(parts[i]);
    if (n === null || n < lo || n > hi) return null;
    c[key] = n;
  }
  return c as RewindCamera;
}

/**
 * Read a rewind link out of `location.hash` (the leading `#` is optional).
 * Returns null when there is no valid camera. A malformed `sel` or `t` is
 * dropped from the result instead of failing the link. Never throws.
 */
export function parseRewind(hash: string): Rewind | null {
  try {
    if (typeof hash !== "string" || hash.length > MAX_HASH) return null;
    // URLSearchParams does the percent-decoding; the validators below run on
    // the DECODED value, so %3Cscript%3E is judged as the <script> it spells.
    const q = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const c = parseCamera(q.get("c"));
    if (!c) return null;
    const rewind: Rewind = { c };
    const sel = q.get("sel");
    if (sel !== null && SEL_RE.test(sel)) rewind.sel = sel;
    const raw = q.get("t");
    if (raw !== null && EPOCH_RE.test(raw) && inWindow(Number(raw)))
      rewind.t = Number(raw);
    return rewind;
  } catch {
    return null;
  }
}

/**
 * Build the fragment for a rewind link, `#` included. Whatever it writes,
 * parseRewind accepts: camera values are clamped into range (heading wraps), and
 * a `sel` or `t` that parseRewind would reject is left out rather than written.
 * Returns "" when the camera is not finite, since there is no link without a
 * place to open.
 */
export function encodeRewind(r: Rewind): string {
  const { c } = r;
  if (!FIELDS.every(([key]) => Number.isFinite(c[key]))) return "";
  const cam = FIELDS.map(([key, lo, hi, dp]) => {
    const v = key === "heading" ? ((c[key] % 360) + 360) % 360 : c[key];
    // Number() drops the trailing zeros toFixed pads and turns "-0.0" into 0.
    return String(Number(Math.min(hi, Math.max(lo, v)).toFixed(dp)));
  });
  let out = `#c=${cam.join(",")}`;
  if (r.sel !== undefined && SEL_RE.test(r.sel))
    // ":" is a legal fragment character and keeps the id readable; the rest of
    // the charset needs no escaping, so this is encodeURIComponent in practice.
    out += `&sel=${encodeURIComponent(r.sel).replace(/%3A/g, ":")}`;
  if (r.t !== undefined && Number.isFinite(r.t) && inWindow(Math.trunc(r.t)))
    out += `&t=${Math.trunc(r.t)}`;
  return out;
}
