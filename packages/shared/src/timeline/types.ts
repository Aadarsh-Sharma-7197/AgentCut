export type TrackType = "video" | "audio" | "caption";

export interface TimelineSettings {
  frameRate: number; // Frames per second (e.g. 24, 25, 30, 60)
  width?: number;    // Canvas width in pixels (e.g. 1920)
  height?: number;   // Canvas height in pixels (e.g. 1080)
}

export interface Clip {
  id: string;             // Stable unique clip ID
  assetId: string;        // Reference to imported media asset ID
  trackId: string;        // ID of the track containing this clip
  sourceStart: number;    // In-point within source media in seconds (inclusive)
  sourceEnd: number;      // Out-point within source media in seconds (exclusive)
  timelineStart: number;  // Placement position on the timeline in seconds
  name?: string;          // Optional user-friendly clip label
}

export interface Track {
  id: string;             // Stable unique track ID
  name: string;           // Track label (e.g. "Video 1", "Audio 1", "Captions")
  type: TrackType;        // "video" | "audio" | "caption"
  index: number;          // Ordering index (0-based)
  enabled: boolean;       // Mute/solo/visibility flag
  clips: Clip[];          // Clips placed on this track
}

export interface Timeline {
  id: string;             // Stable unique timeline ID
  projectId: string;      // ID of associated project
  tracks: Track[];        // Collection of tracks
  settings: TimelineSettings; // Frame rate and resolution settings
  createdAt: string;      // ISO timestamp
  updatedAt: string;      // ISO timestamp
}

/**
 * Calculates the derived duration of a clip: sourceEnd - sourceStart.
 * Per timeline principles, duration is derived and never stored separately.
 */
export function getClipDuration(clip: Pick<Clip, "sourceStart" | "sourceEnd">): number {
  return clip.sourceEnd - clip.sourceStart;
}

/**
 * Calculates the derived end timestamp of a clip on the timeline.
 */
export function getClipTimelineEnd(
  clip: Pick<Clip, "timelineStart" | "sourceStart" | "sourceEnd">
): number {
  return clip.timelineStart + getClipDuration(clip);
}

/**
 * Calculates the total derived duration of a timeline based on the furthest clip end time.
 */
export function getTimelineDuration(timeline: Timeline): number {
  let maxEnd = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const end = getClipTimelineEnd(clip);
      if (end > maxEnd) {
        maxEnd = end;
      }
    }
  }
  return maxEnd;
}

