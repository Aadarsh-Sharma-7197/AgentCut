import React, { useState, useEffect, useRef, useCallback } from "react";
import type { Project, MediaAsset } from "@agentcut/shared";
import { fetchMediaAssets, uploadMediaAsset, getMediaStreamUrl } from "../api/media";
import { TimelineEditor } from "./timeline/TimelineEditor";

interface ProjectWorkspaceProps {
  project: Project;
  onBack: () => void;
}

export const ProjectWorkspace: React.FC<ProjectWorkspaceProps> = ({
  project,
  onBack
}) => {
  const [mediaList, setMediaList] = useState<MediaAsset[]>([]);
  const [isLoadingMedia, setIsLoadingMedia] = useState<boolean>(true);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<MediaAsset | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadMedia = useCallback(async () => {
    setIsLoadingMedia(true);
    setMediaError(null);
    try {
      const assets = await fetchMediaAssets(project.id);
      setMediaList(assets);
      if (assets.length > 0 && !selectedAsset) {
        setSelectedAsset(assets[0]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load media assets.";
      setMediaError(msg);
    } finally {
      setIsLoadingMedia(false);
    }
  }, [project.id, selectedAsset]);

  useEffect(() => {
    loadMedia();
  }, [loadMedia]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadError(null);

    try {
      const uploaded = await uploadMediaAsset(project.id, file);
      setMediaList((prev) => [uploaded, ...prev]);
      setSelectedAsset(uploaded);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to upload video.";
      setUploadError(msg);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) {
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    }
    if (bytes >= 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    }
    return (bytes / 1024).toFixed(1) + " KB";
  };

  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="workspace-container">
      <button className="back-btn" onClick={onBack}>
        ← Back to Projects
      </button>

      <div className="workspace-header">
        <div className="workspace-title-row">
          <div>
            <h1 className="workspace-title">{project.name}</h1>
            <p className="section-subtitle">Project Workspace</p>
          </div>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.mkv,.webm,.avi,.m4v"
              style={{ display: "none" }}
              onChange={handleFileSelect}
            />
            <button
              className="btn btn-primary"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {isUploading ? "Uploading..." : "+ Import Video"}
            </button>
          </div>
        </div>
      </div>

      <div className="info-cards-grid">
        <div className="info-card">
          <div className="info-label">Project ID</div>
          <div className="info-value">{project.id}</div>
        </div>
        <div className="info-card">
          <div className="info-label">Last Updated</div>
          <div className="info-value">{formatDate(project.updatedAt)}</div>
        </div>
        <div className="info-card">
          <div className="info-label">Media Items</div>
          <div className="info-value">{mediaList.length}</div>
        </div>
      </div>

      {isUploading && (
        <div className="upload-banner">
          <div className="spinner" style={{ width: "20px", height: "20px", borderWidth: "2px" }}></div>
          <span>Uploading and inspecting video with FFprobe... Please wait.</span>
        </div>
      )}

      {uploadError && (
        <div className="error-banner">
          <div className="error-content">
            <span>⚠️</span>
            <span>{uploadError}</span>
          </div>
          <button className="btn btn-secondary" onClick={() => setUploadError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {mediaError && (
        <div className="error-banner">
          <div className="error-content">
            <span>⚠️</span>
            <span>{mediaError}</span>
          </div>
          <button className="btn btn-secondary" onClick={loadMedia}>
            Retry
          </button>
        </div>
      )}

      {/* Active Video Preview Player */}
      {selectedAsset && (
        <div className="video-player-container">
          <div className="video-player-header">
            <div>
              <span className="video-player-title">{selectedAsset.originalName}</span>
              <span style={{ marginLeft: "0.75rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                {selectedAsset.width}×{selectedAsset.height} • {formatDuration(selectedAsset.duration)} • {selectedAsset.videoCodec}
              </span>
            </div>
            <button
              className="btn btn-secondary"
              style={{ padding: "0.3rem 0.75rem", fontSize: "0.8rem" }}
              onClick={() => setSelectedAsset(null)}
            >
              Close Player
            </button>
          </div>
          <div className="video-player-wrapper">
            <video
              key={selectedAsset.id}
              controls
              playsInline
              preload="metadata"
              src={getMediaStreamUrl(project.id, selectedAsset.id)}
            >
              Your browser does not support the video tag.
            </video>
          </div>
        </div>
      )}

      {/* Visual Timeline Section */}
      <TimelineEditor projectId={project.id} mediaAssets={mediaList} />

      {/* Media Library Section */}
      <section className="media-section">
        <div className="media-section-header">
          <h2 className="media-section-title">
            Media Library
            <span className="badge-count">{mediaList.length}</span>
          </h2>
        </div>

        {isLoadingMedia ? (
          <div className="loading-container">
            <div className="spinner"></div>
            <p>Loading media assets...</p>
          </div>
        ) : mediaList.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🎬</div>
            <h3 className="empty-title">No videos imported yet</h3>
            <p className="empty-desc">
              Import source video footage (MP4, MOV, MKV, WebM, AVI, M4V) to begin organizing assets for this project.
            </p>
            <button
              className="btn btn-primary"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              Import Video
            </button>
          </div>
        ) : (
          <div className="media-grid">
            {mediaList.map((asset) => {
              const isSelected = selectedAsset?.id === asset.id;
              return (
                <div
                  key={asset.id}
                  className={`media-card ${isSelected ? "active" : ""}`}
                  onClick={() => setSelectedAsset(asset)}
                >
                  <h4 className="media-card-title" title={asset.originalName}>
                    {asset.originalName}
                  </h4>
                  <div className="media-meta-grid">
                    <div className="media-meta-item">
                      <span>Resolution</span>
                      <span>{asset.width}×{asset.height}</span>
                    </div>
                    <div className="media-meta-item">
                      <span>Duration</span>
                      <span>{formatDuration(asset.duration)}</span>
                    </div>
                    <div className="media-meta-item">
                      <span>Video Codec</span>
                      <span>{asset.videoCodec}</span>
                    </div>
                    <div className="media-meta-item">
                      <span>Audio Codec</span>
                      <span>{asset.audioCodec || "None"}</span>
                    </div>
                    <div className="media-meta-item">
                      <span>Frame Rate</span>
                      <span>{asset.frameRate} fps</span>
                    </div>
                    <div className="media-meta-item">
                      <span>Size</span>
                      <span>{formatFileSize(asset.fileSize)}</span>
                    </div>
                  </div>
                  <div className="media-card-actions">
                    <button
                      className={`btn ${isSelected ? "btn-primary" : "btn-secondary"}`}
                      style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedAsset(asset);
                      }}
                    >
                      {isSelected ? "Now Playing" : "Preview"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
