// Custom object view, dark: the same object view the Browser carries, on its own.
import { ObjectView } from "./ObjectView.js";
import type { Ctx } from "./model.js";

export function Cov({ c }: { c: Ctx }): JSX.Element {
  return (
    <div className="px-pg pxcov">
      <ObjectView c={c} where="cov" />
    </div>
  );
}
