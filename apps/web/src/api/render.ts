import type {
  RenderPlan,
  RenderPlanValidationResult,
  RenderJob,
  CreateRenderJobDTO,
  Timeline,
  ApiResponse
} from "@agentcut/shared";

const API_PREFIX = typeof window !== "undefined" ? "" : "http://localhost:3000";

export interface ValidateRenderPlanResponse {
  plan: RenderPlan;
  validation: RenderPlanValidationResult;
}

/**
 * Validates a render plan against project assets on the backend.
 * Optionally passes an unsaved in-memory timeline state to preview validation.
 */
export async function validateRenderPlanApi(
  projectId: string,
  timeline?: Timeline
): Promise<ValidateRenderPlanResponse> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/render/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(timeline ? { timeline } : {})
  });

  const json: ApiResponse<ValidateRenderPlanResponse> = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || `Failed to validate render plan (HTTP ${res.status})`);
  }

  if (!json.data) {
    throw new Error("Invalid response from render validation endpoint.");
  }

  return json.data;
}

/**
 * Requests the backend to enqueue a new render job for the project's saved timeline.
 */
export async function createRenderJobApi(
  projectId: string,
  dto?: CreateRenderJobDTO
): Promise<RenderJob> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/render/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dto || {})
  });

  const json: ApiResponse<RenderJob> = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || `Failed to create render job (HTTP ${res.status})`);
  }

  if (!json.data) {
    throw new Error("Invalid response from render job creation endpoint.");
  }

  return json.data;
}

/**
 * Retrieves the status and metadata of a render job.
 */
export async function getRenderJobApi(
  projectId: string,
  jobId: string
): Promise<RenderJob> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/render/jobs/${jobId}`);
  const json: ApiResponse<RenderJob> = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(json.error || `Failed to fetch render job (HTTP ${res.status})`);
  }

  if (!json.data) {
    throw new Error("Render job data not found.");
  }

  return json.data;
}

/**
 * Lists all render jobs for a project.
 */
export async function listRenderJobsApi(projectId: string): Promise<RenderJob[]> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/render/jobs`);
  const json: ApiResponse<RenderJob[]> = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(json.error || `Failed to list render jobs (HTTP ${res.status})`);
  }

  return json.data || [];
}

/**
 * Cancels a queued or validating render job.
 */
export async function cancelRenderJobApi(
  projectId: string,
  jobId: string
): Promise<RenderJob> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/render/jobs/${jobId}/cancel`, {
    method: "POST"
  });

  const json: ApiResponse<RenderJob> = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || `Failed to cancel render job (HTTP ${res.status})`);
  }

  if (!json.data) {
    throw new Error("Render job cancellation response missing.");
  }

  return json.data;
}

