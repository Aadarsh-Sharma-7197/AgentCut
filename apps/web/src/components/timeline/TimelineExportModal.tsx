import React, { useState, useEffect, useRef, useCallback } from "react";
import type { Timeline, RenderJob, RenderPlan } from "@agentcut/shared";
import {
  validateRenderPlanApi,
  createRenderJobApi,
  getRenderJobApi,
  cancelRenderJobApi,
  getRenderJobDownloadUrl
} from "../../api/render";
import { formatTimeCode } from "../../utils/timelineCalculations";

interface TimelineExportModalProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  timeline: Timeline | null;
}

export const TimelineExportModal: React.FC<TimelineExportModalProps> = ({
  projectId,
  isOpen,
  onClose,
  timeline
}) => {
  const [isValidating, setIsValidating] = useState<boolean>(true);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [plan, setPlan] = useState<RenderPlan | null>(null);
  const [currentJob, setCurrentJob] = useState<RenderJob | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Clear polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // Validate render plan when modal opens
  const validatePlan = useCallback(async () => {
    if (!isOpen) return;
    setIsValidating(true);
    setValidationErrors([]);
    setErrorMessage(null);

    try {
      const res = await validateRenderPlanApi(projectId, timeline || undefined);
      setPlan(res.plan);
      setValidationErrors(res.validation.errors || []);
    } catch (err) {
      setErrorMessage((err as Error).message || "Failed to validate render plan.");
    } finally {
      setIsValidating(false);
    }
  }, [isOpen, projectId, timeline]);

  useEffect(() => {
    if (isOpen && !currentJob) {
      validatePlan();
    }
  }, [isOpen, validatePlan, currentJob]);

  // Poll active render job until completion, failure, or cancellation
  const startPollingJob = useCallback(
    (jobId: string) => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }

      pollIntervalRef.current = setInterval(async () => {
        try {
          const updated = await getRenderJobApi(projectId, jobId);
          setCurrentJob(updated);

          if (
            updated.status === "completed" ||
            updated.status === "failed" ||
            updated.status === "canceled"
          ) {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
          }
        } catch (pollErr) {
          console.error("[ExportModal] Polling error:", pollErr);
        }
      }, 1000);
    },
    [projectId]
  );

  const handleStartRender = async () => {
    if (isSubmitting || isValidating || validationErrors.length > 0) return;
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const job = await createRenderJobApi(projectId);
      setCurrentJob(job);
      startPollingJob(job.id);
    } catch (err) {
      setErrorMessage((err as Error).message || "Failed to enqueue render job.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelRender = async () => {
    if (!currentJob) return;

    try {
      const canceledJob = await cancelRenderJobApi(projectId, currentJob.id);
      setCurrentJob(canceledJob);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    } catch (err) {
      setErrorMessage((err as Error).message || "Failed to cancel render job.");
    }
  };

  const handleReset = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setCurrentJob(null);
    setErrorMessage(null);
    validatePlan();
  };

  if (!isOpen) {
    return null;
  }

  const isRendering =
    currentJob?.status === "queued" ||
    currentJob?.status === "validating" ||
    currentJob?.status === "rendering";

  return (
    <div className="export-modal-backdrop" onClick={isRendering ? undefined : onClose}>
      <div
        className="export-modal-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal-title"
      >
        <div className="export-modal-header">
          <div className="export-modal-title-group">
            <span className="export-modal-icon">🎬</span>
            <h3 id="export-modal-title" className="export-modal-title">
              Export Timeline to MP4
            </h3>
          </div>
          <button
            type="button"
            className="export-modal-close-btn"
            onClick={onClose}
            disabled={isRendering}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="export-modal-body">
          {/* Global Error Banner */}
          {errorMessage && (
            <div className="export-alert export-alert-danger">
              <span className="alert-icon">⚠️</span>
              <div className="alert-content">
                <strong>Error:</strong> {errorMessage}
              </div>
            </div>
          )}

          {/* Validation Errors Banner */}
          {validationErrors.length > 0 && !currentJob && (
            <div className="export-alert export-alert-danger">
              <span className="alert-icon">🚫</span>
              <div className="alert-content">
                <strong>Cannot export timeline:</strong>
                <ul className="export-error-list">
                  {validationErrors.map((err, idx) => (
                    <li key={idx}>{err}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Active Rendering Progress Section */}
          {currentJob && (
            <div className="export-job-card">
              <div className="export-job-header">
                <span className="job-status-badge job-status-{currentJob.status}">
                  {currentJob.status === "queued" && "⏳ Queued in Render Engine"}
                  {currentJob.status === "validating" && "🔍 Validating Media Streams"}
                  {currentJob.status === "rendering" && "⚡ Rendering Video (FFmpeg)"}
                  {currentJob.status === "completed" && "✓ Render Complete"}
                  {currentJob.status === "failed" && "✗ Render Failed"}
                  {currentJob.status === "canceled" && "🚫 Render Canceled"}
                </span>
                <span className="job-id-label">Job: {currentJob.id.slice(-8)}</span>
              </div>

              {/* Progress Bar for In-flight Renders */}
              {isRendering && (
                <div className="export-progress-container">
                  <div className="export-progress-info">
                    <span>
                      {currentJob.status === "queued" && "Waiting in job queue..."}
                      {currentJob.status === "validating" && "Checking media assets and codecs..."}
                      {currentJob.status === "rendering" && `Encoding H.264 video: ${currentJob.progress}%`}
                    </span>
                    <span className="progress-percentage">{currentJob.progress}%</span>
                  </div>
                  <div className="progress-bar-track">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${Math.max(currentJob.progress, 3)}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Success Result & Download Link */}
              {currentJob.status === "completed" && (
                <div className="export-success-container">
                  <div className="export-success-message">
                    <span>🎉</span>
                    <div>
                      <strong>MP4 file rendered successfully!</strong>
                      <div className="export-meta-text">
                        Duration: {currentJob.outputMetadata?.duration?.toFixed(2) || plan?.duration.toFixed(2)}s
                        {currentJob.outputMetadata?.fileSizeBytes && (
                          <> • Size: {(currentJob.outputMetadata.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB</>
                        )}
                      </div>
                    </div>
                  </div>

                  <a
                    href={getRenderJobDownloadUrl(projectId, currentJob.id)}
                    download={currentJob.outputMetadata?.outputFileName || `render_${currentJob.id}.mp4`}
                    className="export-download-btn"
                  >
                    ⬇ Download MP4 Video
                  </a>
                </div>
              )}

              {/* Failure Error Display */}
              {currentJob.status === "failed" && (
                <div className="export-failure-container">
                  <div className="export-failure-msg">
                    <strong>Rendering Error:</strong> {currentJob.error || "Unknown rendering failure."}
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={handleReset}>
                    🔄 Try Again
                  </button>
                </div>
              )}

              {/* Canceled Display */}
              {currentJob.status === "canceled" && (
                <div className="export-canceled-container">
                  <span>Render job was canceled by user.</span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={handleReset}>
                    🔄 Start New Render
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Settings & Specifications Summary */}
          {!currentJob && plan && (
            <div className="export-specs-grid">
              <div className="spec-item">
                <span className="spec-label">Output Format</span>
                <span className="spec-val">MP4 (H.264 / AAC)</span>
              </div>
              <div className="spec-item">
                <span className="spec-label">Resolution</span>
                <span className="spec-val">
                  {plan.settings.width} × {plan.settings.height}
                </span>
              </div>
              <div className="spec-item">
                <span className="spec-label">Frame Rate</span>
                <span className="spec-val">{plan.settings.frameRate} fps</span>
              </div>
              <div className="spec-item">
                <span className="spec-label">Total Duration</span>
                <span className="spec-val">
                  {formatTimeCode(plan.duration)} ({plan.duration.toFixed(2)}s)
                </span>
              </div>
              <div className="spec-item">
                <span className="spec-label">Color Format</span>
                <span className="spec-val">{plan.output.pixelFormat}</span>
              </div>
              <div className="spec-item">
                <span className="spec-label">Video Clips</span>
                <span className="spec-val">{plan.videoClips.length} clip(s)</span>
              </div>
            </div>
          )}

          {/* Validating Spinner */}
          {!currentJob && isValidating && (
            <div className="export-loading-state">
              <span className="spinner" style={{ width: "24px", height: "24px", borderWidth: "3px" }} />
              <span>Validating timeline and media streams...</span>
            </div>
          )}
        </div>

        <div className="export-modal-footer">
          {isRendering ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleCancelRender}
            >
              ✕ Cancel Render
            </button>
          ) : currentJob?.status === "completed" ? (
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary export-submit-btn"
                onClick={handleStartRender}
                disabled={
                  isSubmitting ||
                  isValidating ||
                  validationErrors.length > 0 ||
                  !plan ||
                  plan.duration <= 0
                }
              >
                {isSubmitting ? "Starting Render..." : "🚀 Render MP4"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

