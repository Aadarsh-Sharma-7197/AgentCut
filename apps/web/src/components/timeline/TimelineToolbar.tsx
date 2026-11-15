import React from "react";
import { formatTimeCode, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from "../../utils/timelineCalculations";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

interface TimelineToolbarProps {
  frameRate: number;
  currentTime: number;
  zoom: number;
  saveStatus?: SaveStatus;
  saveError?: string | null;
  onZoomChange: (newZoom: number) => void;
  onResetZoom: () => void;
}

export const TimelineToolbar: React.FC<TimelineToolbarProps> = ({
  frameRate,
  currentTime,
  zoom,
  saveStatus = "idle",
  saveError,
  onZoomChange,
  onResetZoom
}) => {
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
        <div className="playhead-time-display" title="Current Playhead Position">
          <span className="playhead-time-label">Time</span>
          <span>{formatTimeCode(currentTime)}</span>
        </div>
      </div>

      <div className="timeline-toolbar-right">
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
