import type { AgentTool } from "../agent-tools.js";
import type { AgentExecutionContext } from "../agent-context.js";
import { getMediaAssetById } from "../../media.service.js";
import { searchAssetScenes, SearchError } from "../../media-index.service.js";
import { AgentValidationError, AgentNotFoundError } from "../agent-errors.js";

export interface SearchScenesInput {
  assetId: string;
  limit?: number;
}

export interface SceneInfo {
  sceneNumber: number;
  start: number;
  end: number;
  duration: number;
  frameUrl: string;
}

export interface SearchScenesOutput {
  status: "completed" | "unavailable";
  totalScenes: number;
  scenes: SceneInfo[];
  message?: string;
}

export const searchScenesTool: AgentTool<SearchScenesInput, SearchScenesOutput> = {
  name: "search_scenes",
  description: "Retrieve detected scene change boundaries and representative frame references for a video asset.",
  validate(input: unknown): SearchScenesInput {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AgentValidationError("search_scenes input must be an object with an 'assetId' string.");
    }
    const raw = input as Record<string, unknown>;
    if (typeof raw.assetId !== "string" || !raw.assetId.trim()) {
      throw new AgentValidationError("assetId is required and must be a non-empty string.");
    }
    const assetId = raw.assetId.trim();

    let limit = 50;
    if (raw.limit !== undefined) {
      if (typeof raw.limit !== "number" || !Number.isFinite(raw.limit) || raw.limit < 1) {
        throw new AgentValidationError("limit must be a positive integer.");
      }
      limit = Math.min(Math.floor(raw.limit), 100);
    }

    return { assetId, limit };
  },
  async execute(input: SearchScenesInput, context: AgentExecutionContext): Promise<SearchScenesOutput> {
    context.checkCancellation();
    const asset = await getMediaAssetById(context.projectId, input.assetId);
    if (!asset) {
      throw new AgentNotFoundError(`Media asset '${input.assetId}' not found in project '${context.projectId}'.`);
    }

    try {
      const res = await searchAssetScenes(context.projectId, input.assetId, {
        limit: input.limit
      });

      return {
        status: "completed",
        totalScenes: res.totalMatches,
        scenes: res.matches.map((s: any) => ({
          sceneNumber: s.sceneIndex ?? 0,
          start: s.start,
          end: s.end,
          duration: s.duration,
          frameUrl: s.frameUrl || `/api/projects/${context.projectId}/media/${input.assetId}/scenes/frames/${s.sceneIndex ?? 0}`
        }))
      };
    } catch (err) {
      if (err instanceof SearchError) {
        return {
          status: "unavailable",
          totalScenes: 0,
          scenes: [],
          message: err.message
        };
      }
      throw err;
    }
  }
};
