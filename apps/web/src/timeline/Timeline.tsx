import type * as Cesium from 'cesium';
import { TimeDock } from '../shell/TimeDock.js';

// Timeline — now a thin wrapper. The real transport (the clock-driving,
// chunked-replay one) lives in shell/TimeDock.tsx: "one address per surface"
// (apps/web/CLAUDE.md). This file used to duplicate that whole implementation
// for App2D's benefit, and the duplicate was never wired to anything —
// App2D.tsx mounts it with no Cesium viewer, so `installHistoryPlayback`
// never ran and every transport control here was dead from the start
// (docs/decisions.md, Wave 0: "the Play button does nothing"). TimeDock
// already accepts a nullable viewer and no-ops its clock/replay effects when
// there isn't one, so this wrapper carries the 2D console's bottom dock with
// zero duplicated logic and nothing lost that was ever reachable.
//
// `stepSpeed` moved to shell/TimeDock.tsx with the rest of the keyboard
// transport; re-exported here because timeline/transport.test.ts (not owned
// by this change) imports it from this path.
export { stepSpeed } from '../shell/TimeDock.js';

interface Props {
  viewer?: Cesium.Viewer | null;
}

export function Timeline({ viewer }: Props = {}): JSX.Element {
  return <TimeDock viewer={viewer ?? null} />;
}
