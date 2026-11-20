import type { Timeline, Track, Clip, TimelineSettings, TrackType } from "./types.js";
import { validateTimeline, TimelineValidationError, type ValidateTimelineOptions } from "./validation.js";

export function generateId(): string {
  // Pure lightweight fallback/UUID generator for universal shared environment (Node & Browser)
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "tl_" + Math.random().toString(36).substring(2, 11) + "_" + Date.now().toString(36);
}

export interface CreateTimelineParams {
  projectId: string;
  id?: string;
  revision?: number;
  settings?: Partial<TimelineSettings>;
  tracks?: Track[];
}

export interface CreateTrackInput {
  id?: string;
  name: string;
  type: TrackType;
  index?: number;
  enabled?: boolean;
}

export interface CreateClipInput {
  id?: string;
  assetId: string;
  trackId: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  name?: string;
}

/**
 * Creates a new, empty timeline immutably.
 *
 * @param params Project ID, optional timeline ID, initial tracks and settings.
 * @param options Optional validation options (e.g. media assets catalog).
 */
export function createEmptyTimeline(
  params: CreateTimelineParams,
  options?: ValidateTimelineOptions
): Timeline {
  const now = new Date().toISOString();
  const timeline: Timeline = {
    id: params.id || generateId(),
    projectId: params.projectId,
    revision: params.revision ?? 1,
    tracks: params.tracks
      ? params.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c })) }))
      : [],
    settings: {
      frameRate: params.settings?.frameRate ?? 30,
      width: params.settings?.width ?? 1920,
      height: params.settings?.height ?? 1080
    },
    createdAt: now,
    updatedAt: now
  };

  const validation = validateTimeline(timeline, options);
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to create empty timeline: validation error.", validation.errors);
  }

  return timeline;
}

/**
 * Adds a new track to a timeline immutably.
 *
 * @param timeline The input timeline (will not be mutated).
 * @param input Track definition parameters.
 * @param options Optional validation options (e.g. media assets catalog).
 */
export function addTrack(
  timeline: Timeline,
  input: CreateTrackInput,
  options?: ValidateTimelineOptions
): Timeline {
  if (!input.name || typeof input.name !== "string" || input.name.trim() === "") {
    throw new Error("Cannot add track: track name must be a non-empty string.");
  }
  const trimmedName = input.name.trim();
  const trackId = input.id || generateId();

  // Check for duplicate track ID
  if (timeline.tracks.some((t) => t.id === trackId)) {
    throw new Error(`Cannot add track: track ID '${trackId}' already exists in timeline.`);
  }

  const index = typeof input.index === "number" ? input.index : timeline.tracks.length;

  const newTrack: Track = {
    id: trackId,
    name: trimmedName,
    type: input.type,
    index,
    enabled: input.enabled ?? true,
    clips: []
  };

  const updatedTracks = timeline.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => ({ ...c }))
  }));

  // Insert track at index or append
  if (index >= updatedTracks.length) {
    updatedTracks.push(newTrack);
  } else {
    updatedTracks.splice(index, 0, newTrack);
  }

  // Normalize track indices sequentially (0, 1, 2, ...)
  updatedTracks.forEach((t, i) => {
    t.index = i;
  });

  const nextTimeline: Timeline = {
    ...timeline,
    settings: { ...timeline.settings },
    tracks: updatedTracks,
    updatedAt: new Date().toISOString()
  };

  const validation = validateTimeline(nextTimeline, options);
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to add track: validation error.", validation.errors);
  }

  return nextTimeline;
}

/**
 * Generates a sensible default track name based on existing tracks of that type.
 * e.g., "Video 1", "Video 2", "Audio 1", "Captions 1".
 */
export function generateDefaultTrackName(timeline: Timeline, type: TrackType): string {
  const count = timeline.tracks.filter((t) => t.type === type).length + 1;
  switch (type) {
    case "video":
      return `Video ${count}`;
    case "audio":
      return `Audio ${count}`;
    case "caption":
      return `Captions ${count}`;
    default:
      return `Track ${count}`;
  }
}

