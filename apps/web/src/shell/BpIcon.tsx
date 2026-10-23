import type { CSSProperties } from "react";

// Blueprint's published icon set (@blueprintjs/icons, Apache-2.0) as one SVG
// sprite in public/bp-sprite.svg, symbol ids `bp-<name>`. The window chrome
// draws with these at the reference's sizes and colours; the rest of the app
// keeps `normal/Icon`.
export function BpIcon({
  name,
  size = 16,
  className,
  style,
}: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      style={{ fill: "currentColor", flex: "none", ...style }}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`${import.meta.env.BASE_URL}bp-sprite.svg#bp-${name}`} />
    </svg>
  );
}
