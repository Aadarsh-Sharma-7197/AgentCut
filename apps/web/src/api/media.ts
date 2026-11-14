import type { MediaAsset, ApiResponse } from "@agentcut/shared";

export async function fetchMediaAssets(projectId: string): Promise<MediaAsset[]> {
  const res = await fetch(`/api/projects/${projectId}/media`);
  const json: ApiResponse<MediaAsset[]> = await res.json();

  if (!res.ok) {
    throw new Error(json.error || `Failed to fetch media assets (HTTP ${res.status})`);
  }

  return json.data || [];
}

export async function uploadMediaAsset(projectId: string, file: File): Promise<MediaAsset> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`/api/projects/${projectId}/media`, {
    method: "POST",
    body: formData
  });

  const json: ApiResponse<MediaAsset> = await res.json();

  if (!res.ok) {
    throw new Error(json.error || `Failed to upload video (HTTP ${res.status})`);
  }

  if (!json.data) {
    throw new Error("Upload succeeded but no media asset was returned.");
  }

  return json.data;
}

export function getMediaStreamUrl(projectId: string, assetId: string): string {
  return `/api/projects/${projectId}/media/${assetId}/stream`;
}

