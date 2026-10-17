import { useState } from "react";
import type * as Cesium from "cesium";
import { Icon } from "../normal/Icon.js";
import { useIsMobile } from "../shell/useIsMobile.js";
import { usePhoneSheet } from "../shell/phoneSheet.js";
import { toast } from "../shell/toast.js";
import { flyToPosition, resetToTopDown } from "./camera.js";

// The phone's map controls: where am I, and north up. Pinch zooms and two
// fingers tilt, so the desktop rail's zoom and pan buttons have nothing to do
// on a touch screen, and its measure and draw tools are behind More.
//
// Geolocation only exists in a secure context (https or localhost). A phone
// reaching a self-hosted box over plain http on the LAN has none, so the button
// is left out there rather than offered and refused.

export function PhoneMapButtons({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element | null {
  const phone = useIsMobile();
  const [locating, setLocating] = useState(false);
  // The desktop tool rail, when asked for from More, takes the right edge.
  const tools = usePhoneSheet((s) => s.tools);
  if (!phone || !viewer || tools) return null;
  const canLocate =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "geolocation" in navigator;

  const locate = (): void => {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        if (!viewer.isDestroyed())
          flyToPosition(
            viewer,
            pos.coords.longitude,
            pos.coords.latitude,
            120_000,
          );
      },
      (err) => {
        setLocating(false);
        toast.warn(
          err.code === err.PERMISSION_DENIED
            ? "Location is blocked for this site. Allow it in the browser's site settings."
            : "Could not get your location. Try again outdoors or with Wi-Fi on.",
        );
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  return (
    <div className="pmapbtns">
      {canLocate && (
        <button
          type="button"
          className="pround"
          onClick={locate}
          disabled={locating}
          aria-label={locating ? "Finding your location" : "Show my location"}
        >
          <Icon name="crosshair" className="h-[20px] w-[20px]" />
        </button>
      )}
      <button
        type="button"
        className="pround"
        onClick={() => resetToTopDown(viewer)}
        aria-label="North up, straight down"
      >
        <Icon name="compass" className="h-[20px] w-[20px]" />
      </button>
    </div>
  );
}