/**
 * Renames a timeline track immutably.
 *
 * Requirements:
 * - Finds the specified track by ID.
 * - Rejects empty or whitespace-only names.
 * - Trims unnecessary leading and trailing whitespace.
 * - Preserves track ID, type, index, enabled state, and all clips.
 * - Enforces validation on the resulting timeline.
 * - Guarantees deep immutability.
 */
export function renameTrack(
  timeline: Timeline,
  trackId: string,
  newName: string,
  options?: ValidateTimelineOptions
): Timeline {
  if (typeof newName !== "string" || newName.trim() === "") {
    throw new Error(`Cannot rename track: new name must be a non-empty string.`);
  }

  const trimmedName = newName.trim();
  const trackExists = timeline.tracks.some((t) => t.id === trackId);
  if (!trackExists) {
    throw new Error(`Cannot rename track: track '${trackId}' was not found in timeline.`);
  }

  const updatedTracks = timeline.tracks.map((t) => {
    if (t.id === trackId) {
      return {
        ...t,
        name: trimmedName,
        clips: t.clips.map((c) => ({ ...c }))
      };
    }
    return {
      ...t,
      clips: t.clips.map((c) => ({ ...c }))
    };
  });

  const nextTimeline: Timeline = {
    ...timeline,
    settings: { ...timeline.settings },
    tracks: updatedTracks,
    updatedAt: new Date().toISOString()
  };

  const validation = validateTimeline(nextTimeline, options);
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to rename track: validation error.", validation.errors);
  }

  return nextTimeline;
}

/**
 * Moves a track to a new target index position immutably.
 *
 * Requirements:
 * - Finds the specified track by ID.
 * - Rejects invalid target indices.
 * - Recalculates all track indices sequentially (0, 1, 2, ...).
 * - Preserves track IDs, types, and clips.
 * - Enforces validation on the resulting timeline.
 * - Guarantees deep immutability.
 */
export function moveTrackOrder(
  timeline: Timeline,
  trackId: string,
  targetIndex: number,
  options?: ValidateTimelineOptions
): Timeline {
  const currentIndex = timeline.tracks.findIndex((t) => t.id === trackId);
  if (currentIndex === -1) {
    throw new Error(`Cannot move track: track '${trackId}' was not found in timeline.`);
  }

  if (
    typeof targetIndex !== "number" ||
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= timeline.tracks.length
  ) {
    throw new Error(
      `Cannot move track: targetIndex must be an integer between 0 and ${timeline.tracks.length - 1} (got ${targetIndex}).`
    );
  }

  if (currentIndex === targetIndex) {
    return timeline;
  }

  const updatedTracks = timeline.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => ({ ...c }))
  }));

  const [movedTrack] = updatedTracks.splice(currentIndex, 1);
  updatedTracks.splice(targetIndex, 0, movedTrack);

  // Recalculate 0-based sequential indices consistently
  updatedTracks.forEach((t, i) => {
    t.index = i;
  });

  const nextTimeline: Timeline = {
    ...timeline,
    settings: { ...timeline.settings },
    tracks: updatedTracks,
    updatedAt: new Date().toISOString()
  };

  const validation = validateTimeline(nextTimeline, options);
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to reorder tracks: validation error.", validation.errors);
  }

  return nextTimeline;
}

/**
 * Reorders a track up or down by 1 position immutably.
 *
 * Requirements:
 * - "up" moves the track towards index 0 (higher priority/earlier in display).
 * - "down" moves the track towards the bottom (lower priority/later in display).
 * - If moving up while already at top, or down while already at bottom, throws informative error.
 */
