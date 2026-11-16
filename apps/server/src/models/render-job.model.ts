import { ObjectId } from "mongodb";
import type {
  RenderJob,
  RenderJobStatus,
  RenderPlan,
  RenderOutputMetadata
} from "@agentcut/shared";

export interface RenderJobDocument {
  _id: ObjectId;
  jobId: string;
  projectId: string;
  timelineId: string;
  status: RenderJobStatus;
  progress: number;
  plan: RenderPlan;
  outputMetadata?: RenderOutputMetadata;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toRenderJobDTO(doc: RenderJobDocument): RenderJob {
  return {
    id: doc.jobId,
    projectId: doc.projectId,
    timelineId: doc.timelineId,
    status: doc.status,
    progress: doc.progress,
    plan: doc.plan,
    outputMetadata: doc.outputMetadata,
    error: doc.error,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
}

