import React, { useMemo } from "react";
import { getRulerTicks, pixelsToTime } from "../../utils/timelineCalculations";

interface TimelineRulerProps {
  timelineDuration: number;
  pps: number;
  timelineWidth: number;
  onSeek: (seconds: number) => void;
}

export const TimelineRuler: React.FC<TimelineRulerProps> = ({
  timelineDuration,
  pps,
  timelineWidth,
  onSeek
}) => {
  const totalSeconds = Math.max(30, timelineDuration + 10);
  const ticks = useMemo(() => getRulerTicks(totalSeconds, pps), [totalSeconds, pps]);

  const handleRulerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const seekTime = pixelsToTime(clickX, pps);
    onSeek(seekTime);
  };

  return (
    <div className="timeline-ruler-row">
      <div className="ruler-corner-header">
        <span>Tracks / Time</span>
      </div>

      <div
        className="ruler-surface"
        style={{ width: `${timelineWidth}px` }}
        onClick={handleRulerClick}
      >
        {ticks.map((tick, index) => (
          <div
            key={index}
            className={`ruler-tick ${tick.isMajor ? "ruler-tick-major" : "ruler-tick-minor"}`}
            style={{ left: `${tick.position}px` }}
          >
            {tick.isMajor && tick.label && (
              <span className="ruler-tick-label">{tick.label}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

