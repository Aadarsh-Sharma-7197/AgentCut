import type { Clip } from "@agentcut/shared";

export const BASE_PIXELS_PER_SECOND = 50;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4.0;
export const DEFAULT_ZOOM = 1.0;
export const ZOOM_STEP = 0.25;

/**
 * Calculates effective pixels per second based on zoom multiplier.
 */
export function calculatePixelsPerSecond(zoom: number): number {
  const clampedZoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
  return Math.max(10, BASE_PIXELS_PER_SECOND * clampedZoom);
}

/**
 * Converts timeline time (seconds) to horizontal pixel position.
 */
export function timeToPixels(seconds: number, pps: number): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return 0;
  }
  return seconds * pps;
}

/**
 * Converts horizontal pixel coordinate to timeline time (seconds).
 */
export function pixelsToTime(pixels: number, pps: number): number {
  if (typeof pixels !== "number" || !Number.isFinite(pixels) || pixels < 0 || pps <= 0) {
    return 0;
  }
  return pixels / pps;
}

export interface ClipGeometry {
  left: number;
  width: number;
  duration: number;
}

/**
 * Calculates rendering geometry (left offset, width in px) for a clip.
 * Enforces positive dimensions and minimum visual width for usability.
 */
export function calculateClipGeometry(
  clip: Pick<Clip, "timelineStart" | "sourceStart" | "sourceEnd">,
  pps: number
): ClipGeometry {
  const duration = Math.max(0, clip.sourceEnd - clip.sourceStart);
  const left = Math.max(0, clip.timelineStart * pps);
  // Ensure clip is at least 6px wide so tiny cuts remain visible and selectable
  const width = Math.max(6, duration * pps);

  return { left, width, duration };
}

/**
 * Calculates the total pixel width of the scrollable timeline area.
 * Always includes a buffer so clips at the very end don't touch the right border.
 */
export function calculateTimelineWidth(
  timelineDuration: number,
  pps: number,
  minWidth = 800
): number {
  const duration = Math.max(0, Number.isFinite(timelineDuration) ? timelineDuration : 0);
  // Provide 10s of trailing workspace buffer or at least 30s total visual canvas
  const totalSeconds = Math.max(30, duration + 10);
  return Math.max(minWidth, totalSeconds * pps);
}

export interface RulerTick {
  time: number;
  position: number;
  isMajor: boolean;
  label?: string;
}

/**
 * Computes ruler tick marks (both major with timestamps and minor ticks)
 * adapting dynamically to the current pixels-per-second scale.
 */
export function getRulerTicks(totalSeconds: number, pps: number): RulerTick[] {
  const duration = Math.max(30, totalSeconds);

  // Determine major interval in seconds so major ticks are spaced ~60px to 140px apart
  const candidateMajorIntervals = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let majorInterval = 5;

  for (const interval of candidateMajorIntervals) {
    if (interval * pps >= 60) {
      majorInterval = interval;
      break;
    }
  }

  // Minor ticks are subdivisions of the major interval
  const minorDivisions = majorInterval >= 5 ? 5 : 2;
  const minorInterval = majorInterval / minorDivisions;

  const ticks: RulerTick[] = [];
  const maxTime = duration;

  // Add ticks up to maxTime
  for (let t = 0; t <= maxTime; t += minorInterval) {
    // Floating point precision rounding
    const roundedTime = Math.round(t * 1000) / 1000;
    const isMajor = Math.abs(roundedTime % majorInterval) < 0.001 || Math.abs((roundedTime % majorInterval) - majorInterval) < 0.001;

    ticks.push({
      time: roundedTime,
      position: roundedTime * pps,
      isMajor,
      label: isMajor ? formatRulerTime(roundedTime) : undefined
    });
  }

  return ticks;
}

/**
 * Compact time formatter for ruler marks (e.g. 0s, 5s, 1:00, 1:30).
 */
export function formatRulerTime(seconds: number): string {
  if (seconds < 60) {
    // If fractional
    if (seconds % 1 !== 0) {
      return `${seconds.toFixed(1)}s`;
    }
    return `${seconds}s`;
  }

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

/**
 * Formats a timestamp into standard timecode format: MM:SS.cc (minutes:seconds.centiseconds).
 */
export function formatTimeCode(totalSeconds: number): string {
  if (typeof totalSeconds !== "number" || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "00:00.00";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const centiseconds = Math.floor((totalSeconds % 1) * 100);

  const pad = (n: number) => n.toString().padStart(2, "0");

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

/**
 * Formats duration in seconds for display on clips (e.g., "4.25s").
 */
export function formatClipDuration(seconds: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "0.00s";
  }
  if (seconds < 10) {
    return `${seconds.toFixed(2)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

