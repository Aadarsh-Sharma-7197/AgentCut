import React from "react";
import type { Clip, TrackType } from "@agentcut/shared";
import { calculateClipGeometry, formatClipDuration } from "../../utils/timelineCalculations";

interface TimelineClipProps {
  clip: Clip;
  trackType: TrackType;
  pps: number;
  assetName?: string;
  isSelected?: boolean;
  isDragging?: boolean;
  isTargetCompatible?: boolean;
  dragTimelineStart?: number;
  onSelect?: (clipId: string) => void;
  onDragStart?: (clip: Clip, e: React.PointerEvent<HTMLDivElement>) => void;
}

export const TimelineClip: React.FC<TimelineClipProps> = ({
  clip,
  trackType,
  pps,
  assetName,
  isSelected = false,
  isDragging = false,
  isTargetCompatible = true,
  dragTimelineStart,
  onSelect,
  onDragStart
}) => {
  const effectiveStart =
    isDragging && typeof dragTimelineStart === "number"
      ? dragTimelineStart
      : clip.timelineStart;

  const { left, width, duration } = calculateClipGeometry(
    { ...clip, timelineStart: effectiveStart },
    pps
  );

  const displayName = clip.name || assetName || `Clip ${clip.id}`;
  const themeClass = `timeline-clip-${trackType}`;
  const selectedClass = isSelected ? "timeline-clip-selected" : "";
  const draggingClass = isDragging ? "timeline-clip-dragging" : "";
  const incompatibleClass = isDragging && !isTargetCompatible ? "timeline-clip-incompatible" : "";

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only react to main (left) click
    if (e.button !== 0) return;
    e.stopPropagation();
    if (onDragStart) {
      onDragStart(clip, e);
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (onSelect) {
      onSelect(clip.id);
    }
  };

  return (
    <div
      className={`timeline-clip ${themeClass} ${selectedClass} ${draggingClass} ${incompatibleClass}`}
      style={{
        left: `${left}px`,
        width: `${width}px`
      }}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      title={`${displayName}\nDuration: ${duration.toFixed(2)}s\nTimeline Start: ${effectiveStart.toFixed(2)}s\nSource Range: ${clip.sourceStart.toFixed(2)}s - ${clip.sourceEnd.toFixed(2)}s`}
    >
      <div className="clip-title-row">
        <span className="clip-title">
          {isDragging && !isTargetCompatible ? `⚠️ ${displayName} (Incompatible)` : displayName}
        </span>
      </div>
      <div className="clip-meta-row">
        <span className="clip-duration-badge">{formatClipDuration(duration)}</span>
        {width > 120 && (
          <span className="clip-time-range">
            {clip.sourceStart.toFixed(1)}s–{clip.sourceEnd.toFixed(1)}s
          </span>
        )}
      </div>
    </div>
  );
};

