export const AGENTCUT_VERSION = "0.0.1";

export interface HealthStatus {
  status: "ok" | "error";
  timestamp: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectDTO {
  name: string;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}
