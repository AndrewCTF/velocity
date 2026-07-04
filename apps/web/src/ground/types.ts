// Shared types for ground recon: street-level imagery + desktop-CUDA detection.

/** A single YOLO detection from the desktop CUDA sidecar (normalized bbox 0..1). */
export interface GroundDetection {
  id: string;
  /** COCO-style label from the sidecar, e.g. 'car','person','truck','bus'. */
  cls: string;
  conf: number;
  bbox: { x: number; y: number; w: number; h: number };
}

export interface DetectStatus {
  device: string; // 'cuda:0' | 'cpu'
  ready: boolean;
  fps?: number;
}

/** A normalised ground photo point from /api/ground/nearby. */
export interface GroundPhotoFeature {
  source: 'panoramax' | 'kartaview' | string;
  photo_id: string;
  name: string;
  lat: number;
  lon: number;
  heading: number | null;
  captured_at: string | null;
  thumb_url: string;
  photo_url: string;
}