export function reorderTrack(
  timeline: Timeline,
  trackId: string,
  direction: "up" | "down",
  options?: ValidateTimelineOptions
): Timeline {
  const currentIndex = timeline.tracks.findIndex((t) => t.id === trackId);
  if (currentIndex === -1) {
    throw new Error(`Cannot reorder track: track '${trackId}' was not found in timeline.`);
  }

  if (direction === "up") {
    if (currentIndex <= 0) {
      throw new Error(`Cannot move track '${trackId}' up: track is already at the topmost position.`);
    }
    return moveTrackOrder(timeline, trackId, currentIndex - 1, options);
  } else if (direction === "down") {
    if (currentIndex >= timeline.tracks.length - 1) {
      throw new Error(`Cannot move track '${trackId}' down: track is already at the bottommost position.`);
    }
    return moveTrackOrder(timeline, trackId, currentIndex + 1, options);
  } else {
    throw new Error(`Invalid reorder direction '${direction}'. Must be 'up' or 'down'.`);
  }
}

/**
 * Safely deletes an empty track from the timeline immutably.
 *
 * Safety Rules:
 * - Empty tracks may be deleted.
 * - Tracks containing clips must NOT be deleted; throws an informative error.
 * - Does not delete media assets or physical files.
 * - Re-indexes remaining tracks to maintain continuous 0-based indexing.
 * - Enforces validation on the resulting timeline.
 * - Guarantees deep immutability.
 */
export function deleteTrack(
  timeline: Timeline,
  trackId: string,
  options?: ValidateTimelineOptions
): Timeline {
  const targetTrack = timeline.tracks.find((t) => t.id === trackId);
  if (!targetTrack) {
    throw new Error(`Cannot delete track: track '${trackId}' was not found in timeline.`);
  }

  if (targetTrack.clips.length > 0) {
    throw new Error(
      `Cannot delete track '${targetTrack.name}' (${trackId}): track contains ${targetTrack.clips.length} clip(s). Tracks containing clips cannot be deleted. Delete or move the clips first.`
    );
  }

  const updatedTracks = timeline.tracks
    .filter((t) => t.id !== trackId)
    .map((t) => ({
      ...t,
      clips: t.clips.map((c) => ({ ...c }))
    }));

  // Re-normalize indices
  updatedTracks.forEach((t, i) => {
    t.index = i;
  });

  const nextTimeline: Timeline = {
    ...timeline,
    settings: { ...timeline.settings },
    tracks: updatedTracks,
    updatedAt: new Date().toISOString()
  };

  const validation = validateTimeline(nextTimeline, options);
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to delete track: validation error.", validation.errors);
  }

  return nextTimeline;
}

/**
 * Adds a clip to a specified track immutably.
 *
 * Note on Validation:
 * Structural validation (valid IDs, track existence, source timing, non-negative positions, unique IDs)
 * is always enforced. To validate media asset existence and track/asset stream compatibility,
 * pass the optional `options.assets` catalog.
 *
 * @param timeline The input timeline (will not be mutated).
 * @param input Clip parameters.
 * @param options Optional validation options including media asset catalog.
 */
export function addClip(
  timeline: Timeline,
  input: CreateClipInput,
  options?: ValidateTimelineOptions
): Timeline {
  const clipId = input.id || generateId();

  // Check for duplicate clip ID across all tracks
  for (const track of timeline.tracks) {
    if (track.clips.some((c) => c.id === clipId)) {
      throw new Error(`Cannot add clip: clip ID '${clipId}' already exists in timeline.`);
    }
  }

  const targetTrackExists = timeline.tracks.some((t) => t.id === input.trackId);
  if (!targetTrackExists) {
    throw new Error(`Cannot add clip: target track '${input.trackId}' does not exist in timeline.`);
  }

  const newClip: Clip = {
    id: clipId,
    assetId: input.assetId,
    trackId: input.trackId,
    sourceStart: input.sourceStart,
    sourceEnd: input.sourceEnd,
    timelineStart: input.timelineStart,
    name: input.name
  };

  const updatedTracks = timeline.tracks.map((track) => {
    if (track.id === input.trackId) {
      return {
        ...track,
        clips: [...track.clips.map((c) => ({ ...c })), newClip]
      };
    }
    return {
      ...track,
      clips: track.clips.map((c) => ({ ...c }))
    };
  });

  const nextTimeline: Timeline = {
    ...timeline,
    settings: { ...timeline.settings },
    tracks: updatedTracks,
    updatedAt: new Date().toISOString()
  };

  const validation = validateTimeline(nextTimeline, options);
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to add clip: validation error.", validation.errors);
  }

  return nextTimeline;
}

