import type {
  ProposedOperation,
  Timeline,
  Track,
  Clip,
  MediaAsset
} from "@agentcut/shared";

export interface OperationDiffSummary {
  opId: string;
  typeLabel: string;
  rawType: string;
  description: string;
  explanation?: string;
  targetTrackName: string;
  targetClipName?: string;
  before?: {
    timelineStart?: number;
    timelineEnd?: number;
    duration?: number;
    sourceRange?: string;
    trackName?: string;
  };
  after?: {
    timelineStart?: number;
    timelineEnd?: number;
    duration?: number;
    sourceRange?: string;
    trackName?: string;
    segment2?: {
      timelineStart: number;
      duration: number;
      sourceRange: string;
    };
  };
  deltaSummary: string;
  warnings: string[];
}

function formatSec(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function findClipAndTrack(
  timeline: Timeline | null,
  clipId?: string
): { clip: Clip; track: Track } | null {
  if (!timeline || !clipId) return null;
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      return { clip, track };
    }
  }
  return null;
}

function findTrack(timeline: Timeline | null, trackId?: string): Track | null {
  if (!timeline || !trackId) return null;
  return timeline.tracks.find((t) => t.id === trackId) || null;
}

/**
 * Derives a human-readable comparison and preview diff for a proposed operation
 * against the current live timeline state. Never mutates the timeline.
 */
