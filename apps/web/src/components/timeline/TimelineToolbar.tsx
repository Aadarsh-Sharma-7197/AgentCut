import React, { useState, useRef, useEffect } from "react";
import type { TrackType } from "@agentcut/shared";
import { formatTimeCode, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from "../../utils/timelineCalculations";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

interface TimelineToolbarProps {
  frameRate: number;
  currentTime: number;
  zoom: number;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  saveStatus?: SaveStatus;
  saveError?: string | null;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  canSplit?: boolean;
  onSplit?: () => void;
  canDelete?: boolean;
  onDelete?: () => void;
  onAddTrack?: (type: TrackType) => void;
  onZoomChange: (newZoom: number) => void;
  onResetZoom: () => void;
}

export const TimelineToolbar: React.FC<TimelineToolbarProps> = ({
  frameRate,
  currentTime,
  zoom,
  isPlaying = false,
  onTogglePlay,
  saveStatus = "idle",
  saveError,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  canSplit = false,
  onSplit,
  canDelete = false,
  onDelete,
  onAddTrack,
  onZoomChange,
  onResetZoom
}) => {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showAddMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showAddMenu]);

  const handleZoomOut = () => {
    const next = Math.max(MIN_ZOOM, Math.round((zoom - ZOOM_STEP) * 100) / 100);
    onZoomChange(next);
  };

  const handleZoomIn = () => {
    const next = Math.min(MAX_ZOOM, Math.round((zoom + ZOOM_STEP) * 100) / 100);
    onZoomChange(next);
  };

  return (
    <div className="timeline-toolbar">
      <div className="timeline-toolbar-left">
        <h3 className="timeline-title">
          <span>Timeline</span>
        </h3>
        <span className="timeline-badge">{frameRate} fps</span>
        {saveStatus === "saving" && (
          <span className="save-status save-status-saving">
            <span className="spinner" style={{ width: "10px", height: "10px", borderWidth: "2px", display: "inline-block" }}></span>
            Saving...
          </span>
        )}
        {saveStatus === "saved" && (
          <span className="save-status save-status-saved">✓ Saved</span>
        )}
        {saveStatus === "error" && (
          <span className="save-status save-status-error" title={saveError || "Failed to save"}>
            ⚠️ Save Failed
          </span>
        )}
      </div>

      <div className="timeline-toolbar-center">
        <button
          className={`play-pause-btn ${isPlaying ? "playing" : ""}`}
          onClick={onTogglePlay}
          title={isPlaying ? "Pause playback (Shortcut: Space)" : "Play timeline (Shortcut: Space)"}
        >
          {isPlaying ? "⏸ Pause" : "▶ Play"}
        </button>
        <div className="playhead-time-display" title="Current Playhead Position">
          <span className="playhead-time-label">Time</span>
          <span>{formatTimeCode(currentTime)}</span>
        </div>
        <button
          className="undo-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title={
            canUndo
              ? "Undo last edit (Shortcut: Ctrl+Z / Cmd+Z)"
              : "Nothing to undo"
          }
        >
          ↺ Undo
        </button>
        <button
          className="redo-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title={
            canRedo
              ? "Redo last undone edit (Shortcut: Ctrl+Shift+Z / Ctrl+Y)"
              : "Nothing to redo"
          }
        >
          ↻ Redo
        </button>
        <button
          className="split-btn"
          onClick={onSplit}
          disabled={!canSplit}
          title={
            canSplit
              ? `Split selected clip at ${formatTimeCode(currentTime)} (Shortcut: S)`
              : "Select a clip and place playhead inside it to split"
          }
        >
          ✂ Split
        </button>
        <button
          className="delete-btn"
          onClick={onDelete}
          disabled={!canDelete}
          title={
            canDelete
              ? "Delete selected clip (Shortcut: Delete / Backspace)"
              : "Select a clip to delete"
          }
        >
          🗑️ Delete
        </button>
      </div>

      <div className="timeline-toolbar-right">
        {onAddTrack && (
          <div className="add-track-dropdown-container" ref={dropdownRef}>
            <button
              type="button"
              className="add-track-btn"
              title="Add a new track to timeline"
              onClick={() => setShowAddMenu((prev) => !prev)}
            >
              ＋ Add Track ▾
            </button>
            {showAddMenu && (
              <div className="add-track-menu">
                <button
                  type="button"
                  className="add-track-menu-item"
                  onClick={() => {
                    onAddTrack("video");
                    setShowAddMenu(false);
                  }}
                >
                  <span className="menu-icon">🎥</span>
                  <div className="menu-text">
                    <span className="menu-title">Video Track</span>
                    <span className="menu-sub">Video footage & visuals</span>
                  </div>
                </button>
                <button
                  type="button"
                  className="add-track-menu-item"
                  onClick={() => {
                    onAddTrack("audio");
                    setShowAddMenu(false);
                  }}
                >
                  <span className="menu-icon">🔊</span>
                  <div className="menu-text">
                    <span className="menu-title">Audio Track</span>
                    <span className="menu-sub">Music, voiceover & SFX</span>
                  </div>
                </button>
                <button
                  type="button"
                  className="add-track-menu-item"
                  onClick={() => {
                    onAddTrack("caption");
                    setShowAddMenu(false);
                  }}
                >
                  <span className="menu-icon">💬</span>
                  <div className="menu-text">
                    <span className="menu-title">Caption Track</span>
                    <span className="menu-sub">Subtitles & text</span>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}

        <div className="zoom-controls">
          <button
            className="zoom-btn"
            title="Zoom Out"
            onClick={handleZoomOut}
            disabled={zoom <= MIN_ZOOM}
          >
            −
          </button>
          <div
            className="zoom-label"
            title="Click to reset zoom to 100%"
            onClick={onResetZoom}
          >
            {Math.round(zoom * 100)}%
          </div>
          <button
            className="zoom-btn"
            title="Zoom In"
            onClick={handleZoomIn}
            disabled={zoom >= MAX_ZOOM}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
};
