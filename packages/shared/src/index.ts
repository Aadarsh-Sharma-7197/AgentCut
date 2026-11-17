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

export interface MediaAsset {
  id: string;
  projectId: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  duration: number;
  width: number;
  height: number;
  frameRate: string;
  videoCodec: string;
  audioCodec: string | null;
  format: string;
  createdAt: string;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

export * from "./timeline/index.js";
export * from "./render/index.js";
export * from "./analysis/index.js";
export * from "./agent/index.js";
