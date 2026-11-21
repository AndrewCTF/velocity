import * as Cesium from "cesium";

// SearchDialogHost: D80 dialog mount point.
// "Search for objects" in the Maven layers panel opens the command palette;
// this host renders alongside the Maven toolbar so the dialog has a stable
// portal-less host. The dialog itself is mounted from MavenLayers' row
// (SearchDialog.tsx) when the palette requests search.

export function SearchDialogHost({
  viewer: _viewer,
}: {
  viewer: Cesium.Viewer | null;
}): React.JSX.Element | null {
  return null;
}
