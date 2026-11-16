import React, { useState, useRef, useEffect } from "react";
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
  isFirstTrack?: boolean;
  isLastTrack?: boolean;
  onSeek: (seconds: number) => void;
  onSelectClip: (clipId: string) => void;
  onDeselect: () => void;
  onClipDragStart: (clip: Clip, e: React.PointerEvent<HTMLDivElement>) => void;
  onClipTrimStart?: (clip: Clip, edge: "left" | "right", e: React.PointerEvent<HTMLDivElement>) => void;
  onRenameTrack?: (trackId: string, newName: string) => void;
  onMoveTrack?: (trackId: string, direction: "up" | "down") => void;
  onDeleteTrack?: (trackId: string) => void;
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
  isFirstTrack = false,
  isLastTrack = false,
  onSeek,
  onSelectClip,
  onDeselect,
  onClipDragStart,
  onClipTrimStart,
  onRenameTrack,
  onMoveTrack,
  onDeleteTrack
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameInput, setNameInput] = useState(track.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setNameInput(track.name);
  }, [track.name]);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  const handleStartRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNameInput(track.name);
    setIsRenaming(true);
  };

  const handleSaveRename = (e?: React.FormEvent | React.MouseEvent) => {
    if (e) e.stopPropagation();
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== track.name && onRenameTrack) {
      onRenameTrack(track.id, trimmed);
    }
    setIsRenaming(false);
  };

  const handleCancelRename = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setNameInput(track.name);
    setIsRenaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSaveRename();
    } else if (e.key === "Escape") {
      handleCancelRename();
    }
  };

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
        {isRenaming ? (
          <div className="track-rename-form" onClick={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              className="track-rename-input"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={handleKeyDown}
              maxLength={40}
              placeholder="Track name"
            />
            <button
              type="button"
              className="track-rename-btn track-rename-save"
              title="Save name (Enter)"
              onClick={handleSaveRename}
              disabled={!nameInput.trim()}
            >
              ✓
            </button>
            <button
              type="button"
              className="track-rename-btn track-rename-cancel"
              title="Cancel (Esc)"
              onClick={handleCancelRename}
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="track-header-main">
            <div
              className="track-name-group"
              onDoubleClick={handleStartRename}
              title={`${track.name} (Double-click to rename)`}
            >
              <span className="track-type-icon">{getTrackIcon(track.type)}</span>
              <span className="track-name">
                {track.name}
              </span>
            </div>
            <span className="track-type-badge">{track.type}</span>
          </div>
        )}

        <div className="track-header-sub">
          <span className="track-clips-count">
            {track.clips.length} {track.clips.length === 1 ? "clip" : "clips"}
          </span>
          <div className="track-actions-group">
            <button
              type="button"
              className="track-action-btn"
              title="Rename track"
              onClick={handleStartRename}
            >
              ✏️
            </button>
            <button
              type="button"
              className="track-action-btn"
              title={isFirstTrack ? "Track is already at the top" : "Move track up"}
              disabled={isFirstTrack}
              onClick={(e) => {
                e.stopPropagation();
                onMoveTrack?.(track.id, "up");
              }}
            >
              ▲
            </button>
            <button
              type="button"
              className="track-action-btn"
              title={isLastTrack ? "Track is already at the bottom" : "Move track down"}
              disabled={isLastTrack}
              onClick={(e) => {
                e.stopPropagation();
                onMoveTrack?.(track.id, "down");
              }}
            >
              ▼
            </button>
            <button
              type="button"
              className={`track-action-btn ${
                track.clips.length > 0 ? "track-delete-disabled" : "track-delete-btn"
              }`}
              title={
                track.clips.length > 0
                  ? `Cannot delete track with clips (${track.clips.length} clip${
                      track.clips.length === 1 ? "" : "s"
                    }). Remove clips first.`
                  : "Delete empty track"
              }
              disabled={track.clips.length > 0}
              onClick={(e) => {
                e.stopPropagation();
                if (track.clips.length === 0) {
                  onDeleteTrack?.(track.id);
                }
              }}
            >
              🗑️
            </button>
          </div>
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

