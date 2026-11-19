import type { AgentTool } from "../agent-tools.js";
import type { AgentExecutionContext } from "../agent-context.js";
import { getTimelineByProject } from "../../timeline.service.js";
import { getTimelineDuration } from "@agentcut/shared";
import { AgentValidationError } from "../agent-errors.js";

export interface CompactClipInfo {
  id: string;
  assetId: string;
  trackId: string;
  timelineStart: number;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
}

export interface CompactTrackInfo {
  id: string;
  name: string;
  type: string;
  index: number;
  muted: boolean;
  hidden: boolean;
  clipCount: number;
  clips: CompactClipInfo[];
}

export interface GetTimelineOutput {
  exists: boolean;
  timelineId?: string;
  duration?: number;
  trackCount?: number;
  clipCount?: number;
  tracks?: CompactTrackInfo[];
  message?: string;
}

export const getTimelineTool: AgentTool<Record<string, never>, GetTimelineOutput> = {
  name: "get_timeline",
  description: "Retrieve the current persisted timeline for this project, including tracks, clips, and clip timings.",
  validate(input: unknown): Record<string, never> {
    if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
      throw new AgentValidationError("get_timeline expects an empty object or no arguments.");
    }
    return {};
  },
  async execute(_input: Record<string, never>, context: AgentExecutionContext): Promise<GetTimelineOutput> {
    context.checkCancellation();
    const timeline = await getTimelineByProject(context.projectId);
    if (!timeline) {
      return {
        exists: false,
        message: "No timeline created yet for this project."
      };
    }

    let totalClips = 0;
    const tracks: CompactTrackInfo[] = timeline.tracks.map((t: any) => {
      totalClips += t.clips.length;
      return {
        id: t.id,
        name: t.name,
        type: t.type,
        index: t.index,
        muted: t.muted,
        hidden: t.hidden,
        clipCount: t.clips.length,
        clips: t.clips.map((c: any) => ({
          id: c.id,
          assetId: c.assetId,
          trackId: c.trackId,
          timelineStart: c.timelineStart,
          sourceStart: c.sourceStart,
          sourceEnd: c.sourceEnd,
          duration: Number((c.sourceEnd - c.sourceStart).toFixed(3))
        }))
      };
    });

    return {
      exists: true,
      timelineId: timeline.id,
      duration: getTimelineDuration(timeline),
      trackCount: tracks.length,
      clipCount: totalClips,
      tracks
    };
  }
};
