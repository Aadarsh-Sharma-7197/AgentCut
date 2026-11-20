import { createHash } from "node:crypto";
import type { ProposedOperation } from "@agentcut/shared";

export interface CanonicalPlanInput {
  requestId: string;
  projectId: string;
  planId: string;
  targetTimelineRevision: number;
  operations: ProposedOperation[];
}

/**
 * Deterministically sorts object keys and normalizes values for canonical JSON serialization.
 */
function canonicalizeValue(val: unknown): unknown {
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "string") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  if (typeof val === "object") {
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(val as Record<string, unknown>).sort();
    for (const key of keys) {
      const v = (val as Record<string, unknown>)[key];
      if (v !== undefined) {
        sortedObj[key] = canonicalizeValue(v);
      }
    }
    return sortedObj;
  }
  return String(val);
}

/**
 * Calculates a deterministic canonical SHA-256 hash for an editing plan.
 * Binds:
 * - Request ID
 * - Project ID
 * - Plan ID
 * - Target timeline revision
 * - Operations in exact sequential order (types, track/clip targets, assetId, timing, and parameters)
 *
 * Note on execution options:
 * Currently, no separate execution options exist on AgentEditingPlan outside the operations array.
 * If separate execution options are introduced in future steps, they must be included in CanonicalPlanInput.
 */
export function computePlanHash(input: CanonicalPlanInput): string {
  const canonicalPayload = {
    requestId: input.requestId,
    projectId: input.projectId,
    planId: input.planId,
    targetTimelineRevision: input.targetTimelineRevision,
    operations: (input.operations || []).map((op, idx) => ({
      index: idx,
      id: op.id,
      type: op.type,
      trackId: op.trackId,
      clipId: op.clipId,
      assetId: op.assetId,
      timeRange: op.timeRange
        ? {
            sourceStart: op.timeRange.sourceStart,
            sourceEnd: op.timeRange.sourceEnd,
            timelineStart: op.timeRange.timelineStart,
            timelineEnd: op.timeRange.timelineEnd
          }
        : undefined,
      params: canonicalizeValue(op.params || {})
    }))
  };

  const jsonString = JSON.stringify(canonicalizeValue(canonicalPayload));
  return createHash("sha256").update(jsonString, "utf8").digest("hex");
}

