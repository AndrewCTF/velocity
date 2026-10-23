// Shared YOLO detection overlay — the box layer + class colours used by BOTH the
// ground PanoramaViewer and the live-cam CameraCard. Boxes are normalized 0..1
// (from the desktop CUDA sidecar, apps/desktop/sidecar/yolo_sidecar.py). One
// owner so the two surfaces stay visually identical.
import type { GroundDetection } from "./types.js";
import { dict } from "../shell/safeKeys.js";

// Literal hexes required — colorFor() output is also embedded in SVG data-URI
// billboards (globe/CaptureLayer.ts), where CSS var() cannot resolve. person
// and bus are aligned to the token palette (--alert / --accent in
// theme/tokens.css); the remaining classes are deliberate extended hues (the
// token palette has no orange/violet/teal/yellow) kept for distinguishability
// over video.
const CLS_COLOR: Record<string, string> = {
  person: "#ff5a52", // --alert
  car: "#facc15",
  truck: "#fb923c",
  bus: "#6fb1dd", // --accent
  motorcycle: "#a78bfa",
  bicycle: "#a78bfa",
  boat: "#5eead4",
  "traffic light": "#4ade80",
};

export function colorFor(cls: string): string {
  return CLS_COLOR[cls] ?? "#ffffff";
}

export function detCounts(dets: GroundDetection[]): [string, number][] {
  const acc = dict<number>();
  for (const d of dets) acc[d.cls] = (acc[d.cls] ?? 0) + 1;
  return Object.entries(acc).sort((a, b) => b[1] - a[1]);
}

// Two-letter unit codes for the reference's symbol swap (feature page G24).
const CLS_CODE: Record<string, string> = {
  person: "PR",
  car: "CR",
  truck: "TK",
  bus: "BS",
  motorcycle: "MC",
  bicycle: "BC",
  boat: "BT",
  "traffic light": "TL",
};
export function clsCode(cls: string): string {
  return CLS_CODE[cls] ?? cls.slice(0, 2).toUpperCase();
}

/** The reference's unit symbol: a red disc with a white rim, the hull glyph
 *  and a two-letter code (feature page G24, features-a.html 85-91). */
export function UnitSymbol({ code }: { code: string }): JSX.Element {
  return (
    <svg width={52} height={52} viewBox="-26 -26 52 52" aria-hidden>
      <circle r="24" fill="#d63a41" stroke="#fff" strokeWidth="2.4" />
      <path
        d="M-14 -3 H14 C13 8 7 14 0 17 C-7 14 -13 8 -14 -3Z"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
      />
      <rect
        x="-9"
        y="-12"
        width="18"
        height="11"
        rx="2"
        fill="#d63a41"
        stroke="#fff"
        strokeWidth="1.6"
      />
      <text
        x="0"
        y="-3.4"
        textAnchor="middle"
        fontSize="10"
        fontWeight="700"
        fill="#fff"
        fontFamily="Source Sans 3,sans-serif"
      >
        {code}
      </text>
    </svg>
  );
}

// The reference draws a detection as a 2 px #2dd4bf outline; with `symbols`
// the box holds the unit symbol at its centre instead of its label.
export function BboxOverlay({
  dets,
  symbols = false,
}: {
  dets: GroundDetection[];
  symbols?: boolean;
}): JSX.Element {
  return (
    <>
      {dets.map((d, i) => (
        <div
          key={`${d.id}-${i}`}
          style={{
            position: "absolute",
            left: `${d.bbox.x * 100}%`,
            top: `${d.bbox.y * 100}%`,
            width: `${d.bbox.w * 100}%`,
            height: `${d.bbox.h * 100}%`,
            border: "2px solid #2dd4bf",
            pointerEvents: "none",
          }}
        >
          {symbols ? (
            <span
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
              }}
            >
              <UnitSymbol code={clsCode(d.cls)} />
            </span>
          ) : (
            <span
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                fontSize: "8px",
                fontFamily: '"IBM Plex Mono", monospace',
                color: colorFor(d.cls),
                background: "rgba(0,0,0,0.6)",
                padding: "1px 3px",
                whiteSpace: "nowrap",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              {d.cls} {Math.round(d.conf * 100)}%
            </span>
          )}
        </div>
      ))}
    </>
  );
}
