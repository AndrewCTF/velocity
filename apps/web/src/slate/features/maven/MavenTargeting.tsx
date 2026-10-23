import { useState } from "react";
import type * as Cesium from "cesium";
import { TargetBoard } from "../../pages/TargetBoard.js";
import { Workspace } from "./Workspace.js";
import { ErrorBoundary } from "../../../shell/ErrorBoundary.js";

// The Targeting app under the Slate scheme: the target board, and from its
// Taskings button the watch workspace over the live map. The rail's logo in
// the workspace returns to the board.
export function MavenTargeting({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element {
  const [view, setView] = useState<"board" | "work">("board");
  return view === "board" ? (
    <div className="absolute inset-0 z-(--z-overlay) flex flex-col bg-bg-0">
      <TargetBoard viewer={viewer} onTaskings={() => setView("work")} />
    </div>
  ) : (
    <ErrorBoundary label="Watch workspace">
      <Workspace viewer={viewer} onBoard={() => setView("board")} />
    </ErrorBoundary>
  );
}
