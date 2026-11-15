import type { Clip, Track, Timeline } from "./types.js";

export interface ActiveVideoClip {
  clip: Clip;
  track: Track;
  sourceTime: number;
  clipDuration: number;
  clipTimelineEnd: number;
  timeRemainingInClip: number;
}

export interface NextVideoClip {
  clip: Clip;
  track: Track;
  timelineStart: number;
  sourceStart: number;
  gapDuration: number;
  isContiguous: boolean;
}

export interface TimelinePlaybackSnapshot {
  timelineTime: number;
  activeClip: ActiveVideoClip | null;
  isGap: boolean;
  nextClip: NextVideoClip | null;
  totalDuration: number;
}

/**
 * Maps a timeline time to the corresponding source media time for a given clip.
 * Formula: sourceTime = clip.sourceStart + (timelineTime - clip.timelineStart)
 * Clamped to [clip.sourceStart, clip.sourceEnd].
 */
export function timelineTimeToSourceTime(clip: Clip, timelineTime: number): number {
  const duration = clip.sourceEnd - clip.sourceStart;
  const offset = timelineTime - clip.timelineStart;
  const clampedOffset = Math.max(0, Math.min(offset, duration));
  return clip.sourceStart + clampedOffset;
}

/**
 * Maps a source media time to the corresponding timeline time for a given clip.
 * Formula: timelineTime = clip.timelineStart + (sourceTime - clip.sourceStart)
 */
export function sourceTimeToTimelineTime(clip: Clip, sourceTime: number): number {
  const offset = sourceTime - clip.sourceStart;
  return clip.timelineStart + offset;
}

/**
 * Checks whether a given timeline time falls strictly inside a clip's timeline interval.
 * Returns true if clip.timelineStart <= timelineTime < clip.timelineStart + duration.
 */
export function isTimelineTimeInsideClip(
  clip: Clip,
  timelineTime: number,
  tolerance = 0.001
): boolean {
  const duration = clip.sourceEnd - clip.sourceStart;
  const timelineEnd = clip.timelineStart + duration;
  return timelineTime >= clip.timelineStart - tolerance && timelineTime < timelineEnd - tolerance;
}

/**
 * Deterministic clip lookup policy for timeline playback:
 * Searches enabled video tracks in top-down order (Track 1 first).
 * Returns the first active video clip covering the specified timelineTime,
 * or null if timelineTime falls in an empty gap or beyond the end of clips.
 */
export function findActiveVideoClipAtTime(
  timeline: Timeline,
  timelineTime: number
): ActiveVideoClip | null {
  if (!timeline || !timeline.tracks) return null;

  const validTime = Math.max(0, timelineTime);
  const videoTracks = timeline.tracks
    .filter((t) => t.type === "video" && (t.enabled === undefined || t.enabled === true))
    .sort((a, b) => a.index - b.index);

  for (const track of videoTracks) {
    for (const clip of track.clips) {
      const duration = clip.sourceEnd - clip.sourceStart;
      const timelineEnd = clip.timelineStart + duration;

      // Check if validTime falls inside [clip.timelineStart, timelineEnd)
      if (validTime >= clip.timelineStart && validTime < timelineEnd - 0.0001) {
        const sourceTime = timelineTimeToSourceTime(clip, validTime);
        const timeRemainingInClip = Math.max(0, timelineEnd - validTime);

        return {
          clip,
          track,
          sourceTime,
          clipDuration: duration,
          clipTimelineEnd: timelineEnd,
          timeRemainingInClip
        };
      }
    }
  }

  return null;
}

/**
 * Finds the next earliest video clip on the timeline that begins at or after the given time.
 * Evaluates whether it forms a contiguous transition (gap <= 0.04s, i.e. within ~1 video frame).
 */
export function findNextVideoClipAfterTime(
  timeline: Timeline,
  timelineTime: number,
  currentClipId?: string
): NextVideoClip | null {
  if (!timeline || !timeline.tracks) return null;

  const videoTracks = timeline.tracks
    .filter((t) => t.type === "video" && (t.enabled === undefined || t.enabled === true))
    .sort((a, b) => a.index - b.index);

  let earliestNext: { clip: Clip; track: Track } | null = null;

  for (const track of videoTracks) {
    for (const clip of track.clips) {
      if (currentClipId && clip.id === currentClipId) continue;

      // Only consider clips that start at or after timelineTime (with slight tolerance for rounding)
      if (clip.timelineStart >= timelineTime - 0.01) {
        if (!earliestNext || clip.timelineStart < earliestNext.clip.timelineStart) {
          earliestNext = { clip, track };
        }
      }
    }
  }

  if (!earliestNext) return null;

  const gapDuration = Math.max(0, earliestNext.clip.timelineStart - timelineTime);
  // Contiguous if gap is within 50ms (~1 video frame at 24/25/30fps)
  const isContiguous = gapDuration <= 0.05;

  return {
    clip: earliestNext.clip,
    track: earliestNext.track,
    timelineStart: earliestNext.clip.timelineStart,
    sourceStart: earliestNext.clip.sourceStart,
    gapDuration,
    isContiguous
  };
}

/**
 * Calculates a complete snapshot of the timeline playback state at the specified time.
 */
export function getTimelinePlaybackSnapshot(
  timeline: Timeline,
  timelineTime: number
): TimelinePlaybackSnapshot {
  const activeClip = findActiveVideoClipAtTime(timeline, timelineTime);
  const currentClipEnd = activeClip ? activeClip.clipTimelineEnd : timelineTime;
  const nextClip = findNextVideoClipAfterTime(timeline, currentClipEnd, activeClip?.clip.id);

  let totalDuration = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const end = clip.timelineStart + (clip.sourceEnd - clip.sourceStart);
      if (end > totalDuration) totalDuration = end;
    }
  }

  return {
    timelineTime: Math.max(0, timelineTime),
    activeClip,
    isGap: activeClip === null,
    nextClip,
    totalDuration
  };
}

