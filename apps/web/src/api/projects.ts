import type { Project, ApiResponse } from "@agentcut/shared";

const API_BASE = "/api/projects";

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(API_BASE);
  const json: ApiResponse<Project[]> = await res.json();

  if (!res.ok) {
    throw new Error(json.error || `Failed to fetch projects (HTTP ${res.status})`);
  }

  return json.data || [];
}

export async function fetchProjectById(id: string): Promise<Project> {
  const res = await fetch(`${API_BASE}/${id}`);
  const json: ApiResponse<Project> = await res.json();

  if (!res.ok) {
    throw new Error(json.error || `Failed to fetch project (HTTP ${res.status})`);
  }

  if (!json.data) {
    throw new Error("Project data missing in response");
  }

  return json.data;
}

export async function createProjectApi(name: string): Promise<Project> {
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });

  const json: ApiResponse<Project> = await res.json();

  if (!res.ok) {
    throw new Error(json.error || `Failed to create project (HTTP ${res.status})`);
  }

  if (!json.data) {
    throw new Error("Project creation returned no data");
  }

  return json.data;
}

export async function deleteProjectApi(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/${id}`, {
    method: "DELETE"
  });

  const json: ApiResponse<unknown> = await res.json();

  if (!res.ok) {
    throw new Error(json.error || `Failed to delete project (HTTP ${res.status})`);
  }
}

