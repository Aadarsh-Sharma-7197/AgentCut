import React from "react";
import type { Track, Clip } from "@agentcut/shared";
import { TimelineClip } from "./TimelineClip";
import { pixelsToTime } from "../../utils/timelineCalculations";

interface TimelineTrackProps {
  track: Track;
  pps: number;
  timelineWidth: number;
  assetNames: Record<string, string>;
  selectedClipId: string | null;
  draggedClipId: string | null;
  draggedTimelineStart?: number;
  trimClipId?: string | null;
  trimPreviewClip?: Clip;
  isCurrentDropTarget: boolean;
  isDropCompatible: boolean;
  onSeek: (seconds: number) => void;
  onSelectClip: (clipId: string) => void;
  onDeselect: () => void;
  onClipDragStart: (clip: Clip, e: React.PointerEvent<HTMLDivElement>) => void;
  onClipTrimStart?: (clip: Clip, edge: "left" | "right", e: React.PointerEvent<HTMLDivElement>) => void;
}

export const TimelineTrack: React.FC<TimelineTrackProps> = ({
  track,
  pps,
  timelineWidth,
  assetNames,
  selectedClipId,
  draggedClipId,
  draggedTimelineStart,
  trimClipId,
  trimPreviewClip,
  isCurrentDropTarget,
  isDropCompatible,
  onSeek,
  onSelectClip,
  onDeselect,
  onClipDragStart,
  onClipTrimStart
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
    onDeselect();
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const seekTime = pixelsToTime(clickX, pps);
    onSeek(seekTime);
  };

  const dropTargetClass = isCurrentDropTarget
    ? isDropCompatible
      ? "track-lane-drop-target"
      : "track-lane-drop-incompatible"
    : "";

  return (
    <div
      className="timeline-track-row"
      data-track-id={track.id}
      data-track-type={track.type}
    >
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
        className={`timeline-track-lane ${dropTargetClass}`}
        data-track-id={track.id}
        data-track-type={track.type}
        style={{ width: `${timelineWidth}px` }}
        onClick={handleLaneClick}
      >
        {track.clips.length === 0 ? (
          <div className="timeline-track-lane-empty">Empty track</div>
        ) : (
          track.clips.map((clip) => {
            const isDragging = draggedClipId === clip.id;
            const isTrimming = trimClipId === clip.id;
            return (
              <TimelineClip
                key={clip.id}
                clip={clip}
                trackType={track.type}
                pps={pps}
                assetName={assetNames[clip.assetId]}
                isSelected={selectedClipId === clip.id}
                isDragging={isDragging}
                isTargetCompatible={isDragging ? isDropCompatible : true}
                dragTimelineStart={isDragging ? draggedTimelineStart : undefined}
                isTrimming={isTrimming}
                trimPreviewClip={isTrimming ? trimPreviewClip : undefined}
                onSelect={onSelectClip}
                onDragStart={onClipDragStart}
                onTrimStart={onClipTrimStart}
              />
            );
          })
        )}
      </div>
    </div>
  );
};

