import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Timeline, MediaAsset, Clip, Track } from "@agentcut/shared";
import { getTimelineDuration, moveClip, splitClipWithResult, trimClip, deleteClip } from "@agentcut/shared";
import { fetchProjectTimeline, saveProjectTimeline } from "../../api/timeline";
import { TimelineSaveQueue } from "../../utils/timelineSaveQueue";
import {
  calculatePixelsPerSecond,
  calculateTimelineWidth,
  calculateDraggedTimelineStart,
  calculateTrimmedClip,
  isTrackTypeCompatible,
  formatTimeCode,
  formatClipDuration,
  DEFAULT_ZOOM
} from "../../utils/timelineCalculations";
import { TimelineToolbar, type SaveStatus } from "./TimelineToolbar";
import { TimelineRuler } from "./TimelineRuler";
import { TimelineTrack } from "./TimelineTrack";
import { TimelinePlayhead } from "./TimelinePlayhead";
import "./timeline.css";

interface TimelineEditorProps {
  projectId: string;
  mediaAssets: MediaAsset[];
}

interface DragState {
  clip: Clip;
  sourceTrack: Track;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  hasMoved: boolean;
  currentTimelineStart: number;
  targetTrackId: string;
  targetTrackType: string;
  isCompatible: boolean;
}

interface TrimState {
  clip: Clip;
  edge: "left" | "right";
  startClientX: number;
  startScrollLeft: number;
  previewClip: Clip;
  mediaDuration?: number;
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

  // Selection state (frontend-only, non-persisted)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  // Drag-and-drop state (horizontal movement)
  const [dragState, setDragState] = useState<DragState | null>(null);

  // Trimming state (edge resize)
  const [trimState, setTrimState] = useState<TrimState | null>(null);

