import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { Timeline, MediaAsset } from "@agentcut/shared";
import { getTimelineDuration } from "@agentcut/shared";
import { fetchProjectTimeline } from "../../api/timeline";
import {
  calculatePixelsPerSecond,
  calculateTimelineWidth,
  DEFAULT_ZOOM
} from "../../utils/timelineCalculations";
import { TimelineToolbar } from "./TimelineToolbar";
import { TimelineRuler } from "./TimelineRuler";
import { TimelineTrack } from "./TimelineTrack";
import { TimelinePlayhead } from "./TimelinePlayhead";
import "./timeline.css";

interface TimelineEditorProps {
  projectId: string;
  mediaAssets: MediaAsset[];
}

export const TimelineEditor: React.FC<TimelineEditorProps> = ({
  projectId,
  mediaAssets
}) => {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const [currentTime, setCurrentTime] = useState<number>(0);

  const loadTimeline = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchProjectTimeline(projectId);
      setTimeline(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load project timeline.";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  // Map assetId to original filename for display on clips
  const assetNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const asset of mediaAssets) {
      map[asset.id] = asset.originalName;
    }
    return map;
  }, [mediaAssets]);

  // Pixels per second & dimensions
  const pps = useMemo(() => calculatePixelsPerSecond(zoom), [zoom]);
  const timelineDuration = useMemo(() => {
    if (!timeline) return 0;
    return getTimelineDuration(timeline);
  }, [timeline]);

  const timelineWidth = useMemo(() => {
    return calculateTimelineWidth(timelineDuration, pps);
  }, [timelineDuration, pps]);

  const handleSeek = (seconds: number) => {
    const maxBound = Math.max(30, timelineDuration + 10);
    const clampedTime = Math.max(0, Math.min(seconds, maxBound));
    setCurrentTime(clampedTime);
  };

  const handleResetZoom = () => {
    setZoom(DEFAULT_ZOOM);
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="timeline-editor-wrapper">
        <div className="timeline-toolbar">
          <div className="timeline-toolbar-left">
            <h3 className="timeline-title">Timeline</h3>
          </div>
        </div>
        <div style={{ padding: "2.5rem 1rem", textAlign: "center" }}>
          <div className="spinner" style={{ margin: "0 auto 1rem" }}></div>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>Loading timeline...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="timeline-editor-wrapper">
        <div className="timeline-toolbar">
          <div className="timeline-toolbar-left">
            <h3 className="timeline-title">Timeline</h3>
          </div>
        </div>
        <div style={{ padding: "2rem 1.5rem" }}>
          <div className="error-banner">
            <div className="error-content">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
            <button className="btn btn-secondary" onClick={loadTimeline}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Empty state: No timeline exists for project yet
  if (!timeline) {
    return (
      <div className="timeline-empty-card">
        <div className="timeline-empty-icon">🎞️</div>
        <h4 className="timeline-empty-title">No Timeline Created Yet</h4>
        <p className="timeline-empty-desc">
          This project does not have a saved timeline. A timeline will be created when editing starts or when clips are assembled.
        </p>
      </div>
    );
  }

  const frameRate = timeline.settings?.frameRate || 30;

  return (
    <div className="timeline-editor-wrapper">
      <TimelineToolbar
        frameRate={frameRate}
        currentTime={currentTime}
        zoom={zoom}
        onZoomChange={setZoom}
        onResetZoom={handleResetZoom}
      />

      <div className="timeline-scroll-container">
        {/* Playhead spans ruler and all tracks */}
        <TimelinePlayhead
          currentTime={currentTime}
          pps={pps}
          headerWidth={190}
        />

        {/* Time Ruler */}
        <TimelineRuler
          timelineDuration={timelineDuration}
          pps={pps}
          timelineWidth={timelineWidth}
          onSeek={handleSeek}
        />

        {/* Track Rows */}
        <div className="timeline-tracks-wrapper">
          {timeline.tracks.length === 0 ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)", fontStyle: "italic" }}>
              This timeline has no tracks yet.
            </div>
          ) : (
            timeline.tracks.map((track) => (
              <TimelineTrack
                key={track.id}
                track={track}
                pps={pps}
                timelineWidth={timelineWidth}
                assetNames={assetNames}
                onSeek={handleSeek}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
};

