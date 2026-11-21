// Shared bits of the Foundry pages: Blueprint sprite glyphs and Python-style rounding.
const SPRITE = `${import.meta.env.BASE_URL}bp-sprite.svg#bp-`;

/** Python's round(): half to even (Plate's integer zoom uses it). */
export function pyRound(x: number, nd = 0): number {
  const m = 10 ** nd;
  const v = x * m;
  const f = Math.floor(v);
  const d = v - f;
  const r =
    Math.abs(d - 0.5) < 1e-9 ? (f % 2 === 0 ? f : f + 1) : Math.round(v);
  return r / m;
}

/** A Blueprint sprite glyph inside a text run. */
export function Ii(name: string, size: number, col: string): JSX.Element {
  return (
    <svg
      className="i"
      aria-hidden
      style={{ width: size, height: size, color: col, verticalAlign: -2 }}
    >
      <use href={SPRITE + name} />
    </svg>
  );
}

/** The same glyph drawn inside an SVG overlay, centred on (x, y), turned by `rot` degrees. */
export function Glyph({
  name,
  x,
  y,
  s,
  col,
  rot = 0,
}: {
  name: string;
  x: number;
  y: number;
  s: number;
  col: string;
  rot?: number;
}): JSX.Element {
  return (
    <use
      href={SPRITE + name}
      x={x - s / 2}
      y={y - s / 2}
      width={s}
      height={s}
      style={{ color: col, fill: "currentColor" }}
      transform={rot ? `rotate(${rot} ${x} ${y})` : undefined}
    />
  );
}
