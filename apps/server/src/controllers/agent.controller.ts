import { Request, Response } from "express";
import { ObjectId } from "mongodb";
import type { AgentRequestStatus } from "@agentcut/shared";
import { getProjectById } from "../services/project.service.js";
import {
  createAgentRequest,
  getAgentRequestById,
  listAgentRequestsByProject,
  cancelAgentRequest,
  executeAgentRequest,
  approveAgentRequest,
  rejectAgentRequest
} from "../services/agent/agent-request.service.js";
import {
  AgentValidationError,
  AgentNotFoundError,
  PlanHashMismatchError,
  StaleTimelineRevisionError,
  RequestNotApprovableError,
  ExecutionAlreadyStartedError,
  ExecutionValidationFailedError,
  ExecutionAbortedCrashError
} from "../services/agent/agent-errors.js";
import { TimelineConcurrencyError, TimelineNotFoundError } from "../services/timeline.service.js";
import { GeminiConfigurationError } from "../config/gemini.config.js";

export async function createAgentRequestHandler(req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  try {
    const project = await getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const request = await createAgentRequest(projectId, req.body);

    if (req.query.execute === "sync" || req.body?.execute === true) {
      try {
        const executed = await executeAgentRequest(projectId, request.id);
        res.status(201).json({ data: executed });
        return;
      } catch (execErr) {
        if (execErr instanceof GeminiConfigurationError) {
          res.status(400).json({ error: execErr.message });
          return;
        }
        throw execErr;
      }
    } else if (req.body?.autoExecute !== false) {
      queueMicrotask(() => {
        executeAgentRequest(projectId, request.id).catch((err) => {
          console.error(`[AgentRequestService] Background execution error for ${request.id}:`, err);
        });
      });
    }

    res.status(201).json({ data: request });
  } catch (err) {
    if (err instanceof AgentValidationError || err instanceof GeminiConfigurationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof AgentNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("[AgentController] createAgentRequest error:", err);
    res.status(500).json({ error: "Failed to create agent request." });
  }
}

export async function getAgentRequestHandler(req: Request, res: Response): Promise<void> {
  const { projectId, requestId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  if (typeof requestId !== "string" || !requestId.trim()) {
    res.status(400).json({ error: "Invalid request ID." });
    return;
  }

  try {
    const project = await getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const request = await getAgentRequestById(projectId, requestId.trim());
    if (!request) {
      res.status(404).json({ error: "Agent request not found." });
      return;
    }

    res.status(200).json({ data: request });
  } catch (err) {
    console.error("[AgentController] getAgentRequest error:", err);
    res.status(500).json({ error: "Failed to fetch agent request." });
  }
}

export async function listAgentRequestsHandler(req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  try {
    const project = await getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const statusQuery = typeof req.query.status === "string" ? req.query.status.trim() : undefined;
    const limitQuery = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
    const pageQuery = typeof req.query.page === "string" ? parseInt(req.query.page, 10) : undefined;

    const requests = await listAgentRequestsByProject(projectId, {
      status: statusQuery as AgentRequestStatus | undefined,
      limit: Number.isFinite(limitQuery) ? limitQuery : undefined,
      page: Number.isFinite(pageQuery) ? pageQuery : undefined
    });

    res.status(200).json({ data: requests });
  } catch (err) {
    console.error("[AgentController] listAgentRequests error:", err);
    res.status(500).json({ error: "Failed to list agent requests." });
  }
}

export async function cancelAgentRequestHandler(req: Request, res: Response): Promise<void> {
  const { projectId, requestId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  if (typeof requestId !== "string" || !requestId.trim()) {
    res.status(400).json({ error: "Invalid request ID." });
    return;
  }

  try {
    const request = await cancelAgentRequest(projectId, requestId.trim());
    res.status(200).json({ data: request });
  } catch (err) {
    if (err instanceof AgentValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof AgentNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("[AgentController] cancelAgentRequest error:", err);
    res.status(500).json({ error: "Failed to cancel agent request." });
  }
}

export async function approveAgentRequestHandler(req: Request, res: Response): Promise<void> {
  const { projectId, requestId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  if (typeof requestId !== "string" || !requestId.trim()) {
    res.status(400).json({ error: "Invalid request ID." });
    return;
  }

  const { planHash, expectedTimelineRevision } = req.body || {};

  if (!planHash || typeof planHash !== "string" || !planHash.trim()) {
    res.status(400).json({
      error: "planHash is required and must be a non-empty string.",
      code: "PLAN_HASH_MISMATCH"
    });
    return;
  }

  if (
    typeof expectedTimelineRevision !== "number" ||
    !Number.isInteger(expectedTimelineRevision) ||
    expectedTimelineRevision < 1
  ) {
    res.status(400).json({
      error: "expectedTimelineRevision must be a positive integer >= 1.",
      code: "STALE_TIMELINE_REVISION"
    });
    return;
  }

  try {
    const result = await approveAgentRequest(projectId, requestId.trim(), {
      planHash: planHash.trim(),
      expectedTimelineRevision
    });

    res.status(200).json({ data: result });
  } catch (err) {
    if (err instanceof PlanHashMismatchError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof StaleTimelineRevisionError || err instanceof TimelineConcurrencyError) {
      res.status(409).json({
        error: err.message,
        code: err.code,
        details: err.details
      });
      return;
    }
    if (err instanceof RequestNotApprovableError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ExecutionAlreadyStartedError) {
      res.status(409).json({
        error: err.message,
        code: err.code,
        executionId: err.executionId
      });
      return;
    }
    if (err instanceof ExecutionValidationFailedError) {
      res.status(422).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof AgentValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof AgentNotFoundError || err instanceof TimelineNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("[AgentController] approveAgentRequest error:", err);
    res.status(500).json({ error: "Failed to approve agent request." });
  }
}

export async function rejectAgentRequestHandler(req: Request, res: Response): Promise<void> {
  const { projectId, requestId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  if (typeof requestId !== "string" || !requestId.trim()) {
    res.status(400).json({ error: "Invalid request ID." });
    return;
  }

  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : undefined;
    const result = await rejectAgentRequest(projectId, requestId.trim(), reason);
    res.status(200).json({ data: result });
  } catch (err) {
    if (err instanceof RequestNotApprovableError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof AgentValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof AgentNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("[AgentController] rejectAgentRequest error:", err);
    res.status(500).json({ error: "Failed to reject agent request." });
  }
}

