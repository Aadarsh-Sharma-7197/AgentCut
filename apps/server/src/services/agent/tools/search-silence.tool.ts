import type { AgentTool } from "../agent-tools.js";
import type { AgentExecutionContext } from "../agent-context.js";
import { getMediaAssetById } from "../../media.service.js";
import { searchAssetSilence, SearchError } from "../../media-index.service.js";
import { AgentValidationError, AgentNotFoundError } from "../agent-errors.js";

export interface SearchSilenceInput {
  assetId: string;
  limit?: number;
}

export interface SilenceIntervalInfo {
  start: number;
  end: number;
  duration: number;
}

export interface SearchSilenceOutput {
  status: "completed" | "unavailable";
  totalIntervals: number;
  totalSilenceDuration: number;
  intervals: SilenceIntervalInfo[];
  message?: string;
}

export const searchSilenceTool: AgentTool<SearchSilenceInput, SearchSilenceOutput> = {
  name: "search_silence",
  description: "Retrieve detected silence intervals for a media asset to identify pauses.",
  validate(input: unknown): SearchSilenceInput {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AgentValidationError("search_silence input must be an object with an 'assetId' string.");
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
  async execute(input: SearchSilenceInput, context: AgentExecutionContext): Promise<SearchSilenceOutput> {
    context.checkCancellation();
    const asset = await getMediaAssetById(context.projectId, input.assetId);
    if (!asset) {
      throw new AgentNotFoundError(`Media asset '${input.assetId}' not found in project '${context.projectId}'.`);
    }

    try {
      const res = await searchAssetSilence(context.projectId, input.assetId, {
        limit: input.limit
      });

      const totalDuration = res.matches.reduce((acc: number, m: any) => acc + (m.duration || 0), 0);

      return {
        status: "completed",
        totalIntervals: res.totalMatches,
        totalSilenceDuration: Number(totalDuration.toFixed(3)),
        intervals: res.matches.map((i: any) => ({
          start: i.start,
          end: i.end,
          duration: i.duration
        }))
      };
    } catch (err) {
      if (err instanceof SearchError) {
        return {
          status: "unavailable",
          totalIntervals: 0,
          totalSilenceDuration: 0,
          intervals: [],
          message: err.message
        };
      }
      throw err;
    }
  }
};
