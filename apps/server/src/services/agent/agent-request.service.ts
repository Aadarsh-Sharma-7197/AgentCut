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
  AgentStateTransitionError
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

  return docs.map(toAgentRequestDTO);
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
    updateFields.editingPlan = updates.editingPlan
      ? {
          ...updates.editingPlan,
          status: "proposed"
        }
      : undefined;
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
    return await transitionAgentRequestStatus(requestId, executionResult.status, {
      iterations: executionResult.iterations,
      toolCallsCount: executionResult.toolCallsCount,
      events: executionResult.events,
      result: executionResult.result,
      approvalPlan: executionResult.approvalPlan,
      editingPlan: effectivePlan ? { ...effectivePlan, status: "proposed" } : undefined,
      error: executionResult.error
    });
  } finally {
    activeControllers.delete(requestId);
  }
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
