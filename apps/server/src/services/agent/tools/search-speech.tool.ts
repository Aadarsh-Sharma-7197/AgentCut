import type { AgentTool } from "../agent-tools.js";
import type { AgentExecutionContext } from "../agent-context.js";
import { getMediaAssetById } from "../../media.service.js";
import { searchAssetSpeech, searchProjectIntelligence, SearchError } from "../../media-index.service.js";
import { AgentValidationError, AgentNotFoundError } from "../agent-errors.js";

export interface SearchSpeechInput {
  query: string;
  assetId?: string;
  limit?: number;
}

export interface SpeechMatchInfo {
  assetId?: string;
  matchedText: string;
  start: number;
  end: number;
  duration: number;
  segmentIds: number[];
  words: Array<{ word: string; start: number; end: number }>;
}

export interface SearchSpeechOutput {
  status: "completed" | "unavailable";
  totalMatches: number;
  matches: SpeechMatchInfo[];
  message?: string;
}

export const searchSpeechTool: AgentTool<SearchSpeechInput, SearchSpeechOutput> = {
  name: "search_speech",
  description: "Search spoken speech transcripts for a keyword or phrase across media assets.",
  validate(input: unknown): SearchSpeechInput {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AgentValidationError("search_speech input must be an object with a 'query' string.");
    }
    const raw = input as Record<string, unknown>;
    if (typeof raw.query !== "string" || !raw.query.trim()) {
      throw new AgentValidationError("query parameter is required and cannot be empty.");
    }
    const query = raw.query.trim();
    if (query.length > 100) {
      throw new AgentValidationError("query parameter exceeds maximum length of 100 characters.");
    }

    let assetId: string | undefined = undefined;
    if (raw.assetId !== undefined) {
      if (typeof raw.assetId !== "string" || !raw.assetId.trim()) {
        throw new AgentValidationError("assetId must be a non-empty string when provided.");
      }
      assetId = raw.assetId.trim();
    }

    let limit = 20;
    if (raw.limit !== undefined) {
      if (typeof raw.limit !== "number" || !Number.isFinite(raw.limit) || raw.limit < 1) {
        throw new AgentValidationError("limit must be a positive number.");
      }
      limit = Math.min(Math.floor(raw.limit), 50);
    }

    return { query, assetId, limit };
  },
  async execute(input: SearchSpeechInput, context: AgentExecutionContext): Promise<SearchSpeechOutput> {
    context.checkCancellation();

    if (input.assetId) {
      const asset = await getMediaAssetById(context.projectId, input.assetId);
      if (!asset) {
        throw new AgentNotFoundError(`Media asset '${input.assetId}' not found in project '${context.projectId}'.`);
      }

      try {
        const res = await searchAssetSpeech(context.projectId, input.assetId, {
          q: input.query,
          limit: input.limit
        });

        return {
          status: "completed",
          totalMatches: res.totalMatches,
          matches: res.matches.map((m) => ({
            assetId: input.assetId,
            matchedText: m.matchedText,
            start: m.start,
            end: m.end,
            duration: Number((m.end - m.start).toFixed(3)),
            segmentIds: m.segmentIds,
            words: m.words
          }))
        };
      } catch (err) {
        if (err instanceof SearchError) {
          return {
            status: "unavailable",
            totalMatches: 0,
            matches: [],
            message: err.message
          };
        }
        throw err;
      }
    }

    // Project-wide speech search
    try {
      const res = await searchProjectIntelligence(context.projectId, {
        q: input.query,
        limit: input.limit
      });

      return {
        status: "completed",
        totalMatches: res.totalMatches,
        matches: res.matches.map((m) => ({
          assetId: m.assetId,
          matchedText: m.matchedText,
          start: m.start,
          end: m.end,
          duration: Number((m.end - m.start).toFixed(3)),
          segmentIds: m.segmentIds,
          words: m.words
        }))
      };
    } catch (err) {
      if (err instanceof SearchError) {
        return {
          status: "unavailable",
          totalMatches: 0,
          matches: [],
          message: err.message
        };
      }
      throw err;
    }
  }
};
