import crypto from "crypto";
import { ObjectId } from "mongodb";
import {
  type AgentRequest,
  type AgentRequestStatus,
  type AgentRequestLimits,
  type CreateAgentRequestDTO,
  type AgentEvent,
  type AgentResult,
  type AgentApprovalPlan,
  type AgentEditingPlan,
  type ExecutionReceipt,
  type Timeline,
  executeEditingPlan,
  AGENT_SAFETY_LIMITS,
  isValidAgentStatusTransition
} from "@agentcut/shared";
import {
  type AgentRequestDocument,
  getAgentRequestsCollection,
  toAgentRequestDTO
} from "../../models/agent-request.model.js";
import { getProjectById } from "../project.service.js";
import {
  AgentValidationError,
  AgentNotFoundError,
  AgentStateTransitionError,
  PlanHashMismatchError,
  StaleTimelineRevisionError,
  RequestNotApprovableError,
  ExecutionAlreadyStartedError,
  ExecutionValidationFailedError,
  ExecutionAbortedCrashError
} from "./agent-errors.js";
import { AgentToolRegistry } from "./agent-tools.js";
import { createReadOnlyToolRegistry } from "./tools/index.js";
import {
  DefaultAgentExecutionContext,
  type AgentPlanProvider
} from "./agent-context.js";
import { AgentRuntimeOrchestrator } from "./agent-orchestrator.js";
import {
  isGeminiConfigured,
  getGeminiConfig,
  GeminiConfigurationError
} from "../../config/gemini.config.js";
import { GeminiPlanProvider } from "./gemini/gemini-provider.js";
import {
  getTimelineByProject,
  saveTimelineCAS,
  TimelineConcurrencyError,
  TimelineNotFoundError
} from "../timeline.service.js";
import { getMediaAssetsByProject } from "../media.service.js";
import { computePlanHash } from "./plan-hash.js";
import { getDB } from "../../config/db.js";
import type { TimelineDocument } from "../../models/timeline.model.js";

// Global tool registry for the agent runtime
const defaultToolRegistry = createReadOnlyToolRegistry();

// In-memory active abort controllers for live cancellation
const activeControllers = new Map<string, AbortController>();

// Configurable custom plan provider (for testing or runtime override)
let customPlanProvider: AgentPlanProvider | null = null;

export function setCustomPlanProvider(provider: AgentPlanProvider | null): void {
  customPlanProvider = provider;
}

export function getActivePlanProvider(): AgentPlanProvider {
  if (customPlanProvider) {
    return customPlanProvider;
  }
  if (!isGeminiConfigured()) {
    throw new GeminiConfigurationError(
      "Gemini LLM provider is not configured. GEMINI_API_KEY is missing."
    );
  }
  const config = getGeminiConfig();
  return new GeminiPlanProvider(config, defaultToolRegistry);
}

export function getToolRegistry(): AgentToolRegistry {
  return defaultToolRegistry;
}

export function isAgentRequestActive(requestId: string): boolean {
  return activeControllers.has(requestId);
}

/**
 * Initializes database indexes for the agent_requests collection.
 */
export async function initAgentRequestIndexes(): Promise<void> {
  const collection = getAgentRequestsCollection();
  await collection.createIndex({ requestId: 1 }, { unique: true });
  await collection.createIndex({ projectId: 1, createdAt: -1 });
  await collection.createIndex({ projectId: 1, status: 1 });
}

/**
 * Validates request limits and applies system defaults and boundaries.
 */
