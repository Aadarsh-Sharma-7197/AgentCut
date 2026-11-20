import type { Timeline, Track, Clip } from "./types.js";
import { validateTimeline, TimelineValidationError } from "./validation.js";
import {
  splitClipWithResult,
  trimClip,
  moveClip,
  deleteClip,
  generateId
} from "./operations.js";
import { cloneTimeline } from "./history.js";
import type { MediaAsset } from "../index.js";
import type {
  AgentEditingPlan,
  ProposedOperation
} from "../agent/types.js";

export interface ExecutionSuccessResult {
  success: true;
  timeline: Timeline;
  operationsApplied: number;
}

export interface ExecutionFailureResult {
  success: false;
  timeline: Timeline; // Original untouched input timeline
  operationsApplied: number;
  error: string;
  failedOperationIndex: number;
  failedOperationId?: string;
}

export type ExecutionResult = ExecutionSuccessResult | ExecutionFailureResult;

export interface ExecuteEditingPlanOptions {
  assets?: MediaAsset[] | Map<string, MediaAsset>;
  idGenerator?: () => string;
}

function findClipInTimeline(
  timeline: Timeline,
  clipId: string
): { clip: Clip; track: Track } | null {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      return { clip, track };
    }
  }
  return null;
}

function executeSplitClip(
  timeline: Timeline,
  op: ProposedOperation,
  options?: ExecuteEditingPlanOptions
): { timeline: Timeline; newClipId: string } {
  const clipId = op.clipId || (typeof op.params?.clipId === "string" ? op.params.clipId.trim() : undefined);
  if (!clipId) {
    throw new Error("split_clip operation requires a 'clipId'.");
  }

  const rawSplit =
    typeof op.params?.splitTime === "number"
      ? op.params.splitTime
      : typeof op.timeRange?.timelineStart === "number"
      ? op.timeRange.timelineStart
      : typeof op.params?.time === "number"
      ? op.params.time
      : undefined;

  if (rawSplit === undefined || !Number.isFinite(rawSplit) || rawSplit < 0) {
    throw new Error(`split_clip operation requires a non-negative finite splitTime (got ${rawSplit}).`);
  }

  const newClipId =
    typeof op.params?.newClipId === "string" && op.params.newClipId.trim()
      ? op.params.newClipId.trim()
      : options?.idGenerator
      ? options.idGenerator()
      : generateId();

  const splitResult = splitClipWithResult(timeline, clipId, rawSplit, {
    newClipId,
    assets: options?.assets
  });

  return { timeline: splitResult.timeline, newClipId };
}

function executeTrimClip(
  timeline: Timeline,
  op: ProposedOperation,
  options?: ExecuteEditingPlanOptions
): Timeline {
  const clipId = op.clipId || (typeof op.params?.clipId === "string" ? op.params.clipId.trim() : undefined);
  if (!clipId) {
    throw new Error("trim_clip operation requires a 'clipId'.");
  }

  const found = findClipInTimeline(timeline, clipId);
  if (!found) {
    throw new Error(`Cannot trim clip: clip '${clipId}' not found in timeline.`);
  }
  const { clip } = found;

  const edge = typeof op.params?.edge === "string" ? op.params.edge.toLowerCase() : undefined;

  if (edge === "left" || edge === "right") {
    const targetTime =
      typeof op.params?.newTimelineTime === "number"
        ? op.params.newTimelineTime
        : typeof op.params?.targetTime === "number"
        ? op.params.targetTime
        : typeof op.params?.time === "number"
        ? op.params.time
        : edge === "left"
        ? op.timeRange?.timelineStart
        : op.timeRange?.timelineEnd;

    if (targetTime === undefined || !Number.isFinite(targetTime)) {
      throw new Error(`trim_clip operation with edge '${edge}' requires a finite targetTime.`);
    }

    return trimClip(timeline, clipId, edge as "left" | "right", targetTime, {
      assets: options?.assets
    });
  }

  // Handle sourceStart / sourceEnd parameterization
  const sourceStart =
    typeof op.timeRange?.sourceStart === "number"
      ? op.timeRange.sourceStart
      : typeof op.params?.sourceStart === "number"
      ? op.params.sourceStart
      : undefined;

  const sourceEnd =
    typeof op.timeRange?.sourceEnd === "number"
      ? op.timeRange.sourceEnd
      : typeof op.params?.sourceEnd === "number"
      ? op.params.sourceEnd
      : undefined;

  if (sourceStart === undefined && sourceEnd === undefined) {
    // Check if newTimelineStart or newTimelineEnd were provided directly
    if (typeof op.params?.newTimelineStart === "number") {
      return trimClip(timeline, clipId, "left", op.params.newTimelineStart, {
        assets: options?.assets
      });
    }
    if (typeof op.params?.newTimelineEnd === "number") {
      return trimClip(timeline, clipId, "right", op.params.newTimelineEnd, {
        assets: options?.assets
      });
    }
    throw new Error("trim_clip operation requires edge ('left'/'right') or sourceStart/sourceEnd bounds.");
  }

  if (sourceStart !== undefined && (!Number.isFinite(sourceStart) || sourceStart < 0)) {
    throw new Error(`trim_clip sourceStart must be a non-negative finite number (got ${sourceStart}).`);
  }
  if (sourceEnd !== undefined && (!Number.isFinite(sourceEnd) || sourceEnd <= 0)) {
    throw new Error(`trim_clip sourceEnd must be a positive finite number (got ${sourceEnd}).`);
  }
  if (sourceStart !== undefined && sourceEnd !== undefined && sourceEnd <= sourceStart) {
    throw new Error(`trim_clip sourceEnd (${sourceEnd}s) must be strictly greater than sourceStart (${sourceStart}s).`);
  }

  let currentTl = timeline;

  // Left trim
  if (sourceStart !== undefined && sourceStart !== clip.sourceStart) {
    const offset = sourceStart - clip.sourceStart;
    const newTimelineStart = clip.timelineStart + offset;
    currentTl = trimClip(currentTl, clipId, "left", newTimelineStart, {
      assets: options?.assets
    });
  }

  // Right trim
  if (sourceEnd !== undefined) {
    const updated = findClipInTimeline(currentTl, clipId);
    if (!updated) {
      throw new Error(`Cannot trim clip: clip '${clipId}' not found after left trim.`);
    }
    if (sourceEnd !== updated.clip.sourceEnd) {
      const newDuration = sourceEnd - updated.clip.sourceStart;
      const newTimelineEnd = updated.clip.timelineStart + newDuration;
      currentTl = trimClip(currentTl, clipId, "right", newTimelineEnd, {
        assets: options?.assets
      });
    }
  }

  return currentTl;
}

