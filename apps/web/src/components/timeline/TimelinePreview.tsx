import React, { useRef, useEffect, useState, useMemo } from "react";
import type { Timeline, MediaAsset, ActiveVideoClip } from "@agentcut/shared";
import {
  findActiveVideoClipAtTime,
  findNextVideoClipAfterTime
} from "@agentcut/shared";
import { getMediaStreamUrl } from "../../api/media";
import { formatTimeCode } from "../../utils/timelineCalculations";

interface TimelinePreviewProps {
  projectId: string;
  timeline: Timeline | null;
  currentTime: number;
  totalDuration: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  mediaAssets: MediaAsset[];
  frameRate?: number;
}

export const TimelinePreview: React.FC<TimelinePreviewProps> = ({
  projectId,
  timeline,
  currentTime,
  totalDuration,
  isPlaying,
  onTogglePlay,
  onSeek,
  mediaAssets,
  frameRate = 30
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const isPlaybackDrivingRef = useRef<boolean>(false);
  const activeClipRef = useRef<ActiveVideoClip | null>(null);
  const isPlayingRef = useRef<boolean>(isPlaying);
  const pendingLoadListenerRef = useRef<(() => void) | null>(null);

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  isPlayingRef.current = isPlaying;

  // Unmount cleanup: pause video, cancel RAF, detach pending metadata listeners
  useEffect(() => {
    return () => {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (pendingLoadListenerRef.current && videoRef.current) {
        videoRef.current.removeEventListener("loadedmetadata", pendingLoadListenerRef.current);
        pendingLoadListenerRef.current = null;
      }
    };
  }, []);

  // Map assetId to MediaAsset object
  const assetMap = useMemo(() => {
    const map = new Map<string, MediaAsset>();
    for (const a of mediaAssets) {
      map.set(a.id, a);
    }
    return map;
  }, [mediaAssets]);

  // Find active video clip covering currentTime
  const activeClip = useMemo(() => {
    if (!timeline) return null;
    return findActiveVideoClipAtTime(timeline, currentTime);
  }, [timeline, currentTime]);

  activeClipRef.current = activeClip;

  const currentAsset = useMemo(() => {
    if (!activeClip) return null;
    return assetMap.get(activeClip.clip.assetId) || null;
  }, [activeClip, assetMap]);

  // Synchronize video element position when timeline currentTime changes while NOT driving playback
  useEffect(() => {
    if (isPlaybackDrivingRef.current) {
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    if (!activeClip) {
      // In a gap: pause video if it was playing
      if (!video.paused) {
        video.pause();
      }
      return;
    }

    const targetSourceTime = activeClip.sourceTime;
    const streamUrl = getMediaStreamUrl(projectId, activeClip.clip.assetId);

    // If source URL differs, switch source and seek once loaded
    if (!video.src.endsWith(streamUrl)) {
      if (pendingLoadListenerRef.current) {
        video.removeEventListener("loadedmetadata", pendingLoadListenerRef.current);
        pendingLoadListenerRef.current = null;
      }

      const onLoaded = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        pendingLoadListenerRef.current = null;
        video.currentTime = targetSourceTime;
        if (isPlayingRef.current) {
          video.play().catch(() => {});
        }
      };

      pendingLoadListenerRef.current = onLoaded;
      video.addEventListener("loadedmetadata", onLoaded);
      video.src = streamUrl;
      video.load();
    } else {
      // Same source: seek if video is ready, or wait for metadata if still loading
      if (video.readyState >= 1) {
        if (Math.abs(video.currentTime - targetSourceTime) > 0.04) {
          video.currentTime = targetSourceTime;
        }
      } else {
        if (pendingLoadListenerRef.current) {
          video.removeEventListener("loadedmetadata", pendingLoadListenerRef.current);
        }
        const onLoaded = () => {
          video.removeEventListener("loadedmetadata", onLoaded);
          pendingLoadListenerRef.current = null;
          video.currentTime = targetSourceTime;
        };
        pendingLoadListenerRef.current = onLoaded;
        video.addEventListener("loadedmetadata", onLoaded);
      }
    }

    return () => {
      if (pendingLoadListenerRef.current && video) {
        video.removeEventListener("loadedmetadata", pendingLoadListenerRef.current);
        pendingLoadListenerRef.current = null;
      }
    };
  }, [activeClip, projectId]);

  // Continuous playback loop using requestAnimationFrame for smooth 60fps playhead motion
  useEffect(() => {
    if (!isPlaying) {
      isPlaybackDrivingRef.current = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      return;
    }

    // Attempting to play while in a gap: cannot play gap
    if (!activeClipRef.current) {
      onTogglePlay();
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    isPlaybackDrivingRef.current = true;
    setPlaybackError(null);

    video.play().catch((err) => {
      // Auto-play or media error
      if (err.name !== "AbortError") {
        setPlaybackError("Playback was interrupted or blocked by browser.");
        onTogglePlay();
      }
    });

    const checkPlaybackFrame = () => {
      const v = videoRef.current;
      const currentClipInfo = activeClipRef.current;

      if (!v || v.paused || !currentClipInfo || !timeline) {
        return;
      }

      // If video is still loading metadata or buffering during transition, wait for next frame
      if (v.readyState < 2) {
        animFrameRef.current = requestAnimationFrame(checkPlaybackFrame);
        return;
      }

      const currentVideoTime = v.currentTime;
      const clipSourceEnd = currentClipInfo.clip.sourceEnd;

      // Has playback reached or exceeded the end of the active clip?
      if (currentVideoTime >= clipSourceEnd - 0.02) {
        // Look ahead for the next clip
        const next = findNextVideoClipAfterTime(
          timeline,
          currentClipInfo.clipTimelineEnd,
          currentClipInfo.clip.id
        );

        if (next && next.isContiguous) {
          // Immediately update activeClipRef to next clip to avoid re-triggering clipEnd on subsequent RAF
          const nextDuration = next.clip.sourceEnd - next.clip.sourceStart;
          activeClipRef.current = {
            clip: next.clip,
            track: next.track,
            sourceTime: next.sourceStart,
            clipDuration: nextDuration,
            clipTimelineEnd: next.clip.timelineStart + nextDuration,
            timeRemainingInClip: nextDuration
          };

          if (next.clip.assetId === currentClipInfo.clip.assetId) {
            // Same asset: seek directly to next clip's sourceStart
            v.currentTime = next.sourceStart;
            onSeek(next.timelineStart);
          } else {
            // Different asset: switch stream URL and await loadedmetadata before seeking/resuming
            const nextStreamUrl = getMediaStreamUrl(projectId, next.clip.assetId);
            const targetStart = next.sourceStart;

            if (pendingLoadListenerRef.current) {
              v.removeEventListener("loadedmetadata", pendingLoadListenerRef.current);
              pendingLoadListenerRef.current = null;
            }

            const onLoaded = () => {
              v.removeEventListener("loadedmetadata", onLoaded);
              pendingLoadListenerRef.current = null;
              v.currentTime = targetStart;
              if (isPlayingRef.current) {
                v.play().catch((err) => {
                  if (err.name !== "AbortError") {
                    setPlaybackError("Playback interrupted during clip transition.");
                    onTogglePlay();
                  }
                });
              }
            };

            pendingLoadListenerRef.current = onLoaded;
            v.addEventListener("loadedmetadata", onLoaded);
            v.src = nextStreamUrl;
            v.load();
            onSeek(next.timelineStart);
          }
        } else {
          // Gap or end of timeline: clamp to clip end, pause video, and update playhead
          v.pause();
          v.currentTime = clipSourceEnd;
          isPlaybackDrivingRef.current = false;
          onSeek(currentClipInfo.clipTimelineEnd);
          onTogglePlay();
          return;
        }
      } else {
        // Playback within current clip: derive timelineTime from sourceTime
        const derivedTimelineTime =
          currentClipInfo.clip.timelineStart +
          (currentVideoTime - currentClipInfo.clip.sourceStart);

        onSeek(derivedTimelineTime);
      }

      animFrameRef.current = requestAnimationFrame(checkPlaybackFrame);
    };

    animFrameRef.current = requestAnimationFrame(checkPlaybackFrame);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      isPlaybackDrivingRef.current = false;
    };
  }, [isPlaying, onSeek, onTogglePlay, projectId, timeline]);

  const handleRewindToStart = () => {
    onSeek(0);
  };

  return (
    <div className="video-player-container timeline-preview-container">
      <div className="video-player-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", overflow: "hidden" }}>
          <span className="video-player-title">
            {activeClip ? (
              activeClip.clip.name || currentAsset?.originalName || "Timeline Preview"
            ) : (
              <span style={{ color: "var(--text-muted)" }}>Timeline Preview (Gap)</span>
            )}
          </span>
          {activeClip && (
            <span className="timeline-preview-meta">
              Track: {activeClip.track.name} • Source: {activeClip.clip.sourceStart.toFixed(1)}s–
              {activeClip.clip.sourceEnd.toFixed(1)}s
              {currentAsset ? ` • ${currentAsset.width}×${currentAsset.height}` : ""}
            </span>
          )}
        </div>

        {/* Transport controls in preview header */}
        <div className="preview-transport-row">
          <button
            className="btn btn-secondary preview-control-btn"
            onClick={handleRewindToStart}
            title="Rewind to start (0:00.00)"
          >
            ⏮ Start
          </button>
          <button
            className={`btn ${isPlaying ? "btn-warning" : "btn-primary"} preview-control-btn`}
            onClick={onTogglePlay}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            {isPlaying ? "⏸ Pause" : "▶ Play"}
          </button>
          <div className="preview-time-badge">
            <span style={{ color: "#38bdf8", fontWeight: 700 }}>
              {formatTimeCode(currentTime)}
            </span>
            <span style={{ color: "var(--text-muted)", margin: "0 0.25rem" }}>/</span>
            <span>{formatTimeCode(totalDuration)}</span>
            <span style={{ color: "var(--text-muted)", marginLeft: "0.5rem", fontSize: "0.75rem" }}>
              ({frameRate} fps)
            </span>
          </div>
        </div>
      </div>

      {playbackError && (
        <div className="error-banner" style={{ margin: "0 0 1rem 0" }}>
          <div className="error-content">
            <span>⚠️</span>
            <span>{playbackError}</span>
          </div>
          <button className="btn btn-secondary" onClick={() => setPlaybackError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="video-player-wrapper preview-screen-wrapper">
        {isLoading && (
          <div className="preview-spinner-overlay">
            <div className="spinner"></div>
          </div>
        )}

        {/* Video Element for Active Clip */}
        <video
          ref={videoRef}
          playsInline
          preload="auto"
          style={{ display: activeClip ? "block" : "none" }}
          onWaiting={() => setIsLoading(true)}
          onCanPlay={() => setIsLoading(false)}
          onPlaying={() => setIsLoading(false)}
          onError={() => {
            setIsLoading(false);
            setPlaybackError("Failed to stream video footage at current position.");
          }}
        />

        {/* Empty Gap State when Playhead is in a gap or timeline has no video */}
        {!activeClip && (
          <div className="timeline-preview-gap">
            <div className="gap-icon">🎞️</div>
            <div className="gap-title">Timeline Gap</div>
            <div className="gap-subtitle">
              Playhead is at {formatTimeCode(currentTime)} (no video clip on active tracks)
            </div>
            <div className="gap-hint">
              Click on a clip in the timeline or press Start (⏮) to position preview
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
