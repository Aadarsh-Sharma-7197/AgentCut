import React, { useState, useEffect, useRef, useCallback } from "react";
import type { AgentRequest, Timeline, MediaAsset } from "@agentcut/shared";
import {
  createAgentRequestApi,
  getAgentRequestApi,
  approveAgentRequestApi,
  rejectAgentRequestApi,
  cancelAgentRequestApi,
  type ApproveAgentRequestResponse,
  type AgentApiError
} from "../../api/agent";
import { PlanReviewCard } from "./PlanReviewCard";
import "./agent.css";

interface AgentAssistantPanelProps {
  projectId: string;
  timeline: Timeline | null;
  mediaAssets: MediaAsset[];
  onApplyExecution: (res: ApproveAgentRequestResponse) => Promise<void> | void;
  onRefreshTimeline: () => Promise<void> | void;
  onClose?: () => void;
  onBeforeApprove?: () => Promise<void>;
  onExecutionStateChange?: (isExecuting: boolean) => void;
}

export const AgentAssistantPanel: React.FC<AgentAssistantPanelProps> = ({
  projectId,
  timeline,
  mediaAssets,
  onApplyExecution,
  onRefreshTimeline,
  onClose,
  onBeforeApprove,
  onExecutionStateChange
}) => {
  const [prompt, setPrompt] = useState("");
  const [activeRequest, setActiveRequest] = useState<AgentRequest | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uncertainState, setUncertainState] = useState<boolean>(false);

  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAttemptsRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);

  const MAX_POLL_ATTEMPTS = 30; // 30 attempts * 1s = 30s bounded polling
  const POLL_INTERVAL_MS = 1000;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      onExecutionStateChange?.(false);
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
      }
    };
  }, [onExecutionStateChange]);

  const clearPolling = useCallback(() => {
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    pollAttemptsRef.current = 0;
  }, []);

  const pollRequestStatus = useCallback(
    async (requestId: string) => {
      if (!isMountedRef.current) return;

      pollAttemptsRef.current += 1;
      try {
        const updated = await getAgentRequestApi(projectId, requestId);
        if (!isMountedRef.current) return;

        setActiveRequest(updated);

        // Terminal or stable interactive states stop polling
        if (updated.status === "executing") {
          onExecutionStateChange?.(true);
        } else if (
          updated.status === "awaiting_approval" ||
          updated.status === "completed" ||
          updated.status === "failed" ||
          updated.status === "canceled"
        ) {
          onExecutionStateChange?.(false);
          clearPolling();
          setUncertainState(false);
          return;
        }

        // Check bounded polling deadline
        if (pollAttemptsRef.current >= MAX_POLL_ATTEMPTS) {
          onExecutionStateChange?.(false);
          clearPolling();
          setUncertainState(true);
          return;
        }

        // Schedule next bounded poll
        pollTimeoutRef.current = setTimeout(() => {
          void pollRequestStatus(requestId);
        }, POLL_INTERVAL_MS);
      } catch (err) {
        if (!isMountedRef.current) return;
        // Network or server error during poll
        if (pollAttemptsRef.current >= MAX_POLL_ATTEMPTS) {
          onExecutionStateChange?.(false);
          clearPolling();
          setUncertainState(true);
        } else {
          pollTimeoutRef.current = setTimeout(() => {
            void pollRequestStatus(requestId);
          }, POLL_INTERVAL_MS);
        }
      }
    },
    [projectId, clearPolling, onExecutionStateChange]
  );

  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    setUncertainState(false);
    clearPolling();

    try {
      const created = await createAgentRequestApi(projectId, {
        prompt: cleanPrompt
      });
      setActiveRequest(created);
      setPrompt("");

      if (created.status === "queued" || created.status === "processing") {
        pollTimeoutRef.current = setTimeout(() => {
          void pollRequestStatus(created.id);
        }, POLL_INTERVAL_MS);
      }
    } catch (err: unknown) {
      const apiErr = err as AgentApiError;
      setErrorMessage(apiErr.message || "Failed to create agent request.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApprove = async () => {
    if (!activeRequest || isApproving) return;
    const plan = activeRequest.editingPlan ?? activeRequest.approvalPlan?.editingPlan;
    if (!plan || !plan.planHash) {
      setErrorMessage("Agent request does not contain a valid hashed editing plan.");
      return;
    }

    try {
      // 1. Drain any in-flight local saves and lock timeline before dispatching CAS approval
      if (onBeforeApprove) {
        await onBeforeApprove();
      }
      setIsApproving(true);
      onExecutionStateChange?.(true);
      setErrorMessage(null);

      const payload = {
        planHash: plan.planHash,
        expectedTimelineRevision: plan.targetTimelineRevision ?? timeline?.revision ?? 1
      };

      const res = await approveAgentRequestApi(projectId, activeRequest.id, payload);
      setActiveRequest(res.request);

      // Authoritatively apply synchronized timeline and history
      await onApplyExecution(res);
    } catch (err: unknown) {
      onExecutionStateChange?.(false);
      const apiErr = err as AgentApiError;
      if (apiErr.code === "STALE_TIMELINE_REVISION") {
        setErrorMessage(
          "Timeline revision conflict: The timeline was modified since this plan was proposed. The plan is now stale. Please refresh the timeline and generate a fresh plan."
        );
        void onRefreshTimeline();
      } else {
        setErrorMessage(apiErr.message || "Failed to approve editing plan.");
      }
    } finally {
      setIsApproving(false);
    }
  };

  const handleReject = async () => {
    if (!activeRequest || isApproving) return;

    try {
      const updated = await rejectAgentRequestApi(projectId, activeRequest.id, "Rejected by user.");
      setActiveRequest(updated);
    } catch (err: unknown) {
      const apiErr = err as AgentApiError;
      setErrorMessage(apiErr.message || "Failed to reject editing plan.");
    }
  };

  const handleCancelRequest = async () => {
    if (!activeRequest) return;
    try {
      const updated = await cancelAgentRequestApi(projectId, activeRequest.id);
      setActiveRequest(updated);
      clearPolling();
    } catch (err: unknown) {
      const apiErr = err as AgentApiError;
      setErrorMessage(apiErr.message || "Failed to cancel request.");
    }
  };

  const handleManualCheckStatus = async () => {
    if (!activeRequest) return;
    setUncertainState(false);
    pollAttemptsRef.current = 0;
    await pollRequestStatus(activeRequest.id);
  };

  const currentPlan = activeRequest?.editingPlan ?? activeRequest?.approvalPlan?.editingPlan;

  return (
    <div className="agent-assistant-panel" data-testid="agent-assistant-panel">
      <div className="agent-panel-header">
        <div className="agent-title-group">
          <span className="agent-title">🤖 AI Editing Assistant</span>
          {activeRequest && (
            <span className={`agent-badge agent-badge-${activeRequest.status}`}>
              {activeRequest.status.replace("_", " ")}
            </span>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="btn btn-secondary"
            style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
            title="Close Assistant Panel"
          >
            ✕
          </button>
        )}
      </div>

      {/* Prompt Form */}
      <form onSubmit={handleCreateRequest} className="agent-prompt-form">
        <input
          type="text"
          className="agent-prompt-input"
          placeholder="Describe your editing goal (e.g. 'Remove all silence', 'Split clip at 00:05.000', 'Trim start by 2s')..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={isSubmitting || isApproving}
          data-testid="agent-prompt-input"
        />
        <button
          type="submit"
          className="btn-generate"
          disabled={!prompt.trim() || isSubmitting || isApproving}
          data-testid="agent-generate-btn"
        >
          {isSubmitting ? (
            <>
              <span className="spinner" style={{ width: "12px", height: "12px", borderWidth: "2px", display: "inline-block" }}></span>
              Planning...
            </>
          ) : (
            <>✨ Generate Plan</>
          )}
        </button>
      </form>

      {/* Error Callout */}
      {errorMessage && (
        <div className="agent-status-banner agent-status-failed" data-testid="agent-error-banner">
          <div>⚠️ {errorMessage}</div>
          <button
            className="btn btn-secondary"
            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
            onClick={() => setErrorMessage(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Uncertain / Reconciliation State */}
      {uncertainState && (
        <div className="agent-status-banner agent-status-uncertain" data-testid="agent-uncertain-banner">
          <div>
            ⚠️ <strong>Execution outcome unconfirmed:</strong> The server may still be processing or reconciling this execution. Status could not be confirmed within deadline.
          </div>
          <button
            className="btn btn-secondary"
            style={{ fontSize: "0.75rem", padding: "0.25rem 0.6rem" }}
            onClick={handleManualCheckStatus}
          >
            Check Status
          </button>
        </div>
      )}

      {/* Status: Queued or Processing */}
      {activeRequest && (activeRequest.status === "queued" || activeRequest.status === "processing") && (
        <div className="agent-status-banner agent-status-executing">
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span className="spinner" style={{ width: "14px", height: "14px", borderWidth: "2px", display: "inline-block" }}></span>
            <span>
              {activeRequest.status === "queued" ? "Request queued for agent..." : "Agent inspecting media context and building editing plan..."}
            </span>
          </div>
          <button
            className="btn btn-secondary"
            style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
            onClick={handleCancelRequest}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Status: Executing */}
      {activeRequest && activeRequest.status === "executing" && (
        <div className="agent-status-banner agent-status-executing" data-testid="agent-executing-banner">
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span className="spinner" style={{ width: "14px", height: "14px", borderWidth: "2px", display: "inline-block" }}></span>
            <span>
              Executing plan edits with CAS timeline revision protection...
            </span>
          </div>
        </div>
      )}

      {/* Status: Awaiting Approval (Plan Review Card) */}
      {activeRequest && activeRequest.status === "awaiting_approval" && currentPlan && (
        <PlanReviewCard
          plan={currentPlan}
          timeline={timeline}
          mediaAssets={mediaAssets}
          isApproving={isApproving}
          onApprove={handleApprove}
          onReject={handleReject}
          onRefreshTimeline={onRefreshTimeline}
        />
      )}

      {/* Status: Completed Confirmation */}
      {activeRequest && activeRequest.status === "completed" && (
        <div className="agent-status-banner agent-status-completed" data-testid="agent-completed-banner">
          <div>
            <strong>✓ Edits Applied:</strong> {activeRequest.result?.summary || "Editing plan successfully executed on timeline."}
            {activeRequest.executionReceipt && (
              <span style={{ display: "block", fontSize: "0.75rem", color: "#a7f3d0", marginTop: "0.25rem" }}>
                Committed Revision: {activeRequest.executionReceipt.committedTimelineRevision} • Execution ID: {activeRequest.executionReceipt.executionId.slice(0, 8)}
              </span>
            )}
          </div>
          <button
            className="btn btn-secondary"
            style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
            onClick={() => setActiveRequest(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status: Canceled / Rejected */}
      {activeRequest && activeRequest.status === "canceled" && (
        <div className="agent-status-banner" style={{ backgroundColor: "#1e293b", color: "#94a3b8" }}>
          <div>
            🚫 Plan was rejected or request was canceled. No timeline changes were made.
          </div>
          <button
            className="btn btn-secondary"
            style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
            onClick={() => setActiveRequest(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status: Failed */}
      {activeRequest && activeRequest.status === "failed" && (
        <div className="agent-status-banner agent-status-failed">
          <div>
            <strong>Plan execution failed:</strong> {activeRequest.error || "An error occurred during execution."}
          </div>
          <button
            className="btn btn-secondary"
            style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
            onClick={() => setActiveRequest(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
};
