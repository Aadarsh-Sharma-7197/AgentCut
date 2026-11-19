import type { AgentTool } from "../agent-tools.js";
import type { AgentExecutionContext } from "../agent-context.js";
import { getProjectById } from "../../project.service.js";
import { getMediaAssetsByProject } from "../../media.service.js";
import { getTimelineByProject } from "../../timeline.service.js";
import { AgentNotFoundError, AgentValidationError } from "../agent-errors.js";

export interface ProjectContextToolOutput {
  projectId: string;
  name: string;
  description?: string;
  assetCount: number;
  hasTimeline: boolean;
  createdAt: string;
  updatedAt: string;
}

export const getProjectContextTool: AgentTool<Record<string, never>, ProjectContextToolOutput> = {
  name: "get_project_context",
  description: "Retrieve project identity and metadata, including name, description, timestamps, asset count, and timeline status.",
  validate(input: unknown): Record<string, never> {
    if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
      throw new AgentValidationError("get_project_context expects an empty object or no arguments.");
    }
    return {};
  },
  async execute(_input: Record<string, never>, context: AgentExecutionContext): Promise<ProjectContextToolOutput> {
    context.checkCancellation();
    const project = await getProjectById(context.projectId);
    if (!project) {
      throw new AgentNotFoundError(`Project '${context.projectId}' not found.`);
    }

    const [assets, timeline] = await Promise.all([
      getMediaAssetsByProject(context.projectId),
      getTimelineByProject(context.projectId)
    ]);

    return {
      projectId: project.id,
      name: project.name,
      description: (project as any).description || "",
      assetCount: assets.length,
      hasTimeline: Boolean(timeline),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    };
  }
};
