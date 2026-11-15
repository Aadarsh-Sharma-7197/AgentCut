import React from "react";
import type { Clip, TrackType } from "@agentcut/shared";
import { calculateClipGeometry, formatClipDuration } from "../../utils/timelineCalculations";

interface TimelineClipProps {
  clip: Clip;
  trackType: TrackType;
  pps: number;
  assetName?: string;
}

export const TimelineClip: React.FC<TimelineClipProps> = ({
  clip,
  trackType,
  pps,
  assetName
}) => {
  const { left, width, duration } = calculateClipGeometry(clip, pps);

  const displayName = clip.name || assetName || `Clip ${clip.id}`;
  const themeClass = `timeline-clip-${trackType}`;

  return (
    <div
      className={`timeline-clip ${themeClass}`}
      style={{
        left: `${left}px`,
        width: `${width}px`
      }}
      title={`${displayName}\nDuration: ${duration.toFixed(2)}s\nTimeline Start: ${clip.timelineStart.toFixed(2)}s\nSource Range: ${clip.sourceStart.toFixed(2)}s - ${clip.sourceEnd.toFixed(2)}s`}
    >
      <div className="clip-title-row">
        <span className="clip-title">{displayName}</span>
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

