import React from "react";
import { timeToPixels } from "../../utils/timelineCalculations";

interface TimelinePlayheadProps {
  currentTime: number;
  pps: number;
  headerWidth?: number;
}

export const TimelinePlayhead: React.FC<TimelinePlayheadProps> = ({
  currentTime,
  pps,
  headerWidth = 190
}) => {
  const pixelPosition = headerWidth + timeToPixels(currentTime, pps);

  return (
    <>
      <div
        className="timeline-playhead-head"
        style={{ left: `${pixelPosition}px` }}
      />
      <div
        className="timeline-playhead-line"
        style={{ left: `${pixelPosition}px` }}
      />
    </>
  );
};