export function sanitizeRequestLimits(input?: Partial<AgentRequestLimits>): AgentRequestLimits {
  let maxIterations: number = AGENT_SAFETY_LIMITS.DEFAULT_MAX_ITERATIONS;
  if (input?.maxIterations !== undefined) {
    if (
      typeof input.maxIterations !== "number" ||
      !Number.isInteger(input.maxIterations) ||
      input.maxIterations < AGENT_SAFETY_LIMITS.MIN_MAX_ITERATIONS ||
      input.maxIterations > AGENT_SAFETY_LIMITS.MAX_MAX_ITERATIONS
    ) {
      throw new AgentValidationError(
        `maxIterations must be an integer between ${AGENT_SAFETY_LIMITS.MIN_MAX_ITERATIONS} and ${AGENT_SAFETY_LIMITS.MAX_MAX_ITERATIONS}.`
      );
    }
    maxIterations = input.maxIterations;
  }

  let maxToolCalls: number = AGENT_SAFETY_LIMITS.DEFAULT_MAX_TOOL_CALLS;
  if (input?.maxToolCalls !== undefined) {
    if (
      typeof input.maxToolCalls !== "number" ||
      !Number.isInteger(input.maxToolCalls) ||
      input.maxToolCalls < AGENT_SAFETY_LIMITS.MIN_MAX_TOOL_CALLS ||
      input.maxToolCalls > AGENT_SAFETY_LIMITS.MAX_MAX_TOOL_CALLS
    ) {
      throw new AgentValidationError(
        `maxToolCalls must be an integer between ${AGENT_SAFETY_LIMITS.MIN_MAX_TOOL_CALLS} and ${AGENT_SAFETY_LIMITS.MAX_MAX_TOOL_CALLS}.`
      );
    }
    maxToolCalls = input.maxToolCalls;
  }

  let timeoutMs: number = AGENT_SAFETY_LIMITS.DEFAULT_TIMEOUT_MS;
  if (input?.timeoutMs !== undefined) {
    if (
      typeof input.timeoutMs !== "number" ||
      !Number.isInteger(input.timeoutMs) ||
      input.timeoutMs < AGENT_SAFETY_LIMITS.MIN_TIMEOUT_MS ||
      input.timeoutMs > AGENT_SAFETY_LIMITS.MAX_TIMEOUT_MS
    ) {
      throw new AgentValidationError(
        `timeoutMs must be an integer between ${AGENT_SAFETY_LIMITS.MIN_TIMEOUT_MS} and ${AGENT_SAFETY_LIMITS.MAX_TIMEOUT_MS}.`
      );
    }
    timeoutMs = input.timeoutMs;
  }

  return {
    maxIterations,
    maxToolCalls,
    timeoutMs
  };
}

/**
 * Creates a new agent request in queued status.
 */
export async function createAgentRequest(
  projectId: string,
  dto: CreateAgentRequestDTO
): Promise<AgentRequest> {
  if (!projectId || typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    throw new AgentValidationError("Invalid project ID format.");
  }

  const project = await getProjectById(projectId);
  if (!project) {
    throw new AgentNotFoundError("Project not found.");
  }

  if (
    !dto ||
    typeof dto.prompt !== "string" ||
    dto.prompt.trim().length === 0
  ) {
    throw new AgentValidationError("Prompt is required and cannot be empty.");
  }

  const trimmedPrompt = dto.prompt.trim();
  if (trimmedPrompt.length > AGENT_SAFETY_LIMITS.MAX_PROMPT_LENGTH) {
    throw new AgentValidationError(
      `Prompt exceeds maximum allowed length of ${AGENT_SAFETY_LIMITS.MAX_PROMPT_LENGTH} characters.`
    );
  }

  const limits = sanitizeRequestLimits({
    maxIterations: dto.maxIterations,
    maxToolCalls: dto.maxToolCalls,
    timeoutMs: dto.timeoutMs
  });

  const now = new Date();
  const requestId = crypto.randomUUID();

  const initialEvent: AgentEvent = {
    id: crypto.randomUUID(),
    timestamp: now.toISOString(),
    type: "request_queued",
    message: "Agent request created and queued.",
    data: { promptLength: trimmedPrompt.length }
  };

  const document: AgentRequestDocument = {
    _id: new ObjectId(),
    requestId,
    projectId,
    prompt: trimmedPrompt,
    status: "queued",
    iterations: 0,
    toolCallsCount: 0,
    limits,
    events: [initialEvent],
    createdAt: now,
    updatedAt: now
  };

  const collection = getAgentRequestsCollection();
  await collection.insertOne(document);

  return toAgentRequestDTO(document);
}

/**
 * Reconciles an agent request in 'executing' status against verifiable MongoDB timeline commit evidence.
 *
 * Safety invariants:
 * - If timeline.lastExecutionId === receipt.executionId AND timeline.revision === receipt.committedTimelineRevision:
 *   Proves definitively that this execution's timeline changes were committed AND that the timeline
 *   has not subsequently advanced past this execution's committed state.
 *   Finalizes request to 'completed'.
 * - If timeline.lastExecutionId === receipt.executionId BUT timeline.revision !== receipt.committedTimelineRevision:
 *   The timeline has advanced due to subsequent edits. Recovery must NOT falsely classify the old execution
 *   as the current committed state.
 *   Transitions request to 'failed'.
 * - If timeline.lastExecutionId !== receipt.executionId:
 *   Proves timeline changes were not committed by this execution.
 *   Transitions request to 'failed' with EXECUTION_ABORTED_CRASH.
 *   NEVER blindly re-executes.
 */
