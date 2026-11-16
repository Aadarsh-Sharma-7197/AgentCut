import { ObjectId } from "mongodb";
import type {
  SceneDetectionArtifact,
  SceneDetectionStatus,
  SceneDetectionParameters,
  Scene
} from "@agentcut/shared";

export interface SceneDetectionDocument {
  _id: ObjectId;
  projectId: string;
  assetId: string;
  status: SceneDetectionStatus;
  parameters: SceneDetectionParameters;
  scenes: Scene[];
  sceneCount: number;
  videoDuration: number;
  completedAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toSceneDetectionDTO(doc: SceneDetectionDocument): SceneDetectionArtifact {
  const analysisId = doc._id.toHexString();
  const mappedScenes: Scene[] = (doc.scenes || []).map((s) => ({
    id: s.id,
    index: s.index,
    start: s.start,
    end: s.end,
    duration: s.duration,
    representativeTimestamp: s.representativeTimestamp,
    score: s.score,
    frameAvailable: Boolean(s.frameAvailable),
    frameUrl: `/api/projects/${doc.projectId}/media/${doc.assetId}/scenes/analyses/${analysisId}/frames/${s.id}`
  }));

  return {
    id: analysisId,
    projectId: doc.projectId,
    assetId: doc.assetId,
    status: doc.status,
    parameters: doc.parameters,
    scenes: mappedScenes,
    sceneCount: doc.sceneCount ?? mappedScenes.length,
    videoDuration: doc.videoDuration ?? 0,
    completedAt: doc.completedAt ? doc.completedAt.toISOString() : undefined,
    error: doc.error,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
}
