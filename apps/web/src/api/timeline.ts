import type { Timeline, ApiResponse } from "@agentcut/shared";

const API_PREFIX = typeof window !== "undefined" ? "" : "http://localhost:3000";

/**
 * Fetches the saved timeline for a project.
 * If the project has no saved timeline yet (HTTP 404 with "Timeline not found"),
 * returns null so the UI can render an empty timeline state.
 */
export async function fetchProjectTimeline(projectId: string): Promise<Timeline | null> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/timeline`);

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

/**
 * Persists an updated timeline for a project via PUT /api/projects/:projectId/timeline.
 * Preserves stable timeline ID and sends complete tracks and settings.
 */
export async function saveProjectTimeline(
  projectId: string,
  timeline: Timeline
): Promise<Timeline> {
  const res = await fetch(`${API_PREFIX}/api/projects/${projectId}/timeline`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: timeline.id,
      projectId,
      tracks: timeline.tracks,
      settings: timeline.settings
    })
  });

  const json: ApiResponse<Timeline> = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(json.error || `Failed to save timeline (HTTP ${res.status})`);
  }

  if (!json.data) {
    throw new Error("Timeline save response missing data.");
  }

  return json.data;
}

