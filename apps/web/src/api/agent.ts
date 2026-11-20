import type {
  AgentRequest,
  AgentRequestStatus,
  ApiResponse,
  CreateAgentRequestDTO,
  ExecutionReceipt,
  Timeline
} from "@agentcut/shared";

const API_PREFIX = typeof window !== "undefined" ? "" : "http://localhost:3000";

export interface ApproveAgentRequestPayload {
  planHash: string;
  expectedTimelineRevision: number;
}

export interface ApproveAgentRequestResponse {
  request: AgentRequest;
  timeline: Timeline;
  receipt: ExecutionReceipt;
}

export interface AgentApiError extends Error {
  code?: string;
  details?: Record<string, unknown>;
  status?: number;
}

function createApiError(message: string, status?: number, code?: string, details?: Record<string, unknown>): AgentApiError {
  const error = new Error(message) as AgentApiError;
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

/**
 * Creates a new agent editing instruction request for a project.
 */
export async function createAgentRequestApi(
  projectId: string,
  dto: CreateAgentRequestDTO
): Promise<AgentRequest> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/agent/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dto)
  });

  const json: ApiResponse<AgentRequest> & { code?: string; details?: Record<string, unknown> } =
    await res.json().catch(() => ({}));

  if (!res.ok) {
    throw createApiError(json.error || `Failed to create agent request (HTTP ${res.status})`, res.status, json.code, json.details);
  }

  if (!json.data) {
    throw createApiError("Server response missing agent request data.", res.status);
  }

  return json.data;
}

/**
 * Fetches an agent request by ID.
 */
export async function getAgentRequestApi(
  projectId: string,
  requestId: string
): Promise<AgentRequest> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/agent/requests/${requestId}`);

  const json: ApiResponse<AgentRequest> & { code?: string; details?: Record<string, unknown> } =
    await res.json().catch(() => ({}));

  if (!res.ok) {
    throw createApiError(json.error || `Failed to fetch agent request (HTTP ${res.status})`, res.status, json.code, json.details);
  }

  if (!json.data) {
    throw createApiError("Server response missing agent request data.", res.status);
  }

  return json.data;
}

/**
 * Lists agent requests for a project with optional status filter.
 */
export async function listAgentRequestsApi(
  projectId: string,
  options?: { status?: AgentRequestStatus; limit?: number; page?: number }
): Promise<AgentRequest[]> {
  const params = new URLSearchParams();
  if (options?.status) params.set("status", options.status);
  if (options?.limit) params.set("limit", options.limit.toString());
  if (options?.page) params.set("page", options.page.toString());

  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/agent/requests${query}`);

  const json: ApiResponse<AgentRequest[]> & { code?: string } =
    await res.json().catch(() => ({}));

  if (!res.ok) {
    throw createApiError(json.error || `Failed to list agent requests (HTTP ${res.status})`, res.status, json.code);
  }

  return json.data || [];
}

/**
 * Submits explicit approval for an agent editing plan to execute against the live timeline.
 * Strict CAS concurrency protection: requires matching planHash and expectedTimelineRevision.
 */
export async function approveAgentRequestApi(
  projectId: string,
  requestId: string,
  payload: ApproveAgentRequestPayload
): Promise<ApproveAgentRequestResponse> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/agent/requests/${requestId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const json: ApiResponse<ApproveAgentRequestResponse> & { code?: string; details?: Record<string, unknown> } =
    await res.json().catch(() => ({}));

  if (!res.ok) {
    throw createApiError(
      json.error || `Failed to approve agent request (HTTP ${res.status})`,
      res.status,
      json.code,
      json.details
    );
  }

  if (!json.data || !json.data.timeline || !json.data.receipt) {
    throw createApiError("Server response missing approval execution data.", res.status);
  }

  return json.data;
}

/**
 * Rejects a proposed agent editing plan.
 */
export async function rejectAgentRequestApi(
  projectId: string,
  requestId: string,
  reason?: string
): Promise<AgentRequest> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/agent/requests/${requestId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });

  const json: ApiResponse<AgentRequest> & { code?: string; details?: Record<string, unknown> } =
    await res.json().catch(() => ({}));

  if (!res.ok) {
    throw createApiError(json.error || `Failed to reject agent request (HTTP ${res.status})`, res.status, json.code, json.details);
  }

  if (!json.data) {
    throw createApiError("Server response missing agent request data.", res.status);
  }

  return json.data;
}

/**
 * Cancels an in-flight or queued agent request.
 */
export async function cancelAgentRequestApi(
  projectId: string,
  requestId: string
): Promise<AgentRequest> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/agent/requests/${requestId}/cancel`, {
    method: "POST"
  });

  const json: ApiResponse<AgentRequest> = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw createApiError(json.error || `Failed to cancel agent request (HTTP ${res.status})`, res.status);
  }

  if (!json.data) {
    throw createApiError("Server response missing agent request data.", res.status);
  }

  return json.data;
}