/**
 * Deletes a clip from the timeline by clip ID immutably.
 *
 * Requirements:
 * - Removes only the specified clip from its track's clips array.
 * - Preserves all other clips, tracks, settings, and metadata.
 * - Enforces validation on the resulting timeline.
 * - Rejects nonexistent clip IDs with a clear error.
 * - Guarantees immutability.
 *
 * @param timeline The input timeline (will not be mutated).
 * @param clipId The ID of the clip to delete.
 * @param options Optional validation options.
 */
export function deleteClip(
  timeline: Timeline,
  clipId: string,
  options?: ValidateTimelineOptions
): Timeline {
  let found = false;

  const updatedTracks = timeline.tracks.map((track) => {
    const hasClip = track.clips.some((c) => c.id === clipId);
    if (hasClip) {
      found = true;
      return {
        ...track,
        clips: track.clips.filter((c) => c.id !== clipId).map((c) => ({ ...c }))
      };
    }
    return {
      ...track,
      clips: track.clips.map((c) => ({ ...c }))
    };
  });

  if (!found) {
    throw new Error(`Cannot delete clip: clip '${clipId}' was not found in timeline.`);
  }

  const nextTimeline: Timeline = {
    ...timeline,
    settings: { ...timeline.settings },
    tracks: updatedTracks,
    updatedAt: new Date().toISOString()
  };

  const validation = validateTimeline(nextTimeline, options);
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to delete clip: validation error.", validation.errors);
  }

  return nextTimeline;
}

/**
 * Alias for deleteClip for backwards compatibility.
 */
export const removeClip = deleteClip;

/**
 * Moves a clip to a new timeline start position, optionally changing its track, immutably.
 *
 * Note on Validation:
 * Structural validation (valid positions, track existence) is always enforced.
 * When moving across tracks, passing `options.assets` enforces stream compatibility checks
 * (e.g. video asset moving to video track, audio asset moving to audio track, rejecting video/audio on caption tracks).
 *
 * @param timeline The input timeline (will not be mutated).
 * @param clipId The ID of the clip to move.
 * @param newTimelineStart New start position in seconds (>= 0).
 * @param newTrackId Optional destination track ID. If omitted, moves within current track.
 * @param options Optional validation options including media asset catalog.
 */
export function moveClip(
  timeline: Timeline,
  clipId: string,
  newTimelineStart: number,
  newTrackId?: string,
  options?: ValidateTimelineOptions
): Timeline {
  if (typeof newTimelineStart !== "number" || !Number.isFinite(newTimelineStart) || newTimelineStart < 0) {
    throw new Error(`Cannot move clip: newTimelineStart must be a non-negative finite number (got ${newTimelineStart}).`);
  }

  let foundClip: Clip | null = null;
  let sourceTrackId = "";

  // Locate the clip
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      foundClip = clip;
      sourceTrackId = track.id;
      break;
    }
  }

  if (!foundClip) {
    throw new Error(`Cannot move clip: clip '${clipId}' was not found in timeline.`);
  }

  const destinationTrackId = newTrackId || sourceTrackId;
  const destTrackExists = timeline.tracks.some((t) => t.id === destinationTrackId);
  if (!destTrackExists) {
    throw new Error(`Cannot move clip: destination track '${destinationTrackId}' does not exist.`);
  }

  const updatedClip: Clip = {
    ...foundClip,
    trackId: destinationTrackId,
    timelineStart: newTimelineStart
  };

  const updatedTracks = timeline.tracks.map((track) => {
    // If moving within the same track
    if (sourceTrackId === destinationTrackId && track.id === sourceTrackId) {
      return {
        ...track,
        clips: track.clips.map((c) => (c.id === clipId ? updatedClip : { ...c }))
      };
    }

    // If moving from source track to a different destination track
    if (track.id === sourceTrackId) {
      return {
        ...track,
        clips: track.clips.filter((c) => c.id !== clipId).map((c) => ({ ...c }))
      };
    }

    if (track.id === destinationTrackId) {
      return {
        ...track,
        clips: [...track.clips.map((c) => ({ ...c })), updatedClip]
      };
    }

    return {
      ...track,
      clips: track.clips.map((c) => ({ ...c }))
    };
  });

  const nextTimeline: Timeline = {
    ...timeline,
    settings: { ...timeline.settings },
    tracks: updatedTracks,
    updatedAt: new Date().toISOString()
  };

  const validation = validateTimeline(nextTimeline, options);
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to move clip: validation error.", validation.errors);
  }

  return nextTimeline;
}