function executeMoveClip(
  timeline: Timeline,
  op: ProposedOperation,
  options?: ExecuteEditingPlanOptions
): Timeline {
  const clipId = op.clipId || (typeof op.params?.clipId === "string" ? op.params.clipId.trim() : undefined);
  if (!clipId) {
    throw new Error("move_clip operation requires a 'clipId'.");
  }

  const rawStart =
    typeof op.params?.newTimelineStart === "number"
      ? op.params.newTimelineStart
      : typeof op.timeRange?.timelineStart === "number"
      ? op.timeRange.timelineStart
      : typeof op.params?.timelineStart === "number"
      ? op.params.timelineStart
      : undefined;

  if (rawStart === undefined || !Number.isFinite(rawStart) || rawStart < 0) {
    throw new Error(`move_clip operation requires a non-negative finite newTimelineStart (got ${rawStart}).`);
  }

  const newTrackId =
    op.trackId ||
    (typeof op.params?.newTrackId === "string" && op.params.newTrackId.trim()
      ? op.params.newTrackId.trim()
      : typeof op.params?.trackId === "string" && op.params.trackId.trim()
      ? op.params.trackId.trim()
      : undefined);

  return moveClip(timeline, clipId, rawStart, newTrackId, {
    assets: options?.assets
  });
}

function executeDeleteClip(
  timeline: Timeline,
  op: ProposedOperation,
  options?: ExecuteEditingPlanOptions
): Timeline {
  const clipId = op.clipId || (typeof op.params?.clipId === "string" ? op.params.clipId.trim() : undefined);
  if (!clipId) {
    throw new Error("delete_clip operation requires a 'clipId'.");
  }

  return deleteClip(timeline, clipId, {
    assets: options?.assets
  });
}

