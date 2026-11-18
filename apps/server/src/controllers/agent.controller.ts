import { Request, Response } from "express";
import { ObjectId } from "mongodb";
import type { AgentRequestStatus } from "@agentcut/shared";
import { getProjectById } from "../services/project.service.js";
import {
  createAgentRequest,
  getAgentRequestById,
  listAgentRequestsByProject,
  cancelAgentRequest,
  executeAgentRequest
} from "../services/agent/agent-request.service.js";
import {
  AgentValidationError,
  AgentNotFoundError
} from "../services/agent/agent-errors.js";
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