export async function reconcileExecutingRequest(
  doc: AgentRequestDocument
): Promise<AgentRequestDocument> {
  if (doc.status !== "executing" || !doc.executionReceipt) {
    return doc;
  }

  const { executionId, committedTimelineRevision } = doc.executionReceipt;
  const collection = getAgentRequestsCollection();
  const timelineCol = getDB().collection<TimelineDocument>("timelines");
  const liveTimelineDoc = await timelineCol.findOne({ projectId: doc.projectId });

  const liveRevision = liveTimelineDoc
    ? typeof liveTimelineDoc.revision === "number" &&
      Number.isInteger(liveTimelineDoc.revision) &&
      liveTimelineDoc.revision >= 1
      ? liveTimelineDoc.revision
      : 1
    : null;

  const hasCommitEvidence = Boolean(
    liveTimelineDoc &&
      liveTimelineDoc.lastExecutionId === executionId &&
      liveRevision === committedTimelineRevision
  );

  if (hasCommitEvidence) {
    const finalizedAt = new Date();
    const updatedReceipt: ExecutionReceipt = {
      ...doc.executionReceipt,
      status: "committed",
      committedAt: finalizedAt.toISOString(),
      operationsApplied: doc.editingPlan?.operations.length ?? 0
    };

    const finalDoc = await collection.findOneAndUpdate(
      { requestId: doc.requestId, status: "executing" },
      {
        $set: {
          status: "completed",
          "editingPlan.status": "applied",
          "approvalPlan.editingPlan.status": "applied",
          executionReceipt: updatedReceipt,
          updatedAt: finalizedAt,
          completedAt: finalizedAt,
          result: {
            summary: `Execution recovered and confirmed (committedTimelineRevision: ${liveRevision}).`,
            output: {
              executionId,
              committedTimelineRevision: liveRevision,
              recovered: true
            }
          }
        },
        $push: {
          events: {
            id: crypto.randomUUID(),
            timestamp: finalizedAt.toISOString(),
            type: "request_completed",
            message: `Execution finalized after crash recovery (executionId: ${executionId})`,
            data: { executionId, recovered: true }
          }
        }
      },
      { returnDocument: "after" }
    );

    return finalDoc ?? doc;
  } else {
    const failedAt = new Date();
    const isSuperseded = Boolean(
      liveTimelineDoc &&
        liveTimelineDoc.lastExecutionId === executionId &&
        liveRevision !== committedTimelineRevision
    );

    const failureError = isSuperseded
      ? `Execution cannot be recovered: timeline revision has advanced (current: ${liveRevision}, expected committed: ${committedTimelineRevision}).`
      : "Execution aborted due to uncommitted server crash or restart.";

    const failedReceipt: ExecutionReceipt = {
      ...doc.executionReceipt,
      status: "failed",
      error: failureError
    };

    const finalDoc = await collection.findOneAndUpdate(
      { requestId: doc.requestId, status: "executing" },
      {
        $set: {
          status: "failed",
          error: failureError,
          executionReceipt: failedReceipt,
          updatedAt: failedAt,
          completedAt: failedAt
        },
        $push: {
          events: {
            id: crypto.randomUUID(),
            timestamp: failedAt.toISOString(),
            type: "execution_failed",
            message: failureError,
            data: {
              executionId,
              reason: isSuperseded ? "EXECUTION_SUPERSEDED" : "EXECUTION_ABORTED_CRASH",
              ...(isSuperseded
                ? { committedTimelineRevision, currentTimelineRevision: liveRevision }
                : {})
            }
          }
        }
      },
      { returnDocument: "after" }
    );

    return finalDoc ?? doc;
  }
}

/**
 * Reconciles all requests left in 'executing' status upon server startup.
 */
