import React from "react";
import type { AgentEditingPlan, Timeline, MediaAsset } from "@agentcut/shared";
import { OperationDiffItem } from "./OperationDiffItem";

interface PlanReviewCardProps {
  plan: AgentEditingPlan;
  timeline: Timeline | null;
  mediaAssets: MediaAsset[];
  isApproving: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRefreshTimeline?: () => void;
}

export const PlanReviewCard: React.FC<PlanReviewCardProps> = ({
  plan,
  timeline,
  mediaAssets,
  isApproving,
  onApprove,
  onReject,
  onRefreshTimeline
}) => {
  const currentRevision = timeline?.revision ?? 1;
  const targetRevision = plan.targetTimelineRevision ?? 1;
  const isStale = currentRevision !== targetRevision;

  return (
    <div className="plan-review-card" data-testid="plan-review-card">
      <div className="plan-header-row">
        <div>
          <div className="plan-summary-text">{plan.summary}</div>
          <div style={{ fontSize: "0.78rem", color: "#94a3b8", marginTop: "0.2rem" }}>
            {plan.operations.length} proposed operation{plan.operations.length === 1 ? "" : "s"} • Request #{plan.requestId.slice(0, 8)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span className="plan-revision-pill" title={`Target Timeline Revision: ${targetRevision}`}>
            Target Rev: {targetRevision} {isStale ? `(Live: ${currentRevision})` : "✓"}
          </span>
        </div>
      </div>

      {/* Stale Plan Alert */}
      {isStale && (
        <div className="plan-stale-box" data-testid="stale-plan-alert">
          <div>
            <strong>⚠️ Stale Editing Plan:</strong> The live timeline was modified (revision {currentRevision}) since this plan was proposed (target revision {targetRevision}). Approval is blocked to prevent conflicting overwrites.
          </div>
          {onRefreshTimeline && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem", whiteSpace: "nowrap" }}
              onClick={onRefreshTimeline}
            >
              Refresh Timeline
            </button>
          )}
        </div>
      )}

      {/* Warnings Banner */}
      {plan.warnings && plan.warnings.length > 0 && (
        <div className="plan-alerts">
          {plan.warnings.map((warn, idx) => (
            <div key={idx} className="plan-warning-box">
              ⚠️ <strong>Warning:</strong> {warn}
            </div>
          ))}
        </div>
      )}

      {/* Assumptions Banner */}
      {plan.assumptions && plan.assumptions.length > 0 && (
        <div className="plan-alerts">
          {plan.assumptions.map((assump, idx) => (
            <div key={idx} className="plan-assumption-box">
              💡 <strong>Assumption:</strong> {assump}
            </div>
          ))}
        </div>
      )}

      {/* Ordered Operations Diff List */}
      <div className="operations-list">
        {plan.operations.map((op, idx) => (
          <OperationDiffItem
            key={op.id || idx}
            operation={op}
            index={idx}
            timeline={timeline}
            mediaAssets={mediaAssets}
          />
        ))}
      </div>

      {/* Explicit Actions Footer */}
      <div className="plan-actions-footer">
        <button
          className="btn-reject"
          disabled={isApproving}
          onClick={onReject}
          title="Reject this plan without applying edits"
          data-testid="reject-plan-btn"
        >
          ✕ Reject Plan
        </button>

        <button
          className="btn-approve"
          disabled={isApproving || isStale}
          onClick={onApprove}
          title={isStale ? "Cannot approve: plan is stale" : "Approve and execute plan on timeline"}
          data-testid="approve-plan-btn"
        >
          {isApproving ? (
            <>
              <span className="spinner" style={{ width: "12px", height: "12px", borderWidth: "2px", display: "inline-block" }}></span>
              Executing Edits...
            </>
          ) : (
            <>✓ Approve & Apply Edits</>
          )}
        </button>
      </div>
    </div>
  );
};

