import type { Timeline, Track, Clip } from "../timeline/types.js";
import { getClipDuration } from "../timeline/types.js";
import type {
  RenderPlan,
  RenderTrack,
  RenderClip,
  RenderOutputConfig
} from "./types.js";

export const DEFAULT_RENDER_OUTPUT_CONFIG: RenderOutputConfig = {
  format: "mp4",
  videoCodec: "libx264",
  audioCodec: "aac",
  pixelFormat: "yuv420p",
  preset: "fast",
  crf: 23
};

export interface CreateRenderPlanOptions {
  outputConfig?: Partial<RenderOutputConfig>;
  /**
   * If true, includes clips from disabled tracks in the active videoClips and audioClips arrays.
   * Defaults to false (only enabled tracks are actively scheduled for rendering).
   */
  includeDisabledTracks?: boolean;
}

/**
 * Translates an editable timeline into a structured, validated, deterministic render plan.
 * Pure and non-destructive: original timeline and clip objects are never mutated.
 */
export function createRenderPlanFromTimeline(
  timeline: Timeline,
  options?: CreateRenderPlanOptions
): RenderPlan {
  const width = timeline.settings.width ?? 1920;
  const height = timeline.settings.height ?? 1080;
  const frameRate = timeline.settings.frameRate ?? 30;

  const output: RenderOutputConfig = {
    ...DEFAULT_RENDER_OUTPUT_CONFIG,
    ...(options?.outputConfig || {})
  };

  // Sort tracks by index ascending (lower index = higher priority in video composition)
  const sortedTracks = [...timeline.tracks].sort((a, b) => a.index - b.index);

  const renderTracks: RenderTrack[] = [];
  const videoClips: RenderClip[] = [];
  const audioClips: RenderClip[] = [];
  let maxOutputDuration = 0;

  for (const track of sortedTracks) {
    const isEnabled = track.enabled !== false;
    const trackClips: RenderClip[] = [];

    // Sort clips within track by timelineStart ascending
    const sortedClips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);

    for (const clip of sortedClips) {
      const duration = getClipDuration(clip);
      const timelineEnd = clip.timelineStart + duration;

      const renderClip: RenderClip = {
        clipId: clip.id,
        assetId: clip.assetId,
        trackId: track.id,
        trackType: track.type,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        timelineStart: clip.timelineStart,
        duration,
        timelineEnd,
        name: clip.name
      };

      trackClips.push(renderClip);

      // Only schedule clips from enabled tracks for active rendering unless explicitly overridden
      const shouldIncludeInActiveStreams = isEnabled || options?.includeDisabledTracks;
      if (shouldIncludeInActiveStreams) {
        if (track.type === "video") {
          videoClips.push(renderClip);
        } else if (track.type === "audio") {
          audioClips.push(renderClip);
        }

        if (timelineEnd > maxOutputDuration) {
          maxOutputDuration = timelineEnd;
        }
      }
    }

    renderTracks.push({
      trackId: track.id,
      name: track.name,
      type: track.type,
      index: track.index,
      enabled: isEnabled,
      clips: trackClips
    });
  }

  return {
    projectId: timeline.projectId,
    timelineId: timeline.id,
    settings: {
      width,
      height,
      frameRate
    },
    duration: Number(maxOutputDuration.toFixed(4)),
    videoClips,
    audioClips,
    tracks: renderTracks,
    output,
    createdAt: new Date().toISOString()
  };
}