export async function reconcileDanglingExecutions(): Promise<number> {
  const collection = getAgentRequestsCollection();
  const danglingDocs = await collection.find({ status: "executing" }).toArray();
  let count = 0;
  for (const doc of danglingDocs) {
    if (!activeControllers.has(doc.requestId)) {
      await reconcileExecutingRequest(doc);
      count++;
    }
  }
  return count;
}

/**
 * Retrieves an agent request by project ID and request ID.
 */
export async function getAgentRequestById(
  projectId: string,
  requestId: string
): Promise<AgentRequest | null> {
  const collection = getAgentRequestsCollection();
  const doc = await collection.findOne({ projectId, requestId });
  if (!doc) {
    return null;
  }
  // Reconcile if request was left in executing state without an active in-memory controller
  if (doc.status === "executing" && !activeControllers.has(requestId)) {
    const reconciled = await reconcileExecutingRequest(doc);
    return toAgentRequestDTO(reconciled);
  }
  return toAgentRequestDTO(doc);
}

/**
 * Retrieves the raw document by request ID.
 */
export async function getAgentRequestRawById(
  requestId: string
): Promise<AgentRequestDocument | null> {
  const collection = getAgentRequestsCollection();
  return collection.findOne({ requestId });
}

/**
 * Lists agent requests for a project with optional status filter and pagination.
 */
export async function listAgentRequestsByProject(
  projectId: string,
  options?: {
    status?: AgentRequestStatus;
    limit?: number;
    page?: number;
  }
): Promise<AgentRequest[]> {
  const collection = getAgentRequestsCollection();
  const filter: Record<string, unknown> = { projectId };

  if (options?.status) {
    filter.status = options.status;
  }

  const limit = Math.min(Math.max(1, options?.limit ?? 50), 100);
  const page = Math.max(1, options?.page ?? 1);
  const skip = (page - 1) * limit;

  const docs = await collection
    .find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const reconciledDocs = await Promise.all(
    docs.map(async (doc) => {
      if (doc.status === "executing" && !activeControllers.has(doc.requestId)) {
        return reconcileExecutingRequest(doc);
      }
      return doc;
    })
  );

  return reconciledDocs.map(toAgentRequestDTO);
}

/**
 * Atomically transitions an agent request's status while validating allowed lifecycle transitions.
 */
export async function transitionAgentRequestStatus(
  requestId: string,
  targetStatus: AgentRequestStatus,
  updates?: {
    iterations?: number;
    toolCallsCount?: number;
    events?: AgentEvent[];
    result?: AgentResult;
    approvalPlan?: AgentApprovalPlan;
    editingPlan?: AgentEditingPlan;
    executionReceipt?: ExecutionReceipt;
    error?: string;
  }
): Promise<AgentRequest> {
  const collection = getAgentRequestsCollection();
  const currentDoc = await collection.findOne({ requestId });
  if (!currentDoc) {
    throw new AgentNotFoundError(`Agent request '${requestId}' not found.`);
  }

  // Idempotent cancellation: if already canceled and target is canceled, return existing
  if (currentDoc.status === "canceled" && targetStatus === "canceled") {
    return toAgentRequestDTO(currentDoc);
  }

  if (!isValidAgentStatusTransition(currentDoc.status, targetStatus)) {
    throw new AgentStateTransitionError(currentDoc.status, targetStatus);
  }

  const now = new Date();
  const updateFields: Partial<AgentRequestDocument> = {
    status: targetStatus,
    updatedAt: now
  };

  if (targetStatus === "processing" && !currentDoc.startedAt) {
    updateFields.startedAt = now;
  }

  if (
    targetStatus === "completed" ||
    targetStatus === "failed" ||
    targetStatus === "canceled"
  ) {
    updateFields.completedAt = now;
  }

  if (typeof updates?.iterations === "number") {
    updateFields.iterations = updates.iterations;
  }
  if (typeof updates?.toolCallsCount === "number") {
    updateFields.toolCallsCount = updates.toolCallsCount;
  }
  if (updates?.events) {
    updateFields.events = updates.events;
  }
  if (updates?.result !== undefined) {
    updateFields.result = updates.result;
  }
  if (updates?.approvalPlan !== undefined) {
    updateFields.approvalPlan = updates.approvalPlan;
  }
  if (updates?.editingPlan !== undefined) {
    updateFields.editingPlan = updates.editingPlan;
  }
  if (updates?.executionReceipt !== undefined) {
    updateFields.executionReceipt = updates.executionReceipt;
  }
  if (updates?.error !== undefined) {
    updateFields.error = updates.error;
  }

  const result = await collection.findOneAndUpdate(
    { requestId, status: currentDoc.status },
    { $set: updateFields },
    { returnDocument: "after" }
  );

  if (!result) {
    // If findOneAndUpdate returned null, another transition happened concurrently
    const refreshed = await collection.findOne({ requestId });
    if (refreshed && refreshed.status === "canceled" && targetStatus === "canceled") {
      return toAgentRequestDTO(refreshed);
    }
    throw new AgentStateTransitionError(refreshed?.status ?? "unknown", targetStatus);
  }

  return toAgentRequestDTO(result);
}