export function deriveOperationDiff(
  op: ProposedOperation,
  timeline: Timeline | null,
  mediaAssets: MediaAsset[] = []
): OperationDiffSummary {
  const warnings: string[] = [];
  const assetMap = new Map<string, MediaAsset>(mediaAssets.map((a) => [a.id, a]));

  const found = findClipAndTrack(timeline, op.clipId);
  const explicitTrack = findTrack(timeline, op.trackId);
  const track = found?.track || explicitTrack;
  const clip = found?.clip;

  const trackName = track?.name || (op.trackId ? `Track ${op.trackId}` : "Unspecified Track");
  const asset = clip ? assetMap.get(clip.assetId) : op.assetId ? assetMap.get(op.assetId) : undefined;
  const clipName = clip?.name || asset?.originalName || (clip ? `Clip (${clip.id.slice(0, 8)})` : op.clipId ? `Clip ${op.clipId}` : undefined);

  switch (op.type) {
    case "split_clip": {
      const splitTime =
        typeof op.params?.splitTime === "number"
          ? op.params.splitTime
          : typeof op.timeRange?.timelineStart === "number"
          ? op.timeRange.timelineStart
          : typeof op.params?.time === "number"
          ? op.params.time
          : undefined;

      if (!clip) {
        warnings.push(`Target clip '${op.clipId || "unknown"}' not found on current timeline.`);
        return {
          opId: op.id,
          typeLabel: "Split Clip",
          rawType: op.type,
          description: op.description || `Split clip at ${splitTime !== undefined ? formatSec(splitTime) : "specified time"}`,
          explanation: op.explanation,
          targetTrackName: trackName,
          targetClipName: clipName,
          deltaSummary: `Split target not located on current timeline.`,
          warnings
        };
      }

      const origDuration = clip.sourceEnd - clip.sourceStart;
      const before = {
        timelineStart: clip.timelineStart,
        timelineEnd: clip.timelineStart + origDuration,
        duration: origDuration,
        sourceRange: `${clip.sourceStart.toFixed(2)}s – ${clip.sourceEnd.toFixed(2)}s`,
        trackName
      };

      if (splitTime === undefined) {
        warnings.push("Operation missing split time parameter.");
        return {
          opId: op.id,
          typeLabel: "Split Clip",
          rawType: op.type,
          description: op.description || "Split clip",
          explanation: op.explanation,
          targetTrackName: trackName,
          targetClipName: clipName,
          before,
          deltaSummary: "Missing split time parameter",
          warnings
        };
      }

      const clipTimelineEnd = clip.timelineStart + origDuration;
      if (splitTime <= clip.timelineStart || splitTime >= clipTimelineEnd) {
        warnings.push(`Split time ${formatSec(splitTime)} is outside clip boundaries [${formatSec(clip.timelineStart)} – ${formatSec(clipTimelineEnd)}].`);
      }

      const seg1Duration = Math.max(0, splitTime - clip.timelineStart);
      const seg2Duration = Math.max(0, origDuration - seg1Duration);
      const splitSourceOffset = clip.sourceStart + seg1Duration;

      const after = {
        timelineStart: clip.timelineStart,
        timelineEnd: splitTime,
        duration: seg1Duration,
        sourceRange: `${clip.sourceStart.toFixed(2)}s – ${splitSourceOffset.toFixed(2)}s`,
        trackName,
        segment2: {
          timelineStart: splitTime,
          duration: seg2Duration,
          sourceRange: `${splitSourceOffset.toFixed(2)}s – ${clip.sourceEnd.toFixed(2)}s`
        }
      };

      return {
        opId: op.id,
        typeLabel: "Split Clip",
        rawType: op.type,
        description: op.description || `Split ${clipName} at ${formatSec(splitTime)}`,
        explanation: op.explanation,
        targetTrackName: trackName,
        targetClipName: clipName,
        before,
        after,
        deltaSummary: `Splits 1 clip (${origDuration.toFixed(2)}s) into 2 segments (${seg1Duration.toFixed(2)}s + ${seg2Duration.toFixed(2)}s) at ${formatSec(splitTime)}`,
        warnings
      };
    }

    case "trim_clip": {
      if (!clip) {
        warnings.push(`Target clip '${op.clipId || "unknown"}' not found on current timeline.`);
        return {
          opId: op.id,
          typeLabel: "Trim Clip",
          rawType: op.type,
          description: op.description || "Trim clip",
          explanation: op.explanation,
          targetTrackName: trackName,
          targetClipName: clipName,
          deltaSummary: "Target clip not found on live timeline.",
          warnings
        };
      }

      const origDuration = clip.sourceEnd - clip.sourceStart;
      const before = {
        timelineStart: clip.timelineStart,
        timelineEnd: clip.timelineStart + origDuration,
        duration: origDuration,
        sourceRange: `${clip.sourceStart.toFixed(2)}s – ${clip.sourceEnd.toFixed(2)}s`,
        trackName
      };

      const newSourceStart =
        typeof op.params?.newSourceStart === "number"
          ? op.params.newSourceStart
          : typeof op.params?.sourceStart === "number"
          ? op.params.sourceStart
          : typeof op.timeRange?.sourceStart === "number"
          ? op.timeRange.sourceStart
          : clip.sourceStart;

      const newSourceEnd =
        typeof op.params?.newSourceEnd === "number"
          ? op.params.newSourceEnd
          : typeof op.params?.sourceEnd === "number"
          ? op.params.sourceEnd
          : typeof op.timeRange?.sourceEnd === "number"
          ? op.timeRange.sourceEnd
          : clip.sourceEnd;

      const newDuration = Math.max(0, newSourceEnd - newSourceStart);
      const deltaDuration = newDuration - origDuration;
      const deltaSign = deltaDuration >= 0 ? "+" : "";

      // Left trim shifts timelineStart
      const deltaLeft = newSourceStart - clip.sourceStart;
      const newTimelineStart = clip.timelineStart + deltaLeft;

      const after = {
        timelineStart: newTimelineStart,
        timelineEnd: newTimelineStart + newDuration,
        duration: newDuration,
        sourceRange: `${newSourceStart.toFixed(2)}s – ${newSourceEnd.toFixed(2)}s`,
        trackName
      };

      return {
        opId: op.id,
        typeLabel: "Trim Clip",
        rawType: op.type,
        description: op.description || `Trim ${clipName} to ${newSourceStart.toFixed(2)}s–${newSourceEnd.toFixed(2)}s`,
        explanation: op.explanation,
        targetTrackName: trackName,
        targetClipName: clipName,
        before,
        after,
        deltaSummary: `Duration: ${origDuration.toFixed(2)}s → ${newDuration.toFixed(2)}s (${deltaSign}${deltaDuration.toFixed(2)}s)`,
        warnings
      };
    }

    case "move_clip": {
      if (!clip) {
        warnings.push(`Target clip '${op.clipId || "unknown"}' not found on current timeline.`);
        return {
          opId: op.id,
          typeLabel: "Move Clip",
          rawType: op.type,
          description: op.description || "Move clip",
          explanation: op.explanation,
          targetTrackName: trackName,
          targetClipName: clipName,
          deltaSummary: "Target clip not found on live timeline.",
          warnings
        };
      }

      const origDuration = clip.sourceEnd - clip.sourceStart;
      const before = {
        timelineStart: clip.timelineStart,
        timelineEnd: clip.timelineStart + origDuration,
        duration: origDuration,
        sourceRange: `${clip.sourceStart.toFixed(2)}s – ${clip.sourceEnd.toFixed(2)}s`,
        trackName
      };

      const newStart =
        typeof op.params?.newTimelineStart === "number"
          ? op.params.newTimelineStart
          : typeof op.params?.timelineStart === "number"
          ? op.params.timelineStart
          : typeof op.timeRange?.timelineStart === "number"
          ? op.timeRange.timelineStart
          : clip.timelineStart;

      const destTrackId = typeof op.params?.targetTrackId === "string" ? op.params.targetTrackId : op.trackId || clip.trackId;
      const destTrack = findTrack(timeline, destTrackId);
      const destTrackName = destTrack?.name || (destTrackId ? `Track ${destTrackId}` : trackName);

      const after = {
        timelineStart: newStart,
        timelineEnd: newStart + origDuration,
        duration: origDuration,
        sourceRange: `${clip.sourceStart.toFixed(2)}s – ${clip.sourceEnd.toFixed(2)}s`,
        trackName: destTrackName
      };

      const trackChanged = destTrackId !== clip.trackId;
      const deltaSummary = trackChanged
        ? `Moves from ${formatSec(clip.timelineStart)} on '${trackName}' → ${formatSec(newStart)} on '${destTrackName}'`
        : `Moves start time: ${formatSec(clip.timelineStart)} → ${formatSec(newStart)}`;

      return {
        opId: op.id,
        typeLabel: "Move Clip",
        rawType: op.type,
        description: op.description || `Move ${clipName} to ${formatSec(newStart)}`,
        explanation: op.explanation,
        targetTrackName: destTrackName,
        targetClipName: clipName,
        before,
        after,
        deltaSummary,
        warnings
      };
    }

    case "delete_clip": {
      if (!clip) {
        warnings.push(`Target clip '${op.clipId || "unknown"}' not found on current timeline.`);
        return {
          opId: op.id,
          typeLabel: "Delete Clip",
          rawType: op.type,
          description: op.description || `Delete clip ${op.clipId || ""}`,
          explanation: op.explanation,
          targetTrackName: trackName,
          targetClipName: clipName,
          deltaSummary: "Target clip not found on live timeline.",
          warnings
        };
      }

      const origDuration = clip.sourceEnd - clip.sourceStart;
      const before = {
        timelineStart: clip.timelineStart,
        timelineEnd: clip.timelineStart + origDuration,
        duration: origDuration,
        sourceRange: `${clip.sourceStart.toFixed(2)}s – ${clip.sourceEnd.toFixed(2)}s`,
        trackName
      };

      return {
        opId: op.id,
        typeLabel: "Delete Clip",
        rawType: op.type,
        description: op.description || `Delete ${clipName} from ${trackName}`,
        explanation: op.explanation,
        targetTrackName: trackName,
        targetClipName: clipName,
        before,
        deltaSummary: `Removes clip entirely (frees ${origDuration.toFixed(2)}s interval [${formatSec(clip.timelineStart)} – ${formatSec(clip.timelineStart + origDuration)}])`,
        warnings
      };
    }

    case "remove_silence": {
      const silenceStart = typeof op.params?.start === "number" ? op.params.start : typeof op.timeRange?.sourceStart === "number" ? op.timeRange.sourceStart : 0;
      const silenceEnd = typeof op.params?.end === "number" ? op.params.end : typeof op.timeRange?.sourceEnd === "number" ? op.timeRange.sourceEnd : 0;
      const silenceDuration = Math.max(0, silenceEnd - silenceStart);

      return {
        opId: op.id,
        typeLabel: "Remove Silence",
        rawType: op.type,
        description: op.description || `Cut silence interval [${formatSec(silenceStart)} – ${formatSec(silenceEnd)}]`,
        explanation: op.explanation,
        targetTrackName: trackName,
        targetClipName: clipName,
        deltaSummary: `Cuts ${silenceDuration.toFixed(2)}s silent interval and ripples downstream clips left`,
        warnings
      };
    }

    default: {
      // Graceful fallback for unknown or future operation types
      return {
        opId: op.id,
        typeLabel: `Operation: ${String(op.type || "unknown")}`,
        rawType: String(op.type || "unknown"),
        description: op.description || `Execute operation '${op.type}'`,
        explanation: op.explanation,
        targetTrackName: trackName,
        targetClipName: clipName,
        deltaSummary: `Custom parameter changes: ${JSON.stringify(op.params || {})}`,
        warnings
      };
    }
  }
}

