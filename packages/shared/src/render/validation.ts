import type { RenderPlan, RenderPlanValidationResult, RenderClip } from "./types.js";

/**
 * Validates a structured RenderPlan purely against domain rules.
 * This runs on both client and server before any render job can be accepted.
 */
export function validateRenderPlan(plan: RenderPlan): RenderPlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Identity validation
  if (!plan.projectId || typeof plan.projectId !== "string" || plan.projectId.trim() === "") {
    errors.push("Render plan must specify a valid non-empty projectId.");
  }
  if (!plan.timelineId || typeof plan.timelineId !== "string" || plan.timelineId.trim() === "") {
    errors.push("Render plan must specify a valid non-empty timelineId.");
  }

  // 2. Settings: dimensions validation
  const { width, height, frameRate } = plan.settings;
  if (!Number.isInteger(width) || width < 16 || width > 7680) {
    errors.push(`Invalid render width: ${width}. Must be an integer between 16 and 7680.`);
  } else if (width % 2 !== 0) {
    errors.push(`Render width (${width}) must be an even number for H.264 / yuv420p video encoding.`);
  }

  if (!Number.isInteger(height) || height < 16 || height > 4320) {
    errors.push(`Invalid render height: ${height}. Must be an integer between 16 and 4320.`);
  } else if (height % 2 !== 0) {
    errors.push(`Render height (${height}) must be an even number for H.264 / yuv420p video encoding.`);
  }

  // 3. Settings: frame rate validation
  if (typeof frameRate !== "number" || !Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 120) {
    errors.push(`Invalid render frameRate: ${frameRate}. Must be a finite number between 1 and 120 fps.`);
  }

  // 4. Output duration & empty timeline check
  if (typeof plan.duration !== "number" || !Number.isFinite(plan.duration) || plan.duration <= 0) {
    errors.push("Render plan output duration must be a positive number greater than 0. Timeline contains no renderable clips.");
  }

  // 5. Track checks & unsupported configurations
  const enabledTracks = plan.tracks.filter((t) => t.enabled);
  if (enabledTracks.length === 0) {
    errors.push("No enabled tracks found in timeline. At least one track must be enabled for rendering.");
  }

  for (const track of plan.tracks) {
    // Caption tracks are not yet supported for rendering
    if (track.type === "caption" && track.clips.length > 0 && track.enabled) {
      errors.push(
        `Track '${track.name}' is a caption track with ${track.clips.length} clip(s). Caption tracks are not yet supported for video rendering.`
      );
    }

    // Check for overlapping clips within the same track (unsupported for single-stream cut rendering)
    const sortedClips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
    for (let i = 0; i < sortedClips.length - 1; i++) {
      const current = sortedClips[i];
      const next = sortedClips[i + 1];
      // Tolerance of 0.001s (1ms) to avoid floating point precision false positives
      if (current.timelineEnd > next.timelineStart + 0.001) {
        errors.push(
          `Track '${track.name}' has overlapping clips '${current.clipId}' (ends at ${current.timelineEnd.toFixed(3)}s) and '${next.clipId}' (starts at ${next.timelineStart.toFixed(3)}s). Overlapping clips on a single track are not supported for rendering.`
        );
      }
    }
  }

  // 5b. Multi-track video compositing overlap check across enabled video tracks
  const sortedVideoClips = [...plan.videoClips].sort((a, b) => a.timelineStart - b.timelineStart);
  for (let i = 0; i < sortedVideoClips.length - 1; i++) {
    const current = sortedVideoClips[i];
    const next = sortedVideoClips[i + 1];
    if (current.timelineEnd > next.timelineStart + 0.001 && current.trackId !== next.trackId) {
      errors.push(
        `Multi-track video compositing is not yet supported. Video clips '${current.clipId}' (track '${current.trackId}') and '${next.clipId}' (track '${next.trackId}') overlap on the timeline (${current.timelineStart.toFixed(2)}s-${current.timelineEnd.toFixed(2)}s vs ${next.timelineStart.toFixed(2)}s-${next.timelineEnd.toFixed(2)}s). Overlapping video tracks cannot be composited in this version.`
      );
    }
  }

  // 5c. Multi-track audio mixing overlap check across enabled audio tracks
  const sortedAudioClips = [...plan.audioClips].sort((a, b) => a.timelineStart - b.timelineStart);
  for (let i = 0; i < sortedAudioClips.length - 1; i++) {
    const current = sortedAudioClips[i];
    const next = sortedAudioClips[i + 1];
    if (current.timelineEnd > next.timelineStart + 0.001 && current.trackId !== next.trackId) {
      errors.push(
        `Multi-track audio mixing is not yet supported. Audio clips '${current.clipId}' (track '${current.trackId}') and '${next.clipId}' (track '${next.trackId}') overlap on the timeline (${current.timelineStart.toFixed(2)}s-${current.timelineEnd.toFixed(2)}s vs ${next.timelineStart.toFixed(2)}s-${next.timelineEnd.toFixed(2)}s). Overlapping audio tracks cannot be mixed in this version.`
      );
    }
  }

  // 6. Clip timing and source boundary checks
  const allClips: RenderClip[] = [];
  for (const track of plan.tracks) {
    for (const clip of track.clips) {
      allClips.push(clip);
    }
  }

  for (const clip of allClips) {
    if (!clip.clipId || typeof clip.clipId !== "string" || clip.clipId.trim() === "") {
      errors.push("Clip must have a non-empty clipId.");
    }
    if (!clip.assetId || typeof clip.assetId !== "string" || clip.assetId.trim() === "") {
      errors.push(`Clip '${clip.clipId}' must reference a non-empty assetId.`);
    }

    // Finite non-negative numbers
    if (typeof clip.sourceStart !== "number" || !Number.isFinite(clip.sourceStart) || clip.sourceStart < 0) {
      errors.push(`Clip '${clip.clipId}' has invalid sourceStart: ${clip.sourceStart}. Must be a finite non-negative number.`);
    }
    if (typeof clip.sourceEnd !== "number" || !Number.isFinite(clip.sourceEnd) || clip.sourceEnd <= 0) {
      errors.push(`Clip '${clip.clipId}' has invalid sourceEnd: ${clip.sourceEnd}. Must be a finite positive number.`);
    }
    if (clip.sourceEnd <= clip.sourceStart) {
      errors.push(`Clip '${clip.clipId}' has invalid source interval: sourceEnd (${clip.sourceEnd}) must be strictly greater than sourceStart (${clip.sourceStart}).`);
    }
    if (typeof clip.timelineStart !== "number" || !Number.isFinite(clip.timelineStart) || clip.timelineStart < 0) {
      errors.push(`Clip '${clip.clipId}' has invalid timelineStart: ${clip.timelineStart}. Must be a finite non-negative number.`);
    }
    if (typeof clip.duration !== "number" || !Number.isFinite(clip.duration) || clip.duration <= 0) {
      errors.push(`Clip '${clip.clipId}' has invalid derived duration: ${clip.duration}.`);
    }
  }

  // 7. Output configuration validation
  if (plan.output.format !== "mp4") {
    errors.push(`Unsupported output format '${plan.output.format}'. Only 'mp4' is currently supported.`);
  }
  if (plan.output.videoCodec !== "libx264" && plan.output.videoCodec !== "h264") {
    errors.push(`Unsupported video codec '${plan.output.videoCodec}'. Only 'libx264' / 'h264' is supported.`);
  }
  if (plan.output.audioCodec !== "aac") {
    errors.push(`Unsupported audio codec '${plan.output.audioCodec}'. Only 'aac' is supported.`);
  }
  if (plan.output.pixelFormat !== "yuv420p") {
    errors.push(`Unsupported pixel format '${plan.output.pixelFormat}'. Only 'yuv420p' is supported for universal MP4 compatibility.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