/**
 * Cancels an active or queued agent request.
 */
export async function cancelAgentRequest(
  projectId: string,
  requestId: string
): Promise<AgentRequest> {
  if (!projectId || typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    throw new AgentValidationError("Invalid project ID format.");
  }
  if (!requestId || typeof requestId !== "string" || !requestId.trim()) {
    throw new AgentValidationError("Invalid request ID.");
  }

  const project = await getProjectById(projectId);
  if (!project) {
    throw new AgentNotFoundError("Project not found.");
  }

  const doc = await getAgentRequestRawById(requestId);
  if (!doc || doc.projectId !== projectId) {
    throw new AgentNotFoundError("Agent request not found for this project.");
  }

  if (doc.status === "completed" || doc.status === "failed") {
    throw new AgentValidationError(`Cannot cancel an agent request with status '${doc.status}'.`);
  }

  if (doc.status === "canceled") {
    return toAgentRequestDTO(doc);
  }

  // If request is actively executing, abort its controller
  const controller = activeControllers.get(requestId);
  if (controller) {
    controller.abort();
    activeControllers.delete(requestId);
  }

  const cancelEvent: AgentEvent = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: "request_canceled",
    message: "Agent request was canceled by user."
  };

  const updatedEvents = [...doc.events, cancelEvent];

  return transitionAgentRequestStatus(requestId, "canceled", {
    events: updatedEvents
  });
}

/**
 * Executes an agent request using the orchestrator and a plan provider.
 */
export async function executeAgentRequest(
  projectId: string,
  requestId: string,
  provider?: AgentPlanProvider,
  toolRegistry: AgentToolRegistry = defaultToolRegistry
): Promise<AgentRequest> {
  const doc = await getAgentRequestRawById(requestId);
  if (!doc || doc.projectId !== projectId) {
    throw new AgentNotFoundError("Agent request not found.");
  }

  if (doc.status === "completed" || doc.status === "failed" || doc.status === "canceled") {
    throw new AgentValidationError(
      `Cannot execute agent request with terminal status '${doc.status}'.`
    );
  }

  let resolvedProvider: AgentPlanProvider;
  try {
    resolvedProvider = provider ?? getActivePlanProvider();
  } catch (providerErr) {
    const provMsg = providerErr instanceof Error ? providerErr.message : String(providerErr);
    const failEvent: AgentEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: "request_failed",
      message: provMsg
    };
    return await transitionAgentRequestStatus(requestId, "failed", {
      error: provMsg,
      events: [...doc.events, failEvent]
    });
  }

  // Transition to processing
  await transitionAgentRequestStatus(requestId, "processing");

  const controller = new AbortController();
  activeControllers.set(requestId, controller);

  const context = new DefaultAgentExecutionContext({
    requestId,
    projectId,
    prompt: doc.prompt,
    limits: doc.limits,
    signal: controller.signal,
    existingEvents: doc.events,
    currentIteration: doc.iterations,
    toolCallCount: doc.toolCallsCount,
    startedAt: Date.now()
  });

  const orchestrator = new AgentRuntimeOrchestrator(toolRegistry);

  try {
    const executionResult = await orchestrator.execute(context, resolvedProvider);

    const latestDoc = await getAgentRequestRawById(requestId);
    if (latestDoc && latestDoc.status === "canceled" && executionResult.status === "canceled") {
      return toAgentRequestDTO(latestDoc);
    }

    const effectivePlan = executionResult.editingPlan ?? executionResult.approvalPlan?.editingPlan;
    let boundPlan: AgentEditingPlan | undefined = undefined;
    if (effectivePlan) {
      const liveTimeline = await getTimelineByProject(projectId);
      const targetTimelineRevision = liveTimeline?.revision ?? 1;
      const basePlan: AgentEditingPlan = {
        ...effectivePlan,
        targetTimelineRevision,
        status: "proposed"
      };
      const planHash = computePlanHash({
        requestId,
        projectId,
        planId: basePlan.id,
        targetTimelineRevision,
        operations: basePlan.operations
      });
      boundPlan = {
        ...basePlan,
        planHash
      };
    }

    const boundApprovalPlan = executionResult.approvalPlan
      ? {
          ...executionResult.approvalPlan,
          editingPlan: boundPlan
        }
      : undefined;

    return await transitionAgentRequestStatus(requestId, executionResult.status, {
      iterations: executionResult.iterations,
      toolCallsCount: executionResult.toolCallsCount,
      events: executionResult.events,
      result: executionResult.result,
      approvalPlan: boundApprovalPlan,
      editingPlan: boundPlan,
      error: executionResult.error
    });
  } finally {
    activeControllers.delete(requestId);
  }
}