function executeRemoveSilence(
  timeline: Timeline,
  op: ProposedOperation,
  options?: ExecuteEditingPlanOptions
): Timeline {
  const start =
    typeof op.timeRange?.sourceStart === "number"
      ? op.timeRange.sourceStart
      : typeof op.params?.start === "number"
      ? op.params.start
      : typeof op.params?.sourceStart === "number"
      ? op.params.sourceStart
      : undefined;

  const end =
    typeof op.timeRange?.sourceEnd === "number"
      ? op.timeRange.sourceEnd
      : typeof op.params?.end === "number"
      ? op.params.end
      : typeof op.params?.sourceEnd === "number"
      ? op.params.sourceEnd
      : undefined;

  if (
    start === undefined ||
    end === undefined ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start
  ) {
    throw new Error(
      `remove_silence operation requires valid finite start and end timestamps where end > start >= 0 (got start=${start}, end=${end}).`
    );
  }

  // 1. Single-track check: check how many tracks contain clips
  const tracksWithClips = timeline.tracks.filter((t) => t.clips.length > 0);
  if (tracksWithClips.length === 0) {
    throw new Error("Cannot remove silence: timeline contains no clips.");
  }
  if (tracksWithClips.length > 1) {
    throw new Error(
      `Cannot remove silence: ripple cut is only supported on single-track timelines or when only one track contains clips. Timeline contains clips across ${tracksWithClips.length} tracks. Multi-track ripple synchronization is not supported.`
    );
  }

  const activeTrack = tracksWithClips[0];
  const targetClipId = op.clipId || (typeof op.params?.clipId === "string" ? op.params.clipId.trim() : undefined);

  let targetClip: Clip | undefined;

  if (targetClipId) {
    targetClip = activeTrack.clips.find((c) => c.id === targetClipId);
    if (!targetClip) {
      throw new Error(`Cannot remove silence: clip '${targetClipId}' not found on active track '${activeTrack.id}'.`);
    }
  } else {
    // Match by source interval and optionally assetId
    const targetAssetId = op.assetId || (typeof op.params?.assetId === "string" ? op.params.assetId.trim() : undefined);
    const candidateClips = activeTrack.clips.filter((c) => {
      if (targetAssetId && c.assetId !== targetAssetId) return false;
      // Does clip overlap with [start, end]?
      return start < c.sourceEnd && end > c.sourceStart;
    });

    if (candidateClips.length === 0) {
      throw new Error(`Cannot remove silence: no clip found containing silence range [${start}s, ${end}s].`);
    }
    if (candidateClips.length > 1) {
      throw new Error(
        `Cannot remove silence: silence range [${start}s, ${end}s] spans across multiple clips (${candidateClips.map((c) => c.id).join(", ")}). Straddling multiple clips is not supported.`
      );
    }
    targetClip = candidateClips[0];
  }

  // Check boundary constraints
  if (start < targetClip.sourceStart || end > targetClip.sourceEnd) {
    throw new Error(
      `Cannot remove silence: silence range [${start}s, ${end}s] extends beyond clip '${targetClip.id}' source bounds [${targetClip.sourceStart}s, ${targetClip.sourceEnd}s]. Straddling clip boundaries is not supported.`
    );
  }

  const silenceDuration = end - start;
  const targetClipDuration = targetClip.sourceEnd - targetClip.sourceStart;
  const targetClipTimelineEnd = targetClip.timelineStart + targetClipDuration;

  const newTrackClips: Clip[] = [];

  // Case 1: Entire clip is silence
  if (start === targetClip.sourceStart && end === targetClip.sourceEnd) {
    for (const c of activeTrack.clips) {
      if (c.id === targetClip.id) {
        // Omitted
        continue;
      }
      if (c.timelineStart >= targetClipTimelineEnd) {
        newTrackClips.push({
          ...c,
          timelineStart: c.timelineStart - silenceDuration
        });
      } else {
        newTrackClips.push({ ...c });
      }
    }
  }
  // Case 2: Silence at start of clip
  else if (start === targetClip.sourceStart && end < targetClip.sourceEnd) {
    for (const c of activeTrack.clips) {
      if (c.id === targetClip.id) {
        newTrackClips.push({
          ...c,
          sourceStart: end
        });
      } else if (c.timelineStart >= targetClipTimelineEnd) {
        newTrackClips.push({
          ...c,
          timelineStart: c.timelineStart - silenceDuration
        });
      } else {
        newTrackClips.push({ ...c });
      }
    }
  }
  // Case 3: Silence at end of clip
  else if (start > targetClip.sourceStart && end === targetClip.sourceEnd) {
    for (const c of activeTrack.clips) {
      if (c.id === targetClip.id) {
        newTrackClips.push({
          ...c,
          sourceEnd: start
        });
      } else if (c.timelineStart >= targetClipTimelineEnd) {
        newTrackClips.push({
          ...c,
          timelineStart: c.timelineStart - silenceDuration
        });
      } else {
        newTrackClips.push({ ...c });
      }
    }
  }
  // Case 4: Silence in the middle of clip
  else {
    const piece2Id =
      typeof op.params?.newClipId === "string" && op.params.newClipId.trim()
        ? op.params.newClipId.trim()
        : options?.idGenerator
        ? options.idGenerator()
        : generateId();

    const piece1Duration = start - targetClip.sourceStart;

    const piece1: Clip = {
      ...targetClip,
      sourceEnd: start
    };

    const piece2: Clip = {
      ...targetClip,
      id: piece2Id,
      sourceStart: end,
      timelineStart: targetClip.timelineStart + piece1Duration
    };

    for (const c of activeTrack.clips) {
      if (c.id === targetClip.id) {
        newTrackClips.push(piece1, piece2);
      } else if (c.timelineStart >= targetClipTimelineEnd) {
        newTrackClips.push({
          ...c,
          timelineStart: c.timelineStart - silenceDuration
        });
      } else {
        newTrackClips.push({ ...c });
      }
    }
  }

  // Build next timeline immutably
  const nextTracks = timeline.tracks.map((track) => {
    if (track.id !== activeTrack.id) {
      return {
        ...track,
        clips: track.clips.map((c) => ({ ...c }))
      };
    }
    return {
      ...track,
      clips: newTrackClips
    };
  });

  const nextTimeline: Timeline = {
    ...timeline,
    revision: timeline.revision,
    settings: { ...timeline.settings },
    tracks: nextTracks,
    updatedAt: new Date().toISOString()
  };

  const validation = validateTimeline(nextTimeline, { assets: options?.assets });
  if (!validation.valid) {
    throw new TimelineValidationError("Failed to remove silence: validation error.", validation.errors);
  }

  return nextTimeline;
}