export interface SplitClipOptions extends ValidateTimelineOptions {
  newClipId?: string;
}

export interface SplitClipResult {
  timeline: Timeline;
  firstClip: Clip;
  secondClip: Clip;
}

/**
 * Splits a clip at a given timeline position into two contiguous clips immutably,
 * returning the updated timeline along with references to both segment clips.
 *
 * Timing calculations:
 *   splitOffset = splitTimelineTime - clip.timelineStart
 *   sourceSplit = clip.sourceStart + splitOffset
 *
 * First clip:
 *   - Preserves original clip ID, asset ID, track ID, and timelineStart
 *   - Sets sourceEnd = sourceSplit
 *
 * Second clip:
 *   - Assigned newly generated clip ID (or options.newClipId)
 *   - Preserves asset ID, track ID, and sourceEnd
 *   - Sets timelineStart = splitTimelineTime
 *   - Sets sourceStart = sourceSplit
 *
 * Validation rejects:
 *   - Nonexistent clip ID
 *   - Non-finite or non-numeric splitTimelineTime
 *   - Split points at or outside clip bounds (splitTimelineTime <= timelineStart or splitTimelineTime >= timelineEnd)
 *   - Resulting clips with zero or negative duration
 *
 * @param timeline The input timeline (will not be mutated).
 * @param clipId The ID of the clip to split.
 * @param splitTimelineTime Position in timeline seconds strictly inside the clip.
 * @param options Optional validation options (e.g. assets) and optional newClipId.
 */
export function splitClipWithResult(
  timeline: Timeline,
  clipId: string,
  splitTimelineTime: number,
  options?: SplitClipOptions
): SplitClipResult {
  if (typeof splitTimelineTime !== "number" || !Number.isFinite(splitTimelineTime)) {
    throw new Error(`Cannot split clip: splitTimelineTime must be a finite number (got ${splitTimelineTime}).`);
  }

  let foundClip: Clip | null = null;
  let targetTrack: Track | null = null;

  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      foundClip = clip;
      targetTrack = track;
      break;
    }
  }

  if (!foundClip || !targetTrack) {
    throw new Error(`Cannot split clip: clip '${clipId}' was not found in timeline.`);
  }

  const clipDuration = foundClip.sourceEnd - foundClip.sourceStart;
  const clipTimelineEnd = foundClip.timelineStart + clipDuration;

  if (splitTimelineTime <= foundClip.timelineStart) {
    throw new Error(
      `Cannot split clip: split point (${splitTimelineTime}s) must be strictly greater than clip start (${foundClip.timelineStart}s).`
    );
  }

  if (splitTimelineTime >= clipTimelineEnd) {
    throw new Error(
      `Cannot split clip: split point (${splitTimelineTime}s) must be strictly less than clip end (${clipTimelineEnd}s).`
    );
  }

  const splitOffset = splitTimelineTime - foundClip.timelineStart;
  const sourceSplit = foundClip.sourceStart + splitOffset;

  if (!Number.isFinite(sourceSplit)) {
    throw new Error("Cannot split clip: resulting sourceSplit is not finite.");
  }

  const firstClipDuration = sourceSplit - foundClip.sourceStart;
  const secondClipDuration = foundClip.sourceEnd - sourceSplit;

  if (firstClipDuration <= 0 || secondClipDuration <= 0) {
    throw new Error(
      `Cannot split clip: resulting segments must have positive duration (got ${firstClipDuration}s and ${secondClipDuration}s).`
    );
  }

  const newClipId = options?.newClipId || generateId();
  if (newClipId === foundClip.id) {
    throw new Error(`Cannot split clip: generated or provided clip ID cannot be the same as the original clip ID '${foundClip.id}'.`);
  }

  const idExists = timeline.tracks.some((t) => t.clips.some((c) => c.id === newClipId));
  if (idExists) {
    throw new Error(`Cannot split clip: clip ID '${newClipId}' already exists in timeline.`);
  }

  const firstClip: Clip = {
    ...foundClip,
    id: foundClip.id,
    assetId: foundClip.assetId,
    trackId: foundClip.trackId,
    timelineStart: foundClip.timelineStart,
    sourceStart: foundClip.sourceStart,
    sourceEnd: sourceSplit
  };

  const secondClip: Clip = {
    ...foundClip,
    id: newClipId,
    assetId: foundClip.assetId,
    trackId: foundClip.trackId,
    timelineStart: splitTimelineTime,
    sourceStart: sourceSplit,
    sourceEnd: foundClip.sourceEnd
  };

  const updatedTracks = timeline.tracks.map((track) => {
    if (track.id !== targetTrack!.id) {
      return {
        ...track,
        clips: track.clips.map((c) => ({ ...c }))
      };
    }

    const updatedClips: Clip[] = [];
    for (const clip of track.clips) {
      if (clip.id === clipId) {
        updatedClips.push(firstClip, secondClip);
      } else {
        updatedClips.push({ ...clip });
      }
    }

    return {
      ...track,
      clips: updatedClips
    };
  });

  const nextTimeline: Timeline = {
    ...timeline,
    settings: { ...timeline.settings },
    tracks: updatedTracks,
    updatedAt: new Date().toISOString()
  };

  const validation = validateTimeline(nextTimeline, options);
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to split clip: validation error.", validation.errors);
  }

  return {
    timeline: nextTimeline,
    firstClip,
    secondClip
  };
}