export interface ApprovePlanInput {
  planHash: string;
  expectedTimelineRevision: number;
}

export interface ExecutionResultResponse {
  request: AgentRequest;
  timeline: Timeline;
  receipt: ExecutionReceipt;
}

async function markExecutionFailed(
  requestId: string,
  receipt: ExecutionReceipt,
  errorMessage: string
): Promise<void> {
  const collection = getAgentRequestsCollection();
  const failedAt = new Date();
  const failedReceipt: ExecutionReceipt = {
    ...receipt,
    status: "failed",
    error: errorMessage
  };

  await collection.updateOne(
    { requestId, status: "executing" },
    {
      $set: {
        status: "failed",
        error: errorMessage,
        executionReceipt: failedReceipt,
        updatedAt: failedAt,
        completedAt: failedAt
      },
      $push: {
        events: {
          id: crypto.randomUUID(),
          timestamp: failedAt.toISOString(),
          type: "execution_failed",
          message: errorMessage,
          data: { executionId: receipt.executionId, error: errorMessage }
        }
      }
    }
  );
}

/**
 * Explicit user approval endpoint handler:
 * 1. Validates plan hash integrity against canonical server calculation.
 * 2. Checks expected timeline revision against stored plan target.
 * 3. Atomically claims the request into 'executing' status to prevent race conditions.
 * 4. Executes operations sequentially using pure shared execution engine against in-memory working clone.
 * 5. Commits to MongoDB with CAS revision increment and records durable lastExecutionId commit evidence.
 * 6. Finalizes request to 'completed'.
 */
