import type * as Cesium from 'cesium';
import type { LayerDescriptor } from '@osint/shared';

export type FeedStatusKind = 'green' | 'amber' | 'red' | 'unknown';
export interface FeedStatus {
  status: FeedStatusKind;
  lastSeen?: number;
  note?: string; // optional reason — surfaces in the feed-health tooltip
}
export type StatusReporter = (status: FeedStatus) => void;

export interface LayerAdapter {
  attach(viewer: Cesium.Viewer): Promise<void> | void;
  detach(): void;
}

export interface AdapterCtx {
  viewer: Cesium.Viewer;
  descriptor: LayerDescriptor;
  reportStatus: StatusReporter;
}
