import crypto from "crypto";
import type {
  AgentEditingPlan,
  ProposedOperation,
  ProposedOperationType,
  PlanEvidenceReference,
  PlanStatus
} from "@agentcut/shared";
import { SUPPORTED_PROPOSED_OPERATIONS } from "@agentcut/shared";
import { AgentValidationError, AgentNotFoundError } from "./agent-errors.js";
import { getProjectById } from "../project.service.js";
import { getMediaAssetById } from "../media.service.js";
import { getTimelineByProject } from "../timeline.service.js";

/**
 * Validates the structure, types, and mathematical consistency of a proposed editing plan.
 */
export function validateEditingPlan(
  raw: unknown,
  expectedProjectId?: string,
  expectedRequestId?: string
): AgentEditingPlan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentValidationError("Editing plan must be a non-empty object.");
  }

  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : crypto.randomUUID();
  const requestId =
    typeof obj.requestId === "string" && obj.requestId.trim()
      ? obj.requestId.trim()
      : expectedRequestId || crypto.randomUUID();

  const projectId =
    typeof obj.projectId === "string" && obj.projectId.trim()
      ? obj.projectId.trim()
      : expectedProjectId;

  if (!projectId) {
    throw new AgentValidationError("Editing plan must include a valid projectId.");
  }
  if (expectedProjectId && projectId !== expectedProjectId) {
    throw new AgentValidationError(
      `Plan projectId '${projectId}' does not match context projectId '${expectedProjectId}'.`
    );
  }

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (!summary) {
    throw new AgentValidationError("Editing plan summary must be a non-empty string.");
  }

  // CRITICAL INVARIANT: Never trust model-supplied status.
  // Reject plans containing approved, rejected, or applied, and enforce status 'proposed'.
  if (obj.status !== undefined && obj.status !== null && obj.status !== "proposed") {
    throw new AgentValidationError(
      `Model-generated editing plan cannot self-assign status '${String(obj.status)}'. Newly proposed plans must always have status 'proposed'.`
    );
  }
  const status: PlanStatus = "proposed";

  const timelineId = typeof obj.timelineId === "string" && obj.timelineId.trim() ? obj.timelineId.trim() : undefined;

  const warnings = Array.isArray(obj.warnings)
    ? obj.warnings.filter((w): w is string => typeof w === "string" && Boolean(w.trim())).map((w) => w.trim())
    : [];

  const assumptions = Array.isArray(obj.assumptions)
    ? obj.assumptions.filter((a): a is string => typeof a === "string" && Boolean(a.trim())).map((a) => a.trim())
    : [];

  if (!Array.isArray(obj.operations) || obj.operations.length === 0) {
    throw new AgentValidationError("Editing plan must contain at least one proposed operation in 'operations'.");
  }

  const validatedOperations: ProposedOperation[] = [];

  for (let i = 0; i < obj.operations.length; i++) {
    const rawOp = obj.operations[i];
    if (!rawOp || typeof rawOp !== "object" || Array.isArray(rawOp)) {
      throw new AgentValidationError(`Operation at index ${i} must be a non-empty object.`);
    }

    const op = rawOp as Record<string, unknown>;
    const opId = typeof op.id === "string" && op.id.trim() ? op.id.trim() : crypto.randomUUID();

    if (typeof op.type !== "string" || !SUPPORTED_PROPOSED_OPERATIONS.includes(op.type as any)) {
      throw new AgentValidationError(
        `Operation at index ${i} has unsupported type '${String(op.type)}'. Allowed types: ${SUPPORTED_PROPOSED_OPERATIONS.join(", ")}.`
      );
    }
    const type = op.type as ProposedOperationType;

    const description = typeof op.description === "string" ? op.description.trim() : "";
    if (!description) {
      throw new AgentValidationError(`Operation at index ${i} (${type}) must have a non-empty description.`);
    }

    const explanation = typeof op.explanation === "string" && op.explanation.trim() ? op.explanation.trim() : undefined;
    const assetId = typeof op.assetId === "string" && op.assetId.trim() ? op.assetId.trim() : undefined;
    const trackId = typeof op.trackId === "string" && op.trackId.trim() ? op.trackId.trim() : undefined;
    const clipId = typeof op.clipId === "string" && op.clipId.trim() ? op.clipId.trim() : undefined;

    // Time ranges
    let timeRange: ProposedOperation["timeRange"] = undefined;
    if (op.timeRange && typeof op.timeRange === "object" && !Array.isArray(op.timeRange)) {
      const tr = op.timeRange as Record<string, unknown>;
      const validateTimestamp = (val: unknown, fieldName: string): number | undefined => {
        if (val === undefined || val === null) return undefined;
        if (typeof val !== "number" || !Number.isFinite(val) || isNaN(val) || val < 0) {
          throw new AgentValidationError(
            `Operation at index ${i} (${type}) has invalid ${fieldName} '${String(val)}': must be a finite non-negative number.`
          );
        }
        return Number(val.toFixed(3));
      };

      const sourceStart = validateTimestamp(tr.sourceStart, "timeRange.sourceStart");
      const sourceEnd = validateTimestamp(tr.sourceEnd, "timeRange.sourceEnd");
      const timelineStart = validateTimestamp(tr.timelineStart, "timeRange.timelineStart");
      const timelineEnd = validateTimestamp(tr.timelineEnd, "timeRange.timelineEnd");

      if (sourceStart !== undefined && sourceEnd !== undefined && sourceEnd <= sourceStart) {
        throw new AgentValidationError(
          `Operation at index ${i} (${type}) has invalid timeRange: sourceEnd (${sourceEnd}s) must be greater than sourceStart (${sourceStart}s).`
        );
      }
      if (timelineStart !== undefined && timelineEnd !== undefined && timelineEnd < timelineStart) {
        throw new AgentValidationError(
          `Operation at index ${i} (${type}) has invalid timeRange: timelineEnd (${timelineEnd}s) must be >= timelineStart (${timelineStart}s).`
        );
      }

      timeRange = { sourceStart, sourceEnd, timelineStart, timelineEnd };
    }

    const params: Record<string, unknown> =
      op.params && typeof op.params === "object" && !Array.isArray(op.params)
        ? (op.params as Record<string, unknown>)
        : {};

    // Operation-specific required field validations
    if (type === "remove_silence") {
      const effectiveAssetId = assetId || (typeof params.assetId === "string" ? params.assetId.trim() : undefined);
      if (!effectiveAssetId) {
        throw new AgentValidationError(`Operation at index ${i} (remove_silence) requires an 'assetId'.`);
      }

      const start = timeRange?.sourceStart ?? (typeof params.start === "number" ? params.start : undefined);
      const end = timeRange?.sourceEnd ?? (typeof params.end === "number" ? params.end : undefined);

      if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new AgentValidationError(
          `Operation at index ${i} (remove_silence) requires valid start and end timestamps where end > start >= 0.`
        );
      }
    } else if (type === "split_clip") {
      const effectiveClipId = clipId || (typeof params.clipId === "string" ? params.clipId.trim() : undefined);
      if (!effectiveClipId) {
        throw new AgentValidationError(`Operation at index ${i} (split_clip) requires a 'clipId'.`);
      }

      const splitTime =
        typeof params.splitTime === "number"
          ? params.splitTime
          : timeRange?.timelineStart ?? (typeof params.time === "number" ? params.time : undefined);

      if (splitTime === undefined || !Number.isFinite(splitTime) || splitTime < 0) {
        throw new AgentValidationError(
          `Operation at index ${i} (split_clip) requires a non-negative finite splitTime.`
        );
      }
    } else if (type === "trim_clip") {
      const effectiveClipId = clipId || (typeof params.clipId === "string" ? params.clipId.trim() : undefined);
      if (!effectiveClipId) {
        throw new AgentValidationError(`Operation at index ${i} (trim_clip) requires a 'clipId'.`);
      }

      const start = timeRange?.sourceStart ?? (typeof params.sourceStart === "number" ? params.sourceStart : undefined);
      const end = timeRange?.sourceEnd ?? (typeof params.sourceEnd === "number" ? params.sourceEnd : undefined);
      const targetTime = typeof params.targetTime === "number" ? params.targetTime : undefined;

      if (start === undefined && end === undefined && targetTime === undefined) {
        throw new AgentValidationError(
          `Operation at index ${i} (trim_clip) requires sourceStart, sourceEnd, or targetTime to be specified.`
        );
      }
      if (start !== undefined && (typeof start !== "number" || !Number.isFinite(start) || start < 0)) {
        throw new AgentValidationError(`Operation at index ${i} (trim_clip) sourceStart must be non-negative.`);
      }
      if (end !== undefined && (typeof end !== "number" || !Number.isFinite(end) || end <= 0)) {
        throw new AgentValidationError(`Operation at index ${i} (trim_clip) sourceEnd must be positive.`);
      }
      if (start !== undefined && end !== undefined && end <= start) {
        throw new AgentValidationError(`Operation at index ${i} (trim_clip) sourceEnd must be greater than sourceStart.`);
      }
    } else if (type === "move_clip") {
      const effectiveClipId = clipId || (typeof params.clipId === "string" ? params.clipId.trim() : undefined);
      if (!effectiveClipId) {
        throw new AgentValidationError(`Operation at index ${i} (move_clip) requires a 'clipId'.`);
      }

      const newTimelineStart =
        typeof params.newTimelineStart === "number"
          ? params.newTimelineStart
          : timeRange?.timelineStart;

      if (newTimelineStart === undefined || !Number.isFinite(newTimelineStart) || newTimelineStart < 0) {
        throw new AgentValidationError(
          `Operation at index ${i} (move_clip) requires a non-negative newTimelineStart.`
        );
      }
    } else if (type === "delete_clip") {
      const effectiveClipId = clipId || (typeof params.clipId === "string" ? params.clipId.trim() : undefined);
      if (!effectiveClipId) {
        throw new AgentValidationError(`Operation at index ${i} (delete_clip) requires a 'clipId'.`);
      }
    }

    // Evidence references validation
    let evidence: PlanEvidenceReference[] | undefined = undefined;
    if (Array.isArray(op.evidence)) {
      evidence = [];
      for (let j = 0; j < op.evidence.length; j++) {
        const ev = op.evidence[j];
        if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
          throw new AgentValidationError(`Operation at index ${i} evidence item ${j} must be an object.`);
        }
        const evObj = ev as Record<string, unknown>;
        if (evObj.type !== "speech" && evObj.type !== "silence" && evObj.type !== "scene") {
          throw new AgentValidationError(
            `Operation at index ${i} evidence item ${j} has invalid type '${String(evObj.type)}'. Allowed: speech, silence, scene.`
          );
        }
        if (typeof evObj.assetId !== "string" || !evObj.assetId.trim()) {
          throw new AgentValidationError(`Operation at index ${i} evidence item ${j} requires a non-empty assetId.`);
        }

        const evStart = typeof evObj.start === "number" && Number.isFinite(evObj.start) && evObj.start >= 0 ? evObj.start : undefined;
        const evEnd = typeof evObj.end === "number" && Number.isFinite(evObj.end) && evObj.end >= 0 ? evObj.end : undefined;
        if (evStart !== undefined && evEnd !== undefined && evEnd < evStart) {
          throw new AgentValidationError(
            `Operation at index ${i} evidence item ${j} end (${evEnd}s) cannot be before start (${evStart}s).`
          );
        }

        evidence.push({
          type: evObj.type,
          assetId: evObj.assetId.trim(),
          start: evStart,
          end: evEnd,
          snippet: typeof evObj.snippet === "string" ? evObj.snippet.trim() : undefined,
          frameUrl: typeof evObj.frameUrl === "string" ? evObj.frameUrl.trim() : undefined
        });
      }
    }

    validatedOperations.push({
      id: opId,
      type,
      description,
      explanation,
      assetId,
      trackId,
      clipId,
      timeRange,
      params,
      evidence
    });
  }

  return {
    id,
    requestId,
    projectId,
    timelineId,
    targetTimelineRevision: typeof obj.targetTimelineRevision === "number" && Number.isInteger(obj.targetTimelineRevision) ? obj.targetTimelineRevision : undefined,
    planHash: typeof obj.planHash === "string" && obj.planHash.trim() ? obj.planHash.trim() : undefined,
    summary,
    operations: validatedOperations,
    warnings,
    assumptions,
    status,
    createdAt: typeof obj.createdAt === "string" && obj.createdAt.trim() ? obj.createdAt.trim() : new Date().toISOString()
  };
}