export async function approveAgentRequest(
  projectId: string,
  requestId: string,
  input: ApprovePlanInput
): Promise<ExecutionResultResponse> {
  if (!projectId || typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    throw new AgentValidationError("Invalid project ID format.");
  }
  if (!requestId || typeof requestId !== "string" || !requestId.trim()) {
    throw new AgentValidationError("Invalid request ID.");
  }
  if (!input || typeof input !== "object") {
    throw new AgentValidationError("Approval input must be an object.");
  }
  if (!input.planHash || typeof input.planHash !== "string" || !input.planHash.trim()) {
    throw new PlanHashMismatchError("planHash is required and must be a non-empty string.");
  }
  if (
    typeof input.expectedTimelineRevision !== "number" ||
    !Number.isInteger(input.expectedTimelineRevision) ||
    input.expectedTimelineRevision < 1
  ) {
    throw new StaleTimelineRevisionError({
      expectedRevision: 1,
      actualRevision: input.expectedTimelineRevision
    });
  }

  const project = await getProjectById(projectId);
  if (!project) {
    throw new AgentNotFoundError("Project not found.");
  }

  const collection = getAgentRequestsCollection();
  const doc = await collection.findOne({ requestId });
  if (!doc || doc.projectId !== projectId) {
    throw new AgentNotFoundError("Agent request not found for this project.");
  }

  // State checks
  if (doc.status === "executing") {
    throw new ExecutionAlreadyStartedError(doc.executionReceipt?.executionId);
  }
  if (doc.status === "completed") {
    throw new RequestNotApprovableError(doc.status, "Agent request is already completed and cannot be re-approved.");
  }
  if (doc.status !== "awaiting_approval") {
    throw new RequestNotApprovableError(doc.status, `Agent request has status '${doc.status}' and cannot be approved.`);
  }

  const plan = doc.editingPlan ?? doc.approvalPlan?.editingPlan;
  if (!plan || !Array.isArray(plan.operations) || plan.operations.length === 0) {
    throw new AgentValidationError("Agent request does not contain a valid editing plan to approve.");
  }
  if (plan.status !== "proposed") {
    throw new RequestNotApprovableError(plan.status, `Editing plan has status '${plan.status}' and cannot be approved.`);
  }

  // Canonical hash verification
  const targetRevision = plan.targetTimelineRevision ?? doc.executionReceipt?.targetTimelineRevision ?? 1;
  const canonicalHash = computePlanHash({
    requestId,
    projectId,
    planId: plan.id,
    targetTimelineRevision: targetRevision,
    operations: plan.operations
  });

  if (plan.planHash && plan.planHash !== canonicalHash) {
    throw new PlanHashMismatchError("Stored plan hash mismatch. The plan may have been tampered with.");
  }

  if (input.planHash.trim() !== canonicalHash) {
    throw new PlanHashMismatchError("Provided planHash does not match the canonical stored plan hash.");
  }

  if (input.expectedTimelineRevision !== targetRevision) {
    throw new StaleTimelineRevisionError({
      expectedRevision: targetRevision,
      actualRevision: input.expectedTimelineRevision
    });
  }

  // Atomic Claim: lock request into "executing" state
  const executionId = crypto.randomUUID();
  const claimTime = new Date();
  const claimReceipt: ExecutionReceipt = {
    executionId,
    targetTimelineRevision: targetRevision,
    committedTimelineRevision: targetRevision + 1,
    startedAt: claimTime.toISOString(),
    operationsApplied: 0,
    status: "executing"
  };

  const claimResult = await collection.findOneAndUpdate(
    {
      requestId,
      projectId,
      status: "awaiting_approval"
    },
    {
      $set: {
        status: "executing",
        executionReceipt: claimReceipt,
        updatedAt: claimTime
      },
      $push: {
        events: {
          id: crypto.randomUUID(),
          timestamp: claimTime.toISOString(),
          type: "execution_started",
          message: `Plan execution started (executionId: ${executionId})`,
          data: { executionId, targetTimelineRevision: targetRevision }
        }
      }
    },
    { returnDocument: "after" }
  );

  if (!claimResult) {
    // Another concurrent approval won the race or state changed
    const fresh = await collection.findOne({ requestId });
    if (fresh?.status === "executing") {
      throw new ExecutionAlreadyStartedError(fresh.executionReceipt?.executionId);
    }
    throw new RequestNotApprovableError(fresh?.status ?? "unknown");
  }

  const abortController = new AbortController();
  activeControllers.set(requestId, abortController);

  try {
    // 1. Fetch live timeline
    const liveTimeline = await getTimelineByProject(projectId);
    if (!liveTimeline) {
      await markExecutionFailed(requestId, claimReceipt, "Timeline not found for project.");
      throw new TimelineNotFoundError(projectId);
    }

    const currentLiveRevision = liveTimeline.revision ?? 1;
    if (currentLiveRevision !== targetRevision) {
      const err = new StaleTimelineRevisionError({
        expectedRevision: targetRevision,
        actualRevision: currentLiveRevision
      });
      await markExecutionFailed(requestId, claimReceipt, err.message);
      throw err;
    }

    // 2. Pure sequential execution on working clone
    const assets = await getMediaAssetsByProject(projectId);
    const execResult = executeEditingPlan(liveTimeline, plan, { assets });
    if (!execResult.success) {
      const err = new ExecutionValidationFailedError(execResult.error);
      await markExecutionFailed(requestId, claimReceipt, err.message);
      throw err;
    }

    // 3. Commit modified timeline to MongoDB with CAS revision increment and execution evidence
    let committedTimeline: Timeline;
    try {
      committedTimeline = await saveTimelineCAS(
        projectId,
        {
          tracks: execResult.timeline.tracks,
          settings: execResult.timeline.settings
        },
        {
          expectedRevision: targetRevision,
          lastExecutionId: executionId
        }
      );
    } catch (casErr) {
      const casMsg = casErr instanceof Error ? casErr.message : String(casErr);
      await markExecutionFailed(requestId, claimReceipt, `Timeline CAS commit failed: ${casMsg}`);
      throw casErr;
    }

    // 4. Finalize request document
    const finalizedAt = new Date();
    const completedReceipt: ExecutionReceipt = {
      ...claimReceipt,
      committedTimelineRevision: committedTimeline.revision ?? (targetRevision + 1),
      committedAt: finalizedAt.toISOString(),
      operationsApplied: plan.operations.length,
      status: "committed"
    };

    const finalDoc = await collection.findOneAndUpdate(
      { requestId, status: "executing" },
      {
        $set: {
          status: "completed",
          "editingPlan.status": "applied",
          "approvalPlan.editingPlan.status": "applied",
          executionReceipt: completedReceipt,
          updatedAt: finalizedAt,
          completedAt: finalizedAt,
          result: {
            summary: `Successfully executed editing plan (${plan.operations.length} operations applied).`,
            output: {
              executionId,
              committedTimelineRevision: completedReceipt.committedTimelineRevision
            }
          }
        },
        $push: {
          events: {
            id: crypto.randomUUID(),
            timestamp: finalizedAt.toISOString(),
            type: "request_completed",
            message: `Plan execution completed successfully (${plan.operations.length} operations applied)`,
            data: {
              executionId,
              committedTimelineRevision: completedReceipt.committedTimelineRevision
            }
          }
        }
      },
      { returnDocument: "after" }
    );

    return {
      request: toAgentRequestDTO(finalDoc ?? claimResult),
      timeline: committedTimeline,
      receipt: completedReceipt
    };
  } finally {
    activeControllers.delete(requestId);
  }
}

