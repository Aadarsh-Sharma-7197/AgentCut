import React from "react";
import type { ProposedOperation, Timeline, MediaAsset } from "@agentcut/shared";
import { deriveOperationDiff, type OperationDiffSummary } from "../../utils/agentCalculations";

interface OperationDiffItemProps {
  operation: ProposedOperation;
  index: number;
  timeline: Timeline | null;
  mediaAssets: MediaAsset[];
}

function getBadgeClass(rawType: string): string {
  switch (rawType) {
    case "split_clip":
      return "op-badge-split";
    case "trim_clip":
      return "op-badge-trim";
    case "move_clip":
      return "op-badge-move";
    case "delete_clip":
      return "op-badge-delete";
    case "remove_silence":
      return "op-badge-silence";
    default:
      return "op-badge-unknown";
  }
}

export const OperationDiffItem: React.FC<OperationDiffItemProps> = ({
  operation,
  index,
  timeline,
  mediaAssets
}) => {
  const diff: OperationDiffSummary = deriveOperationDiff(operation, timeline, mediaAssets);

  return (
    <div className="operation-item-card" data-testid={`operation-diff-item-${index}`}>
      <div className="op-header-row">
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span className={`op-badge-type ${getBadgeClass(diff.rawType)}`}>
            #{index + 1} {diff.typeLabel}
          </span>
          {diff.targetClipName && (
            <span className="op-target-info">
              {diff.targetClipName} ({diff.targetTrackName})
            </span>
          )}
        </div>
      </div>

      <div className="op-desc">{diff.description}</div>
      {diff.explanation && <div className="op-explanation">"{diff.explanation}"</div>}

      {/* Before / After Diff comparison grid */}
      {(diff.before || diff.after) && (
        <div className="op-diff-grid">
          <div className="diff-col">
            <span className="diff-label">Before</span>
            {diff.before ? (
              <>
                <span className="diff-val">
                  Start: {diff.before.timelineStart?.toFixed(2)}s | Dur: {diff.before.duration?.toFixed(2)}s
                </span>
                {diff.before.sourceRange && (
                  <span className="diff-val" style={{ fontSize: "0.7rem", color: "#64748b" }}>
                    Src: {diff.before.sourceRange}
                  </span>
                )}
              </>
            ) : (
              <span className="diff-val">—</span>
            )}
          </div>

          <div className="diff-arrow">➔</div>

          <div className="diff-col">
            <span className="diff-label">Proposed</span>
            {diff.after ? (
              <>
                <span className="diff-val" style={{ color: "#38bdf8" }}>
                  Start: {diff.after.timelineStart?.toFixed(2)}s | Dur: {diff.after.duration?.toFixed(2)}s
                </span>
                {diff.after.sourceRange && (
                  <span className="diff-val" style={{ fontSize: "0.7rem", color: "#64748b" }}>
                    Src: {diff.after.sourceRange}
                  </span>
                )}
                {diff.after.segment2 && (
                  <span className="diff-val" style={{ color: "#a78bfa", fontSize: "0.72rem" }}>
                    Seg 2: {diff.after.segment2.timelineStart.toFixed(2)}s ({diff.after.segment2.duration.toFixed(2)}s)
                  </span>
                )}
              </>
            ) : (
              <span className="diff-val" style={{ color: "#f87171" }}>
                [Deleted / Removed]
              </span>
            )}
          </div>
        </div>
      )}

      {/* Human-readable Delta Summary */}
      <div className="op-delta-summary">ℹ️ {diff.deltaSummary}</div>

      {/* Warnings */}
      {diff.warnings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          {diff.warnings.map((w, wIdx) => (
            <div key={wIdx} style={{ fontSize: "0.75rem", color: "#fca5a5" }}>
              ⚠️ {w}
            </div>
          ))}
        </div>
      )}

      {/* Evidence References */}
      {operation.evidence && operation.evidence.length > 0 && (
        <div className="op-evidence-tags">
          {operation.evidence.map((ev, evIdx) => (
            <span key={evIdx} className="evidence-chip" title={ev.snippet || undefined}>
              🔍 {ev.type.toUpperCase()}: {ev.start !== undefined ? `${ev.start.toFixed(1)}s` : ""}{ev.end !== undefined ? `–${ev.end.toFixed(1)}s` : ""} {ev.snippet ? `"${ev.snippet.slice(0, 30)}..."` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