/**
 * Validates plan references against actual database project, media assets, and timeline state.
 */
export async function validateEditingPlanAgainstProject(
  plan: AgentEditingPlan,
  projectId: string
): Promise<void> {
  if (plan.projectId !== projectId) {
    throw new AgentValidationError(`Plan project ID '${plan.projectId}' does not match target project '${projectId}'.`);
  }

  const project = await getProjectById(projectId);
  if (!project) {
    throw new AgentNotFoundError(`Project '${projectId}' not found.`);
  }

  const timeline = await getTimelineByProject(projectId);

  for (let i = 0; i < plan.operations.length; i++) {
    const op = plan.operations[i];

    // Asset validation
    const targetAssetId = op.assetId || (typeof op.params.assetId === "string" ? op.params.assetId : undefined);
    if (targetAssetId) {
      const assetRecord = await getMediaAssetById(projectId, targetAssetId);
      if (!assetRecord) {
        throw new AgentValidationError(
          `Operation ${i} (${op.type}) references asset '${targetAssetId}' which does not exist in project '${projectId}'.`
        );
      }

      const assetDuration = assetRecord.asset.duration || 0;
      if (assetDuration > 0) {
        const sourceEnd = op.timeRange?.sourceEnd ?? (typeof op.params.end === "number" ? op.params.end : undefined);
        if (sourceEnd !== undefined && sourceEnd > assetDuration + 0.5) {
          throw new AgentValidationError(
            `Operation ${i} (${op.type}) sourceEnd (${sourceEnd}s) exceeds asset duration (${assetDuration}s).`
          );
        }
      }
    }

    // Timeline, track, and clip checks
    if (op.clipId || (typeof op.params.clipId === "string" ? op.params.clipId : undefined)) {
      const clipId = op.clipId || String(op.params.clipId);
      if (!timeline) {
        throw new AgentValidationError(
          `Operation ${i} (${op.type}) references clip '${clipId}', but no timeline exists for project '${projectId}'.`
        );
      }

      let foundClip: any = null;
      let foundTrack: any = null;

      for (const track of timeline.tracks) {
        const c = track.clips.find((item: any) => item.id === clipId);
        if (c) {
          foundClip = c;
          foundTrack = track;
          break;
        }
      }

      if (!foundClip) {
        throw new AgentValidationError(
          `Operation ${i} (${op.type}) references clip '${clipId}' which does not exist on the timeline.`
        );
      }

      if (op.trackId && op.trackId !== foundTrack.id) {
        throw new AgentValidationError(
          `Operation ${i} (${op.type}) specifies trackId '${op.trackId}', but clip '${clipId}' is on track '${foundTrack.id}'.`
        );
      }

      // If split_clip, verify split position is strictly inside clip timeline duration
      if (op.type === "split_clip") {
        const splitTime =
          typeof op.params.splitTime === "number"
            ? op.params.splitTime
            : op.timeRange?.timelineStart ?? (typeof op.params.time === "number" ? op.params.time : undefined);

        const clipStart = foundClip.timelineStart;
        const clipEnd = clipStart + (foundClip.sourceEnd - foundClip.sourceStart);

        if (splitTime !== undefined && (splitTime <= clipStart || splitTime >= clipEnd)) {
          throw new AgentValidationError(
            `Operation ${i} (split_clip) split time (${splitTime}s) must be strictly inside clip boundaries [${clipStart}s, ${clipEnd}s].`
          );
        }
      }
    }

    // Evidence asset verification
    if (op.evidence) {
      for (const ev of op.evidence) {
        const evAsset = await getMediaAssetById(projectId, ev.assetId);
        if (!evAsset) {
          throw new AgentValidationError(
            `Operation ${i} evidence references asset '${ev.assetId}' which does not exist in project '${projectId}'.`
          );
        }
      }
    }
  }
}
