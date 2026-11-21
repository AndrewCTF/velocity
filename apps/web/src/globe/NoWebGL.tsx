import { useState, type ReactNode } from "react";
import { hasWebGL2 } from "./webgl.js";

// Stands in for the globe on a device that cannot draw it. The generic "globe"
// error boundary would say a panel "stopped rendering", which is true and of
// no use; this says what the map needs and one thing to try. It fills the same
// well the globe would, so the console around it is laid out as usual.
export function NoWebGL(): JSX.Element {
  return (
    <div className="h-full w-full flex items-center justify-center p-4">
      <div
        role="alert"
        className="max-w-sm border border-line-2 bg-bg-1 px-4 py-3 rounded-md"
      >
        <div className="micro text-txt-2">map unavailable</div>
        <p className="text-[12px] text-txt-1 mt-1 leading-snug">
          This map needs WebGL 2, which this browser or device has turned off or
          does not support.
        </p>
        <p className="text-[12px] text-txt-2 mt-2 leading-snug">
          Try another browser, or turn on hardware acceleration in this
          browser's settings and reload.
        </p>
      </div>
    </div>
  );
}

// Renders the globe only where the browser can give it WebGL 2, and the
// message above everywhere else. Asked once per mount: the answer does not
// change while the page is open, and every probe is a throwaway GL context.
export function RequireWebGL2({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [supported] = useState(hasWebGL2);
  return supported ? <>{children}</> : <NoWebGL />;
}