/**
 * Splits a clip at a given timeline position into two contiguous clips immutably,
 * returning the updated timeline.
 *
 * @param timeline The input timeline (will not be mutated).
 * @param clipId The ID of the clip to split.
 * @param splitTimelineTime Position in timeline seconds strictly inside the clip.
 * @param options Optional validation options (e.g. assets) and optional newClipId.
 */
export function splitClip(
  timeline: Timeline,
  clipId: string,
  splitTimelineTime: number,
  options?: SplitClipOptions
): Timeline {
  return splitClipWithResult(timeline, clipId, splitTimelineTime, options).timeline;
}

export type TrimEdge = "left" | "right";

export interface TrimClipOptions extends ValidateTimelineOptions {}

/**
 * Trims a clip's left or right edge immutably.
 *
 * Left-edge trimming:
 *   - newTimelineTime represents the new timeline start position.
 *   - Increases/decreases sourceStart by the same timeline offset (newTimelineTime - timelineStart).
 *   - Sets timelineStart = newTimelineTime.
 *   - sourceEnd remains unchanged.
 *   - Preserves original clip ID, assetId, trackId, and other metadata.
 *   - Rejects if newTimelineTime < 0, newSourceStart < 0, or newTimelineTime >= timelineEnd.
 *
 * Right-edge trimming:
 *   - newTimelineTime represents the new timeline end position.
 *   - Sets sourceEnd = sourceStart + (newTimelineTime - timelineStart).
 *   - timelineStart and sourceStart remain unchanged.
 *   - Preserves original clip ID, assetId, trackId, and other metadata.
 *   - Rejects if newTimelineTime <= timelineStart, or if newSourceEnd <= sourceStart.
 *
 * Validation rejects:
 *   - Missing clip ID
 *   - Invalid edge value (not "left" or "right")
 *   - Non-finite time values (NaN, Infinity, -Infinity)
 *   - Trims producing zero or negative duration
 *   - Left trims beyond original right edge
 *   - Right trims before original left edge
 *   - Any resulting timeline that violates timeline validation
 *
 * @param timeline The input timeline (will not be mutated).
 * @param clipId The ID of the clip to trim.
 * @param edge "left" or "right".
 * @param newTimelineTime New position of the trimmed edge in seconds.
 * @param options Optional validation options (e.g. assets).
 */
