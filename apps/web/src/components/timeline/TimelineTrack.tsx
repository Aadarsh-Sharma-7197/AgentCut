import React from "react";
import type { Track } from "@agentcut/shared";
import { TimelineClip } from "./TimelineClip";
import { pixelsToTime } from "../../utils/timelineCalculations";

interface TimelineTrackProps {
  track: Track;
  pps: number;
  timelineWidth: number;
  assetNames: Record<string, string>;
  onSeek: (seconds: number) => void;
}

export const TimelineTrack: React.FC<TimelineTrackProps> = ({
  track,
  pps,
  timelineWidth,
  assetNames,
  onSeek
}) => {
  const getTrackIcon = (type: string) => {
    switch (type) {
      case "video":
        return "🎥";
      case "audio":
        return "🔊";
      case "caption":
        return "💬";
      default:
        return "🎞️";
    }
  };

  const handleLaneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const seekTime = pixelsToTime(clickX, pps);
    onSeek(seekTime);
  };

  return (
    <div className="timeline-track-row">
      <div className={`timeline-track-header track-header-${track.type}`}>
        <div className="track-header-main">
          <div className="track-name-group">
            <span className="track-type-icon">{getTrackIcon(track.type)}</span>
            <span className="track-name" title={track.name}>
              {track.name}
            </span>
          </div>
          <span className="track-type-badge">{track.type}</span>
        </div>
        <div className="track-header-sub">
          <span>{track.clips.length} {track.clips.length === 1 ? "clip" : "clips"}</span>
          <span>{track.enabled ? "Active" : "Muted"}</span>
        </div>
      </div>

      <div
        className="timeline-track-lane"
        style={{ width: `${timelineWidth}px` }}
        onClick={handleLaneClick}
      >
        {track.clips.length === 0 ? (
          <div className="timeline-track-lane-empty">Empty track</div>
        ) : (
          track.clips.map((clip) => (
            <TimelineClip
              key={clip.id}
              clip={clip}
              trackType={track.type}
              pps={pps}
              assetName={assetNames[clip.assetId]}
            />
          ))
        )}
      </div>
    </div>
  );
};

