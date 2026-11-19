import type { AgentTool } from "../agent-tools.js";
import type { AgentExecutionContext } from "../agent-context.js";
import { getMediaAssetsByProject } from "../../media.service.js";
import { AgentValidationError } from "../agent-errors.js";

export interface ListAssetsInput {
  limit?: number;
}

export interface CompactAssetInfo {
  assetId: string;
  fileName: string;
  duration: number;
  width?: number;
  height?: number;
  frameRate?: string;
  videoCodec?: string;
  audioCodec?: string;
  hasAudioStream?: boolean;
}

export interface ListAssetsOutput {
  totalAssets: number;
  assets: CompactAssetInfo[];
}

export const listProjectAssetsTool: AgentTool<ListAssetsInput, ListAssetsOutput> = {
  name: "list_project_assets",
  description: "List all media assets belonging to this project with their duration, dimensions, codecs, and stream info.",
  validate(input: unknown): ListAssetsInput {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { limit: 20 };
    }
    const raw = input as Record<string, unknown>;
    let limit = 20;
    if (raw.limit !== undefined) {
      if (typeof raw.limit !== "number" || !Number.isFinite(raw.limit) || raw.limit < 1) {
        throw new AgentValidationError("limit must be a positive integer.");
      }
      limit = Math.min(Math.floor(raw.limit), 100);
    }
    return { limit };
  },
  async execute(input: ListAssetsInput, context: AgentExecutionContext): Promise<ListAssetsOutput> {
    context.checkCancellation();
    const rawAssets = await getMediaAssetsByProject(context.projectId);
    const limit = input.limit ?? 20;
    const assets: CompactAssetInfo[] = rawAssets.slice(0, limit).map((a) => ({
      assetId: a.id,
      fileName: a.originalName,
      duration: a.duration,
      width: a.width,
      height: a.height,
      frameRate: a.frameRate,
      videoCodec: a.videoCodec,
      audioCodec: a.audioCodec || undefined,
      hasAudioStream: Boolean(a.audioCodec)
    }));

    return {
      totalAssets: rawAssets.length,
      assets
    };
  }
};