/**
 * Deterministically executes a validated editing plan sequentially against an in-memory clone of a timeline.
 * 
 * Guarantees:
 * - Pure and side-effect free: no database, filesystem, or network I/O.
 * - Non-destructive and atomic: returns original timeline unmodified on ANY failure.
 * - Sequential: each operation operates on the output of the previous operation.
 * - Preserves timeline revision (revision increment is deferred to persistence).
 * - Full post-execution structural and track-integrity validation.
 */
export function executeEditingPlan(
  initialTimeline: Timeline,
  plan: Pick<AgentEditingPlan, "operations"> & Partial<AgentEditingPlan>,
  options?: ExecuteEditingPlanOptions
): ExecutionResult {
  if (!initialTimeline || typeof initialTimeline !== "object") {
    return {
      success: false,
      timeline: initialTimeline,
      operationsApplied: 0,
      error: "executeEditingPlan: invalid timeline provided.",
      failedOperationIndex: -1
    };
  }

  if (!plan || !Array.isArray(plan.operations)) {
    return {
      success: false,
      timeline: initialTimeline,
      operationsApplied: 0,
      error: "executeEditingPlan: invalid plan provided (operations must be an array).",
      failedOperationIndex: -1
    };
  }

  // Handle empty plan
  if (plan.operations.length === 0) {
    return {
      success: true,
      timeline: cloneTimeline(initialTimeline),
      operationsApplied: 0
    };
  }

  // Clone initial timeline to isolate execution working copy
  let workingTimeline = cloneTimeline(initialTimeline);

  for (let i = 0; i < plan.operations.length; i++) {
    const op = plan.operations[i];

    if (!op || typeof op !== "object" || typeof op.type !== "string") {
      return {
        success: false,
        timeline: initialTimeline,
        operationsApplied: i,
        error: `Operation at index ${i} is invalid or missing 'type'.`,
        failedOperationIndex: i,
        failedOperationId: op?.id
      };
    }

    try {
      switch (op.type) {
        case "split_clip": {
          const res = executeSplitClip(workingTimeline, op, options);
          workingTimeline = res.timeline;
          break;
        }
        case "trim_clip": {
          workingTimeline = executeTrimClip(workingTimeline, op, options);
          break;
        }
        case "move_clip": {
          workingTimeline = executeMoveClip(workingTimeline, op, options);
          break;
        }
        case "delete_clip": {
          workingTimeline = executeDeleteClip(workingTimeline, op, options);
          break;
        }
        case "remove_silence": {
          workingTimeline = executeRemoveSilence(workingTimeline, op, options);
          break;
        }
        default: {
          return {
            success: false,
            timeline: initialTimeline,
            operationsApplied: i,
            error: `Unsupported operation type '${String(op.type)}' at index ${i}.`,
            failedOperationIndex: i,
            failedOperationId: op.id
          };
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        timeline: initialTimeline, // Original unchanged
        operationsApplied: i,
        error: `Operation '${op.type}' at index ${i} failed: ${message}`,
        failedOperationIndex: i,
        failedOperationId: op.id
      };
    }
  }

  // Final structural and asset validation check
  const finalValidation = validateTimeline(workingTimeline, {
    assets: options?.assets
  });

  if (!finalValidation.valid) {
    const errDetails = finalValidation.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    return {
      success: false,
      timeline: initialTimeline, // Original unchanged
      operationsApplied: 0,
      error: `Timeline invalid after executing plan: ${errDetails}`,
      failedOperationIndex: -1
    };
  }

  return {
    success: true,
    timeline: workingTimeline,
    operationsApplied: plan.operations.length
  };
}