  // Persistence & feedback states
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);

  // Persistence queue & scroll refs
  const saveQueueRef = useRef<TimelineSaveQueue | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const loadTimeline = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchProjectTimeline(projectId);
      setTimeline(data);
      saveQueueRef.current?.setLastSavedTimeline(data);
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

  // Lookup details for the currently selected clip (live during trimming)
  const selectedClipInfo = useMemo(() => {
    if (!selectedClipId || !timeline) return null;
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip) {
        const effectiveClip =
          trimState && trimState.clip.id === clip.id ? trimState.previewClip : clip;
        return { clip: effectiveClip, track };
      }
    }
    return null;
  }, [selectedClipId, timeline, trimState]);

  const handleSeek = (seconds: number) => {
    const maxBound = Math.max(30, timelineDuration + 10);
    const clampedTime = Math.max(0, Math.min(seconds, maxBound));
    setCurrentTime(clampedTime);
  };

  const handleResetZoom = () => {
    setZoom(DEFAULT_ZOOM);
  };

  // Selection handlers
  const handleSelectClip = (clipId: string) => {
    setSelectedClipId(clipId);
  };

  const handleDeselect = () => {
    setSelectedClipId(null);
  };

  // Initialize persistence queue
  useEffect(() => {
    saveQueueRef.current = new TimelineSaveQueue({
      saveFn: (payload) => saveProjectTimeline(projectId, payload),
      onSaveStart: () => {
        setSaveStatus("saving");
        setSaveError(null);
      },
      onSaveSuccess: (saved) => {
        setTimeline(saved);
        setSaveStatus("saved");
        setTimeout(() => {
          setSaveStatus((prev) => (prev === "saved" ? "idle" : prev));
        }, 2500);
      },
      onSaveError: (err, rolledBackTimeline) => {
        if (rolledBackTimeline) {
          setTimeline(rolledBackTimeline);
        }
        setSaveStatus("error");
        setSaveError(err.message || "Failed to save timeline.");
      },
      initialTimeline: timeline
    });
  }, [projectId]);

  // Keep queue baseline in sync with loaded timeline
  useEffect(() => {
    if (timeline && saveQueueRef.current && !saveQueueRef.current.isBusy()) {
      saveQueueRef.current.setLastSavedTimeline(timeline);
    }
  }, [timeline]);

  // Persists updated timeline with optimistic UI update and serialized queue dispatch
  const persistTimeline = useCallback(
    (nextTimeline: Timeline) => {
      // 1. Optimistic UI update
      setTimeline(nextTimeline);

      // 2. Enqueue into serialized queue
      saveQueueRef.current?.enqueue(nextTimeline);
    },
    []
  );

  // Split operation condition: clip selected AND currentTime strictly inside clip interval
  const canSplit = useMemo(() => {
    if (!selectedClipInfo) return false;
    const clip = selectedClipInfo.clip;
    const clipDuration = clip.sourceEnd - clip.sourceStart;
    const clipTimelineEnd = clip.timelineStart + clipDuration;
    return currentTime > clip.timelineStart && currentTime < clipTimelineEnd;
  }, [selectedClipInfo, currentTime]);

  const handleSplitClip = useCallback(() => {
    if (!timeline || !selectedClipId || !canSplit) return;
    try {
      const result = splitClipWithResult(timeline, selectedClipId, currentTime, {
        assets: mediaAssets
      });

      // 1. Optimistic UI update & serialized persistence
      persistTimeline(result.timeline);

      // 2. Select the second clip segment as preferred by requirements
      setSelectedClipId(result.secondClip.id);
      setNoticeMessage(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to split clip.";
      setNoticeMessage(msg);
      setTimeout(() => setNoticeMessage(null), 3500);
    }
  }, [timeline, selectedClipId, canSplit, currentTime, mediaAssets, persistTimeline]);

  const handleDeleteSelectedClip = useCallback(() => {
    if (!timeline || !selectedClipId) return;
    try {
      const updated = deleteClip(timeline, selectedClipId, { assets: mediaAssets });
      // Optimistic UI update & serialized queue persistence
      persistTimeline(updated);
      setSelectedClipId(null);
      setNoticeMessage(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete clip.";
      setNoticeMessage(msg);
      setTimeout(() => setNoticeMessage(null), 3500);
    }
  }, [timeline, selectedClipId, mediaAssets, persistTimeline]);

  // Keyboard shortcuts: Press 'S' to split, 'Delete' or 'Backspace' to delete selected clip
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (canSplit) {
          e.preventDefault();
          handleSplitClip();
        }
      }

      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        if (selectedClipId) {
          e.preventDefault();
          handleDeleteSelectedClip();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canSplit, handleSplitClip, selectedClipId, handleDeleteSelectedClip]);

  // Trimming interaction handlers
  const handleClipTrimStart = (
    clip: Clip,
    edge: "left" | "right",
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    if (!timeline) return;

    const startScrollLeft = scrollContainerRef.current?.scrollLeft || 0;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}

    const asset = mediaAssets.find((a) => a.id === clip.assetId);

    setTrimState({
      clip,
      edge,
      startClientX: e.clientX,
      startScrollLeft,
      previewClip: { ...clip },
      mediaDuration: asset?.duration
    });

    setSelectedClipId(clip.id);
  };

  // Drag interaction handlers
  const handleClipDragStart = (
    clip: Clip,
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    if (!timeline) return;

    // Find the track containing this clip
    const sourceTrack = timeline.tracks.find((t) => t.id === clip.trackId);
    if (!sourceTrack) return;

    const startScrollLeft = scrollContainerRef.current?.scrollLeft || 0;

    // Capture pointer events for reliable tracking even outside element boundaries
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}

    setDragState({
      clip,
      sourceTrack,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startScrollLeft,
      hasMoved: false,
      currentTimelineStart: clip.timelineStart,
      targetTrackId: sourceTrack.id,
      targetTrackType: sourceTrack.type,
      isCompatible: true
    });

    // Selecting the clip immediately on drag start gives instant visual feedback
    setSelectedClipId(clip.id);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // 1. Handle active trim interaction
    if (trimState) {
      const deltaX = e.clientX - trimState.startClientX;
      const currentScroll = scrollContainerRef.current?.scrollLeft || 0;
      const scrollDelta = currentScroll - trimState.startScrollLeft;
      const totalPixelDisplacement = deltaX + scrollDelta;

      const result = calculateTrimmedClip({
        clip: trimState.clip,
        edge: trimState.edge,
        deltaPixels: totalPixelDisplacement,
        pps,
        mediaDuration: trimState.mediaDuration
      });

      setTrimState((prev) =>
        prev
          ? {
              ...prev,
              previewClip: {
                ...prev.clip,
                timelineStart: result.newTimelineStart,
                sourceStart: result.newSourceStart,
                sourceEnd: result.newSourceEnd
              }
            }
          : null
      );
      return;
    }

    // 2. Handle active clip drag interaction
    if (!dragState) return;

    const deltaX = e.clientX - dragState.startClientX;
    const deltaY = e.clientY - dragState.startClientY;

    // Enforce 3px movement threshold to distinguish intentional drag from a static click
    const hasMoved = dragState.hasMoved || Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3;

    // Compensate for container horizontal scroll
    const currentScroll = scrollContainerRef.current?.scrollLeft || 0;
    const scrollDelta = currentScroll - dragState.startScrollLeft;
    const totalPixelDisplacement = deltaX + scrollDelta;

    const newStart = calculateDraggedTimelineStart(
      dragState.clip.timelineStart,
      totalPixelDisplacement,
      pps
    );

    // Identify target track under cursor
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    const trackElement = elements.find((el) => el.hasAttribute("data-track-id"));

    const targetTrackId = trackElement
      ? trackElement.getAttribute("data-track-id")!
      : dragState.sourceTrack.id;

    const targetTrackType = trackElement
      ? trackElement.getAttribute("data-track-type")!
      : dragState.sourceTrack.type;

    const isCompatible = isTrackTypeCompatible(dragState.sourceTrack.type, targetTrackType);

    setDragState((prev) =>
      prev
        ? {
            ...prev,
            hasMoved,
            currentTimelineStart: newStart,
            targetTrackId,
            targetTrackType,
            isCompatible
          }
        : null
    );
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    // 1. Release active trim interaction and persist
    if (trimState) {
      if (timeline) {
        let didChange = false;
        let finalTrimTime = 0;

        if (trimState.edge === "left") {
          didChange =
            Math.abs(trimState.previewClip.timelineStart - trimState.clip.timelineStart) > 0.001;
          finalTrimTime = trimState.previewClip.timelineStart;
        } else {
          const originalEnd =
            trimState.clip.timelineStart + (trimState.clip.sourceEnd - trimState.clip.sourceStart);
          const newEnd =
            trimState.previewClip.timelineStart +
            (trimState.previewClip.sourceEnd - trimState.previewClip.sourceStart);
          didChange = Math.abs(newEnd - originalEnd) > 0.001;
          finalTrimTime = newEnd;
        }

        if (didChange) {
          try {
            const updated = trimClip(
              timeline,
              trimState.clip.id,
              trimState.edge,
              finalTrimTime,
              { assets: mediaAssets }
            );
            persistTimeline(updated);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to trim clip.";
            setNoticeMessage(msg);
            setTimeout(() => setNoticeMessage(null), 3500);
          }
        }
      }

      setTrimState(null);
      return;
    }

    // 2. Release active clip drag interaction and persist
    if (!dragState || !timeline) return;

    if (dragState.hasMoved) {
      if (!dragState.isCompatible) {
        setNoticeMessage(
          `Cannot move clip: destination track (${dragState.targetTrackType}) is incompatible with ${dragState.sourceTrack.type} media.`
        );
        setTimeout(() => setNoticeMessage(null), 3500);
      } else {
        const startChanged =
          Math.abs(dragState.currentTimelineStart - dragState.clip.timelineStart) > 0.001;
        const trackChanged = dragState.targetTrackId !== dragState.sourceTrack.id;

        if (startChanged || trackChanged) {
          try {
            // Apply move using shared timeline moveClip operation
            const updated = moveClip(
              timeline,
              dragState.clip.id,
              dragState.currentTimelineStart,
              dragState.targetTrackId,
              { assets: mediaAssets }
            );
            persistTimeline(updated);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to move clip.";
            setNoticeMessage(msg);
            setTimeout(() => setNoticeMessage(null), 3500);
          }
        }
      }
    }

    setDragState(null);
  };

  const handlePointerCancel = () => {
    setTrimState(null);
    setDragState(null);
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
        saveStatus={saveStatus}
        saveError={saveError}
        canSplit={canSplit}
        onSplit={handleSplitClip}
        canDelete={Boolean(selectedClipId)}
        onDelete={handleDeleteSelectedClip}
        onZoomChange={setZoom}
        onResetZoom={handleResetZoom}
      />

      {/* Selected Clip Info Inspector */}
      {selectedClipInfo && (
        <div className="selected-clip-inspector">
          <div className="selected-clip-left">
            <span className="selected-clip-tag">Selected Clip</span>
            <span
              className="selected-clip-name"
              title={selectedClipInfo.clip.name || assetNames[selectedClipInfo.clip.assetId]}
            >
              {selectedClipInfo.clip.name ||
                assetNames[selectedClipInfo.clip.assetId] ||
                selectedClipInfo.clip.id}
            </span>
          </div>
          <div className="selected-clip-details">
            <div className="selected-clip-metric">
              <span className="metric-label">Track:</span>
              <span className="metric-val">{selectedClipInfo.track.name}</span>
            </div>
            <div className="selected-clip-metric">
              <span className="metric-label">Start:</span>
              <span className="metric-val">{formatTimeCode(selectedClipInfo.clip.timelineStart)}</span>
            </div>
            <div className="selected-clip-metric">
              <span className="metric-label">Duration:</span>
              <span className="metric-val">
                {formatClipDuration(
                  selectedClipInfo.clip.sourceEnd - selectedClipInfo.clip.sourceStart
                )}
              </span>
            </div>
            <div className="selected-clip-metric">
              <span className="metric-label">Source:</span>
              <span className="metric-val">
                {selectedClipInfo.clip.sourceStart.toFixed(1)}s–{selectedClipInfo.clip.sourceEnd.toFixed(1)}s
              </span>
            </div>
            <button
              className="split-inspector-btn"
              disabled={!canSplit}
              onClick={handleSplitClip}
              title={
                canSplit
                  ? `Split at playhead (${formatTimeCode(currentTime)})`
                  : "Move playhead inside clip to split"
              }
            >
              ✂ Split
            </button>
            <button
              className="delete-inspector-btn"
              onClick={handleDeleteSelectedClip}
              title="Delete selected clip (Shortcut: Delete / Backspace)"
            >
              🗑️ Delete
            </button>
            <button className="deselect-btn" title="Deselect clip" onClick={handleDeselect}>
              ✕ Deselect
            </button>
          </div>
        </div>
      )}

      {/* Warning Notice Banner (e.g. incompatible track drag) */}
      {noticeMessage && (
        <div className="timeline-notice-banner">
          <span>⚠️ {noticeMessage}</span>
          <button
            style={{ background: "none", border: "none", color: "#fca5a5", cursor: "pointer", fontWeight: 700 }}
            onClick={() => setNoticeMessage(null)}
          >
            ✕
          </button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        className="timeline-scroll-container"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
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
          onDeselect={handleDeselect}
        />

        {/* Track Rows */}
        <div className="timeline-tracks-wrapper">
          {timeline.tracks.length === 0 ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)", fontStyle: "italic" }}>
              This timeline has no tracks yet.
            </div>
          ) : (
            timeline.tracks.map((track) => {
              const isDropTarget = dragState?.hasMoved && dragState.targetTrackId === track.id;
              return (
                <TimelineTrack
                  key={track.id}
                  track={track}
                  pps={pps}
                  timelineWidth={timelineWidth}
                  assetNames={assetNames}
                  selectedClipId={selectedClipId}
                  draggedClipId={dragState?.hasMoved ? dragState.clip.id : null}
                  draggedTimelineStart={
                    dragState?.hasMoved ? dragState.currentTimelineStart : undefined
                  }
                  trimClipId={trimState?.clip.id || null}
                  trimPreviewClip={trimState?.previewClip}
                  isCurrentDropTarget={Boolean(isDropTarget)}
                  isDropCompatible={dragState ? dragState.isCompatible : true}
                  onSeek={handleSeek}
                  onSelectClip={handleSelectClip}
                  onDeselect={handleDeselect}
                  onClipDragStart={handleClipDragStart}
                  onClipTrimStart={handleClipTrimStart}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
