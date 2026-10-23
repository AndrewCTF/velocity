// Small geodesy for the watch workspace: great-circle distance, a destination
// point (ring vertices), MGRS for the 10-line message, and the clock formats
// the reference page prints.

const R_KM = 6371.0088;
const RAD = Math.PI / 180;

/** Great-circle distance in nautical miles. */
export function distNm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return (2 * R_KM * Math.asin(Math.sqrt(a))) / 1.852;
}

/** The point `nm` nautical miles from (lat, lon) on bearing `brgDeg`. */
export function destination(
  lat: number,
  lon: number,
  brgDeg: number,
  nm: number,
): [number, number] {
  const d = (nm * 1.852) / R_KM;
  const b = brgDeg * RAD;
  const p1 = lat * RAD;
  const l1 = lon * RAD;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return [p2 / RAD, (((l2 / RAD + 540) % 360) - 180) as number];
}

/** WGS84 lat/lon to MGRS at 1 m (standard UTM series + 100 km letters). */
export function mgrs(lat: number, lon: number): string {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * RAD;
  const phi = lat * RAD;
  const lam = lon * RAD;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2;
  const C = ep2 * Math.cos(phi) ** 2;
  const A = (lam - lon0) * Math.cos(phi);
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) *
        Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const E =
    k0 *
      N *
      (A +
        ((1 - T + C) * A ** 3) / 6 +
        ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) +
    500000;
  let Nn =
    k0 *
    (M +
      N *
        Math.tan(phi) *
        (A ** 2 / 2 +
          ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 +
          ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) Nn += 10000000;
  const bands = "CDEFGHJKLMNPQRSTUVWX";
  const band = bands[Math.min(Math.floor((lat + 80) / 8), 19)];
  const colL = "ABCDEFGHJKLMNPQRSTUVWXYZ"[
    (((zone - 1) % 3) * 8 + Math.floor(E / 100000) - 1) % 24
  ];
  const rowL = "ABCDEFGHJKLMNPQRSTUV"[
    (Math.floor(Nn / 100000) + (zone % 2 === 0 ? 5 : 0)) % 20
  ];
  const pad = (n: number): string => String(Math.floor(n)).padStart(5, "0");
  return `${zone}${band} ${colL}${rowL} ${pad(E % 100000)} ${pad(Nn % 100000)}`;
}

const MON = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const p2 = (n: number): string => String(n).padStart(2, "0");

/** `OCT 22 2026` (UTC). */
export function zDate(ms: number): string {
  const d = new Date(ms);
  return `${MON[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${d.getUTCFullYear()}`;
}
/** `14:47` or `14:47:51` (UTC), no zone letter. */
export function zClock(ms: number, secs = true): string {
  const d = new Date(ms);
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return secs ? `${hm}:${p2(d.getUTCSeconds())}` : hm;
}
/** `36m 22s`; hours when it runs over. */
export function hms(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "N/A";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h ${p2(m)}m` : `${m}m ${p2(s)}s`;
}
/** `7 minutes from now`, `2 hours ago`. */
export function rel(ms: number, now: number): string {
  const d = Math.round((ms - now) / 1000);
  const a = Math.abs(d);
  const [n, u] =
    a < 60
      ? [a, "second"]
      : a < 3600
        ? [Math.round(a / 60), "minute"]
        : a < 86400
          ? [Math.round(a / 3600), "hour"]
          : [Math.round(a / 86400), "day"];
  const s = `${n} ${u}${n === 1 ? "" : "s"}`;
  return d >= 0 ? `${s} from now` : `${s} ago`;
}
