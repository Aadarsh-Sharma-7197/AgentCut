import { ObjectId } from "mongodb";
import type {
  TranscriptionArtifact,
  TranscriptionStatus,
  TranscriptionParameters,
  TranscriptionDevice
} from "@agentcut/shared";

export interface TranscriptionDocument {
  _id: ObjectId;
  projectId: string;
  assetId: string;
  status: TranscriptionStatus;
  parameters: TranscriptionParameters;
  detectedLanguage?: string;
  languageProbability?: number;
  audioDuration?: number;
  segmentCount?: number;
  executionDevice?: TranscriptionDevice;
  computeType?: string;
  engineMetadata?: {
    engine: string;
    version?: string;
  };
  error?: string;
  artifactPath?: string; // Internal filesystem reference, strictly omitted from client DTOs
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function toTranscriptionDTO(doc: TranscriptionDocument): TranscriptionArtifact {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId,
    assetId: doc.assetId,
    status: doc.status,
    parameters: doc.parameters,
    detectedLanguage: doc.detectedLanguage,
    languageProbability: doc.languageProbability,
    audioDuration: doc.audioDuration,
    segmentCount: doc.segmentCount,
    executionDevice: doc.executionDevice,
    computeType: doc.computeType,
    engineMetadata: doc.engineMetadata,
    error: doc.error,
    completedAt: doc.completedAt ? doc.completedAt.toISOString() : undefined,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
}
