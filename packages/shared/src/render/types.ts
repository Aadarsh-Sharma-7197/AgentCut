import type { TrackType } from "../timeline/types.js";

/**
 * Output configuration for timeline rendering.
 */
export interface RenderOutputConfig {
  format: "mp4";
  videoCodec: "libx264" | "h264";
  audioCodec: "aac";
  pixelFormat: "yuv420p";
  /** Optional target bitrate or quality preset */
  preset?: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium";
  crf?: number; // Constant Rate Factor (e.g. 23)
}

/**
 * Represents a single rendered clip derived deterministically from a timeline clip.
 */
export interface RenderClip {
  clipId: string;
  assetId: string;
  trackId: string;
  trackType: TrackType;
  sourceStart: number;     // In seconds within source media
  sourceEnd: number;       // In seconds within source media
  timelineStart: number;   // Placement on the output timeline in seconds
  duration: number;        // Derived: sourceEnd - sourceStart
  timelineEnd: number;     // Derived: timelineStart + duration
  name?: string;
}

/**
 * Represents a track within the render plan, preserving ordering and type.
 */
export interface RenderTrack {
  trackId: string;
  name: string;
  type: TrackType;
  index: number;
  enabled: boolean;
  clips: RenderClip[];
}

/**
 * Structured, deterministic render plan derived from an editable timeline.
 * Does not expose raw internal filesystem paths to the client.
 */
export interface RenderPlan {
  projectId: string;
  timelineId: string;
  settings: {
    width: number;
    height: number;
    frameRate: number;
  };
  duration: number; // Total output duration in seconds
  videoClips: RenderClip[];
  audioClips: RenderClip[];
  tracks: RenderTrack[];
  output: RenderOutputConfig;
  createdAt: string;
}

/**
 * Validation diagnostic result for a render plan.
 */
export interface RenderPlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Lifecycle status of a rendering job.
 */
export type RenderJobStatus =
  | "queued"
  | "validating"
  | "rendering"
  | "completed"
  | "failed"
  | "canceled";

/**
 * Completed render output metadata.
 */
export interface RenderOutputMetadata {
  outputFileName: string;
  fileSizeBytes?: number;
  duration?: number;
  format?: string;
}

/**
 * Lightweight rendering job tracking model.
 */
export interface RenderJob {
  id: string;
  projectId: string;
  timelineId: string;
  status: RenderJobStatus;
  progress: number; // Percentage 0 - 100
  plan: RenderPlan;
  outputMetadata?: RenderOutputMetadata;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Request payload for creating a render job.
 */
export interface CreateRenderJobDTO {
  outputConfig?: Partial<RenderOutputConfig>;
}

