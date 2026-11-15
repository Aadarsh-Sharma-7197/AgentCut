import type { Timeline, Track, Clip, TrackType } from "./types.js";
import type { MediaAsset } from "../index.js";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export class TimelineValidationError extends Error {
  public readonly errors: ValidationError[];

  constructor(message: string, errors: ValidationError[]) {
    super(message);
    this.name = "TimelineValidationError";
    this.errors = errors;
  }
}

const VALID_TRACK_TYPES: readonly TrackType[] = ["video", "audio", "caption"];

export function validateClip(
  clip: Clip,
  options?: {
    track?: Track;
    asset?: MediaAsset;
    pathPrefix?: string;
  }
): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = options?.pathPrefix || `clip[${clip.id || "unknown"}]`;

  if (!clip.id || typeof clip.id !== "string" || clip.id.trim() === "") {
    errors.push({ path: `${prefix}.id`, message: "Clip ID must be a non-empty string." });
  }

  if (!clip.assetId || typeof clip.assetId !== "string" || clip.assetId.trim() === "") {
    errors.push({ path: `${prefix}.assetId`, message: "Clip assetId must be a non-empty string referencing a media asset." });
  }

  if (!clip.trackId || typeof clip.trackId !== "string" || clip.trackId.trim() === "") {
    errors.push({ path: `${prefix}.trackId`, message: "Clip trackId must be a non-empty string." });
  }

  // Timing validations
  if (typeof clip.sourceStart !== "number" || !Number.isFinite(clip.sourceStart)) {
    errors.push({ path: `${prefix}.sourceStart`, message: "sourceStart must be a finite number." });
  } else if (clip.sourceStart < 0) {
    errors.push({ path: `${prefix}.sourceStart`, message: `sourceStart cannot be negative (got ${clip.sourceStart}).` });
  }

  if (typeof clip.sourceEnd !== "number" || !Number.isFinite(clip.sourceEnd)) {
    errors.push({ path: `${prefix}.sourceEnd`, message: "sourceEnd must be a finite number." });
  }

  if (
    typeof clip.sourceStart === "number" &&
    Number.isFinite(clip.sourceStart) &&
    typeof clip.sourceEnd === "number" &&
    Number.isFinite(clip.sourceEnd)
  ) {
    if (clip.sourceEnd <= clip.sourceStart) {
      errors.push({
        path: `${prefix}.sourceEnd`,
        message: `sourceEnd (${clip.sourceEnd}) must be strictly greater than sourceStart (${clip.sourceStart}).`
      });
    }
  }

  if (typeof clip.timelineStart !== "number" || !Number.isFinite(clip.timelineStart)) {
    errors.push({ path: `${prefix}.timelineStart`, message: "timelineStart must be a finite number." });
  } else if (clip.timelineStart < 0) {
    errors.push({ path: `${prefix}.timelineStart`, message: `timelineStart cannot be negative (got ${clip.timelineStart}).` });
  }

  // Track reference consistency
  if (options?.track && clip.trackId !== options.track.id) {
    errors.push({
      path: `${prefix}.trackId`,
      message: `Clip trackId '${clip.trackId}' does not match containing track ID '${options.track.id}'.`
    });
  }

  // Track & Media Asset compatibility checks
  if (options?.track && options?.asset) {
    const { track, asset } = options;
    if (track.type === "video") {
      if (!asset.videoCodec || asset.width <= 0 || asset.height <= 0) {
        errors.push({
          path: `${prefix}.assetId`,
          message: `Asset '${asset.id}' has no valid video stream and cannot be placed on video track '${track.id}'.`
        });
      }
    } else if (track.type === "audio") {
      if (!asset.audioCodec) {
        errors.push({
          path: `${prefix}.assetId`,
          message: `Asset '${asset.id}' has no audio stream and cannot be placed on audio track '${track.id}'.`
        });
      }
    } else if (track.type === "caption") {
      // Caption tracks represent text/subtitle layers and cannot accept binary video or audio media assets
      const isCaptionAsset =
        asset.mimeType.includes("text") ||
        asset.mimeType.includes("subrip") ||
        asset.mimeType.includes("vtt") ||
        asset.format.toLowerCase().includes("srt") ||
        asset.format.toLowerCase().includes("vtt") ||
        asset.format.toLowerCase().includes("caption");

      if (!isCaptionAsset) {
        errors.push({
          path: `${prefix}.assetId`,
          message: `Asset '${asset.id}' (${asset.originalName}) is a ${asset.videoCodec ? "video" : "audio"} asset and cannot be placed on caption track '${track.id}'. Caption tracks accept only subtitle or text caption assets.`
        });
      }
    }
  }

  return errors;
}

