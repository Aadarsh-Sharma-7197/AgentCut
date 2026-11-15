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
  isTrimming?: boolean;
  trimPreviewClip?: Clip;
  onSelect?: (clipId: string) => void;
  onDragStart?: (clip: Clip, e: React.PointerEvent<HTMLDivElement>) => void;
  onTrimStart?: (clip: Clip, edge: "left" | "right", e: React.PointerEvent<HTMLDivElement>) => void;
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
  isTrimming = false,
  trimPreviewClip,
  onSelect,
  onDragStart,
  onTrimStart
}) => {
  const effectiveClip =
    isTrimming && trimPreviewClip
      ? trimPreviewClip
      : isDragging && typeof dragTimelineStart === "number"
      ? { ...clip, timelineStart: dragTimelineStart }
      : clip;

  const { left, width, duration } = calculateClipGeometry(effectiveClip, pps);

  const displayName = effectiveClip.name || assetName || `Clip ${effectiveClip.id}`;
  const themeClass = `timeline-clip-${trackType}`;
  const selectedClass = isSelected ? "timeline-clip-selected" : "";
  const draggingClass = isDragging ? "timeline-clip-dragging" : "";
  const trimmingClass = isTrimming ? "timeline-clip-trimming" : "";
  const incompatibleClass = isDragging && !isTargetCompatible ? "timeline-clip-incompatible" : "";

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only react to main (left) click
    if (e.button !== 0) return;
    e.stopPropagation();
    if (onDragStart) {
      onDragStart(clip, e);
    }
  };

  const handleTrimPointerDown = (
    edge: "left" | "right",
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    if (e.button !== 0) return;
    // Crucial: Stop propagation so clip dragging is NOT triggered
    e.stopPropagation();
    if (onTrimStart) {
      onTrimStart(clip, edge, e);
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
      className={`timeline-clip ${themeClass} ${selectedClass} ${draggingClass} ${trimmingClass} ${incompatibleClass}`}
      style={{
        left: `${left}px`,
        width: `${width}px`
      }}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      title={`${displayName}\nDuration: ${duration.toFixed(2)}s\nTimeline Start: ${effectiveClip.timelineStart.toFixed(2)}s\nSource Range: ${effectiveClip.sourceStart.toFixed(2)}s - ${effectiveClip.sourceEnd.toFixed(2)}s`}
    >
      {/* Left Trim Handle */}
      <div
        className="trim-handle trim-handle-left"
        data-testid="trim-handle-left"
        title="Drag to trim start of clip"
        onPointerDown={(e) => handleTrimPointerDown("left", e)}
      >
        <div className="trim-handle-grip" />
      </div>

      <div className="clip-content-container">
        <div className="clip-title-row">
          <span className="clip-title">
            {isDragging && !isTargetCompatible ? `⚠️ ${displayName} (Incompatible)` : displayName}
          </span>
        </div>
        <div className="clip-meta-row">
          <span className="clip-duration-badge">{formatClipDuration(duration)}</span>
          {width > 120 && (
            <span className="clip-time-range">
              {effectiveClip.sourceStart.toFixed(1)}s–{effectiveClip.sourceEnd.toFixed(1)}s
            </span>
          )}
        </div>
      </div>

      {/* Right Trim Handle */}
      <div
        className="trim-handle trim-handle-right"
        data-testid="trim-handle-right"
        title="Drag to trim end of clip"
        onPointerDown={(e) => handleTrimPointerDown("right", e)}
      >
        <div className="trim-handle-grip" />
      </div>
    </div>
  );
};