export function trimClip(
  timeline: Timeline,
  clipId: string,
  edge: TrimEdge,
  newTimelineTime: number,
  options?: TrimClipOptions
): Timeline {
  if (edge !== "left" && edge !== "right") {
    throw new Error(`Cannot trim clip: edge must be 'left' or 'right' (got '${edge}').`);
  }

  if (typeof newTimelineTime !== "number" || !Number.isFinite(newTimelineTime)) {
    throw new Error(`Cannot trim clip: newTimelineTime must be a finite number (got ${newTimelineTime}).`);
  }

  let foundClip: Clip | null = null;
  let targetTrack: Track | null = null;

  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      foundClip = clip;
      targetTrack = track;
      break;
    }
  }

  if (!foundClip || !targetTrack) {
    throw new Error(`Cannot trim clip: clip '${clipId}' was not found in timeline.`);
  }

  const clipDuration = foundClip.sourceEnd - foundClip.sourceStart;
  const clipTimelineEnd = foundClip.timelineStart + clipDuration;

  let newTimelineStart: number;
  let newSourceStart: number;
  let newSourceEnd: number;

  if (edge === "left") {
    if (newTimelineTime < 0) {
      throw new Error(`Cannot trim clip: newTimelineTime cannot be negative (got ${newTimelineTime}s).`);
    }

    if (newTimelineTime >= clipTimelineEnd) {
      throw new Error(
        `Cannot trim clip: left trim (${newTimelineTime}s) cannot be at or beyond right edge (${clipTimelineEnd}s).`
      );
    }

    const offset = newTimelineTime - foundClip.timelineStart;
    newTimelineStart = newTimelineTime;
    newSourceStart = foundClip.sourceStart + offset;
    newSourceEnd = foundClip.sourceEnd;

    if (newSourceStart < 0) {
      throw new Error(
        `Cannot trim clip: left trim exceeds media source origin (newSourceStart would be ${newSourceStart}s).`
      );
    }

    if (newSourceStart >= newSourceEnd) {
      throw new Error(
        `Cannot trim clip: left trim produces non-positive duration (sourceStart: ${newSourceStart}s, sourceEnd: ${newSourceEnd}s).`
      );
    }
  } else {
    // edge === "right"
    if (newTimelineTime <= foundClip.timelineStart) {
      throw new Error(
        `Cannot trim clip: right trim (${newTimelineTime}s) cannot be at or before left edge (${foundClip.timelineStart}s).`
      );
    }

    const newDuration = newTimelineTime - foundClip.timelineStart;
    if (newDuration <= 0) {
      throw new Error(`Cannot trim clip: right trim produces non-positive duration (${newDuration}s).`);
    }

    newTimelineStart = foundClip.timelineStart;
    newSourceStart = foundClip.sourceStart;
    newSourceEnd = foundClip.sourceStart + newDuration;

    if (newSourceEnd <= newSourceStart) {
      throw new Error(
        `Cannot trim clip: right trim produces non-positive duration (sourceStart: ${newSourceStart}s, sourceEnd: ${newSourceEnd}s).`
      );
    }
  }

  const updatedClip: Clip = {
    ...foundClip,
    timelineStart: newTimelineStart,
    sourceStart: newSourceStart,
    sourceEnd: newSourceEnd
  };

  const updatedTracks = timeline.tracks.map((track) => {
    if (track.id !== targetTrack!.id) {
      return {
        ...track,
        clips: track.clips.map((c) => ({ ...c }))
      };
    }

    return {
      ...track,
      clips: track.clips.map((c) => (c.id === clipId ? updatedClip : { ...c }))
    };
  });

  const nextTimeline: Timeline = {
    ...timeline,
    settings: { ...timeline.settings },
    tracks: updatedTracks,
    updatedAt: new Date().toISOString()
  };

  const validation = validateTimeline(nextTimeline, options);
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to trim clip: validation error.", validation.errors);
  }

  return nextTimeline;
}