export function validateTrack(
  track: Track,
  options?: {
    pathPrefix?: string;
    assetsMap?: Map<string, MediaAsset>;
  }
): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = options?.pathPrefix || `track[${track.id || "unknown"}]`;

  if (!track.id || typeof track.id !== "string" || track.id.trim() === "") {
    errors.push({ path: `${prefix}.id`, message: "Track ID must be a non-empty string." });
  }

  if (!track.name || typeof track.name !== "string" || track.name.trim() === "") {
    errors.push({ path: `${prefix}.name`, message: "Track name must be a non-empty string." });
  }

  if (!VALID_TRACK_TYPES.includes(track.type)) {
    errors.push({
      path: `${prefix}.type`,
      message: `Invalid track type '${track.type}'. Must be one of: ${VALID_TRACK_TYPES.join(", ")}.`
    });
  }

  if (typeof track.index !== "number" || !Number.isInteger(track.index) || track.index < 0) {
    errors.push({ path: `${prefix}.index`, message: "Track index must be a non-negative integer." });
  }

  if (typeof track.enabled !== "boolean") {
    errors.push({ path: `${prefix}.enabled`, message: "Track enabled property must be a boolean." });
  }

  if (!Array.isArray(track.clips)) {
    errors.push({ path: `${prefix}.clips`, message: "Track clips must be an array." });
  } else {
    track.clips.forEach((clip, cIdx) => {
      const asset = options?.assetsMap?.get(clip.assetId);
      const clipErrors = validateClip(clip, {
        track,
        asset,
        pathPrefix: `${prefix}.clips[${cIdx}]`
      });
      errors.push(...clipErrors);
    });
  }

  return errors;
}

export interface ValidateTimelineOptions {
  assets?: MediaAsset[] | Map<string, MediaAsset>;
}

export function validateTimeline(
  timeline: Timeline,
  options?: ValidateTimelineOptions
): ValidationResult {
  const errors: ValidationError[] = [];

  // 1. Timeline and Project ID checks
  if (!timeline.id || typeof timeline.id !== "string" || timeline.id.trim() === "") {
    errors.push({ path: "timeline.id", message: "Timeline ID must be a non-empty string." });
  }

  if (!timeline.projectId || typeof timeline.projectId !== "string" || timeline.projectId.trim() === "") {
    errors.push({ path: "timeline.projectId", message: "Project ID must be a non-empty string." });
  }

  // 2. Settings check
  if (!timeline.settings || typeof timeline.settings !== "object") {
    errors.push({ path: "timeline.settings", message: "Timeline settings must be defined." });
  } else {
    if (
      typeof timeline.settings.frameRate !== "number" ||
      !Number.isFinite(timeline.settings.frameRate) ||
      timeline.settings.frameRate <= 0
    ) {
      errors.push({
        path: "timeline.settings.frameRate",
        message: "Timeline frameRate must be a positive finite number."
      });
    }
  }

  // Build assets lookup map if provided
  let assetsMap: Map<string, MediaAsset> | undefined;
  if (options?.assets) {
    if (options.assets instanceof Map) {
      assetsMap = options.assets;
    } else if (Array.isArray(options.assets)) {
      assetsMap = new Map(options.assets.map((a) => [a.id, a]));
    }
  }

  // 3. Track checks & uniqueness
  if (!Array.isArray(timeline.tracks)) {
    errors.push({ path: "timeline.tracks", message: "Timeline tracks must be an array." });
    return { valid: false, errors };
  }

  const seenTrackIds = new Set<string>();
  const seenClipIds = new Set<string>();

  timeline.tracks.forEach((track, tIdx) => {
    if (track.id) {
      if (seenTrackIds.has(track.id)) {
        errors.push({
          path: `timeline.tracks[${tIdx}].id`,
          message: `Duplicate track ID '${track.id}' found.`
        });
      } else {
        seenTrackIds.add(track.id);
      }
    }

    const trackErrors = validateTrack(track, {
      pathPrefix: `timeline.tracks[${tIdx}]`,
      assetsMap
    });
    errors.push(...trackErrors);

    // Check clip uniqueness across entire timeline
    if (Array.isArray(track.clips)) {
      track.clips.forEach((clip, cIdx) => {
        if (clip.id) {
          if (seenClipIds.has(clip.id)) {
            errors.push({
              path: `timeline.tracks[${tIdx}].clips[${cIdx}].id`,
              message: `Duplicate clip ID '${clip.id}' found on timeline.`
            });
          } else {
            seenClipIds.add(clip.id);
          }
        }

        // If asset catalog was provided, verify clip references an existing media asset
        if (assetsMap && clip.assetId && !assetsMap.has(clip.assetId)) {
          errors.push({
            path: `timeline.tracks[${tIdx}].clips[${cIdx}].assetId`,
            message: `Clip '${clip.id}' references nonexistent media asset '${clip.assetId}'.`
          });
        }
      });
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

