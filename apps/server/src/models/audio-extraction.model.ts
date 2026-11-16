import { ObjectId } from "mongodb";
import type { AudioExtractionArtifact, AudioProperties, AudioExtractionStatus } from "@agentcut/shared";

export interface AudioExtractionDocument {
  _id: ObjectId;
  projectId: string;
  assetId: string;
  status: AudioExtractionStatus;
  audioProperties?: AudioProperties;
  artifactSize?: number;
  completedAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toAudioExtractionDTO(doc: AudioExtractionDocument): AudioExtractionArtifact {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId,
    assetId: doc.assetId,
    status: doc.status,
    audioProperties: doc.audioProperties,
    artifactSize: doc.artifactSize,
    completedAt: doc.completedAt ? doc.completedAt.toISOString() : undefined,
    error: doc.error,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
}

