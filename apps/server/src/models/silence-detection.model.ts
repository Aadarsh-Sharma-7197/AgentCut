import { ObjectId } from "mongodb";
import type {
  SilenceDetectionArtifact,
  SilenceDetectionStatus,
  SilenceDetectionParameters,
  SilenceInterval
} from "@agentcut/shared";

export interface SilenceDetectionDocument {
  _id: ObjectId;
  projectId: string;
  assetId: string;
  status: SilenceDetectionStatus;
  parameters: SilenceDetectionParameters;
  intervals: SilenceInterval[];
  totalSilenceDuration: number;
  audioDuration: number;
  completedAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toSilenceDetectionDTO(doc: SilenceDetectionDocument): SilenceDetectionArtifact {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId,
    assetId: doc.assetId,
    status: doc.status,
    parameters: doc.parameters,
    intervals: doc.intervals || [],
    totalSilenceDuration: doc.totalSilenceDuration ?? 0,
    audioDuration: doc.audioDuration ?? 0,
    completedAt: doc.completedAt ? doc.completedAt.toISOString() : undefined,
    error: doc.error,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
}
