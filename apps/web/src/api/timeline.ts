import type { Timeline, ApiResponse } from "@agentcut/shared";

/**
 * Fetches the saved timeline for a project.
 * If the project has no saved timeline yet (HTTP 404 with "Timeline not found"),
 * returns null so the UI can render an empty timeline state.
 */
export async function fetchProjectTimeline(projectId: string): Promise<Timeline | null> {
  const res = await fetch(`/api/projects/${projectId}/timeline`);

  if (res.status === 404) {
    const json: ApiResponse<never> = await res.json().catch(() => ({}));
    if (json.error?.toLowerCase().includes("timeline not found")) {
      return null;
    }
    // If the project itself is not found
    throw new Error(json.error || "Project not found.");
  }

  const json: ApiResponse<Timeline> = await res.json();

  if (!res.ok) {
    throw new Error(json.error || `Failed to fetch timeline (HTTP ${res.status})`);
  }

  return json.data || null;
}

