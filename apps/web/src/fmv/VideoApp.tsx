import { Suspense, lazy, useMemo } from "react";
import * as Cesium from "cesium";
import { TabbedPanel, type TabDef } from "../shell/TabbedPanel.js";
import { FmvPanel } from "./FmvPanel.js";
import { GroundReconPanel } from "../ground/GroundReconPanel.js";
import { ImageryControl } from "../imagery/ImageryControl.js";
import { useTheme } from "../state/theme.js";
import { ErrorBoundary } from "../shell/ErrorBoundary.js";

// Under the Slate scheme the FMV tab is the reference video surface
// (slate/features/maven/Fmv.tsx): the imagery plate, detections, timeline.
const MavenFmv = lazy(() =>
  import("../slate/features/maven/Fmv.js").then((m) => ({
    default: m.MavenFmv,
  })),
);

// Video app (design §6.1 / §8) — full-motion video + ground recon + detections.
// FMV (notional sensor) and street-level ground imagery share one surface.
//
// Imagery is here because `panels.ts` re-homes the old `imagery` rail item to
// this app ("imagery → the video app"). Nothing rendered it, so `byHome` dropped
// the satellite chip controls entirely: the Selection panel's "Imagery here"
// button set a chip focus with no surface left to steer it from.
export function VideoApp({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element {
  const slate = useTheme((s) => s.mode) === "slate";
  const tabs: TabDef[] = useMemo(
    () => [
      {
        id: "fmv",
        label: "FMV",
        content: slate ? (
          <div className="relative h-full min-h-[560px]">
            <ErrorBoundary label="FMV">
              <Suspense fallback={null}>
                <MavenFmv viewer={viewer} />
              </Suspense>
            </ErrorBoundary>
          </div>
        ) : (
          <FmvPanel viewer={viewer} />
        ),
      },
      {
        id: "ground",
        label: "Ground recon",
        content: <GroundReconPanel viewer={viewer} />,
      },
      { id: "imagery", label: "Imagery", content: <ImageryControl /> },
    ],
    [viewer, slate],
  );
  return <TabbedPanel tabs={tabs} defaultTab="fmv" ariaLabel="Video" />;
}