/**
 * Rejection endpoint handler:
 * Transitions request from awaiting_approval to canceled, marks editingPlan as rejected,
 * and records approval_rejected event.
 */
export async function rejectAgentRequest(
  projectId: string,
  requestId: string,
  reason?: string
): Promise<AgentRequest> {
  if (!projectId || typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    throw new AgentValidationError("Invalid project ID format.");
  }
  if (!requestId || typeof requestId !== "string" || !requestId.trim()) {
    throw new AgentValidationError("Invalid request ID.");
  }

  const project = await getProjectById(projectId);
  if (!project) {
    throw new AgentNotFoundError("Project not found.");
  }

  const collection = getAgentRequestsCollection();
  const doc = await collection.findOne({ requestId });
  if (!doc || doc.projectId !== projectId) {
    throw new AgentNotFoundError("Agent request not found for this project.");
  }

  if (doc.status !== "awaiting_approval") {
    throw new RequestNotApprovableError(
      doc.status,
      `Agent request has status '${doc.status}' and cannot be rejected. Expected 'awaiting_approval'.`
    );
  }

  const now = new Date();
  const rejectEvent: AgentEvent = {
    id: crypto.randomUUID(),
    timestamp: now.toISOString(),
    type: "approval_rejected",
    message: reason ? `Plan rejected by user: ${reason}` : "Plan approval was rejected by user.",
    data: reason ? { reason } : undefined
  };

  const result = await collection.findOneAndUpdate(
    { requestId, status: "awaiting_approval" },
    {
      $set: {
        status: "canceled",
        "editingPlan.status": "rejected",
        "approvalPlan.editingPlan.status": "rejected",
        updatedAt: now,
        completedAt: now
      },
      $push: {
        events: rejectEvent
      }
    },
    { returnDocument: "after" }
  );

  if (!result) {
    const fresh = await collection.findOne({ requestId });
    throw new RequestNotApprovableError(fresh?.status ?? "unknown");
  }

  return toAgentRequestDTO(result);
}

/**
 * Deletes all agent request documents for a given project from MongoDB.
 */
export async function deleteAgentRequestsByProject(projectId: string): Promise<number> {
  const collection = getAgentRequestsCollection();
  const result = await collection.deleteMany({ projectId });
  return result.deletedCount;
}

/**
 * Graceful shutdown hook: aborts any active agent executions.
 */
export function registerAgentShutdownHooks(): void {
  const cleanup = () => {
    for (const [requestId, controller] of activeControllers.entries()) {
      try {
        controller.abort();
      } catch (err) {
        console.error(`[AgentRuntime] Error aborting request ${requestId}:`, err);
      }
    }
    activeControllers.clear();
  };

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}
